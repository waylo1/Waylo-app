/**
 * Tests du service d'horodatage RFC 3161 (chaîne de preuves QPP).
 *
 * Unitaires : encodage DER, parsing de réponse, failover (fetch injecté).
 * Intégration : horodatage réel via la chaîne de fournisseurs par défaut —
 * sauté en CI (CI=true) pour garder la suite hermétique ; exécuté en local.
 */

import { describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { logger } from '../lib/logger'
import { buildTimeStampReq, parseTimeStampResp, requestTimestamp, TsaError } from './tsa.client'
import { DEFAULT_TSA_TIMEOUT_MS, ESTIMATED_COST_PER_TOKEN_CENTS, getTsaProviders } from './tsa.config'
import type { TsaProvider } from './tsa.config'

const SHA256_OID_DER = Buffer.from([0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01])

/** TimeStampResp minimale : SEQUENCE { SEQUENCE { INTEGER status }, tokenBytes }. */
function craftResponse(status: number, tokenBytes: Buffer): Buffer {
  const statusInfo = Buffer.from([0x30, 0x03, 0x02, 0x01, status])
  const content = Buffer.concat([statusInfo, tokenBytes])
  if (content.length >= 0x80) throw new Error('craftResponse: utiliser un token < 123 octets')
  return Buffer.concat([Buffer.from([0x30, content.length]), content])
}

/** fetch factice : une réponse (ou erreur) par appel, dans l'ordre. */
function fakeFetch(handlers: Array<(body: Uint8Array) => Response>): typeof fetch {
  let call = 0
  return async (_input, init) => {
    const handler = handlers[call++]
    if (!handler) throw new Error('fakeFetch: appel inattendu')
    return handler(init?.body as Uint8Array)
  }
}

const PROVIDERS: readonly TsaProvider[] = [
  { id: 'primary', url: 'https://tsa-primary.test', timeoutMs: 1_000, estimatedCostCents: 5 },
  { id: 'secondary', url: 'https://tsa-secondary.test', timeoutMs: 1_000, estimatedCostCents: 7 },
]

describe('tsa.config — chaîne de fournisseurs', () => {
  it('expose 3 fournisseurs par défaut, Sectigo en tête, jamais FreeTSA', () => {
    const providers = getTsaProviders({})
    expect(providers.map((p) => p.id)).toEqual(['sectigo', 'certum', 'digicert'])
    expect(providers.every((p) => p.timeoutMs === DEFAULT_TSA_TIMEOUT_MS)).toBe(true)
    expect(providers.some((p) => p.url.includes('freetsa'))).toBe(false)
    // Endpoints publics : coût marginal nul (cf. docs/tsa-economics.md).
    expect(providers.every((p) => p.estimatedCostCents === 0)).toBe(true)
  })

  it('TSA_ENDPOINTS surcharge la chaîne en conservant l’ordre de priorité', () => {
    const providers = getTsaProviders({
      TSA_ENDPOINTS: 'https://tsa.example.eu/rfc3161, http://backup.example.com',
    })
    expect(providers.map((p) => p.id)).toEqual(['tsa.example.eu', 'backup.example.com'])
    expect(providers[0].url).toBe('https://tsa.example.eu/rfc3161')
    // Endpoint injecté par env = présumé QTSP sous contrat → provision de coût.
    expect(providers.every((p) => p.estimatedCostCents === ESTIMATED_COST_PER_TOKEN_CENTS)).toBe(true)
  })

  it('rejette une surcharge invalide (URL malformée ou protocole non HTTP)', () => {
    expect(() => getTsaProviders({ TSA_ENDPOINTS: 'pas-une-url' })).toThrow('TSA_ENDPOINTS_INVALID_URL')
    expect(() => getTsaProviders({ TSA_ENDPOINTS: 'ftp://tsa.example.com' })).toThrow('TSA_ENDPOINTS_INVALID_URL')
  })
})

describe('tsa.client — encodage TimeStampReq', () => {
  it('produit une SEQUENCE DER contenant OID SHA-256, empreinte et certReq TRUE', () => {
    const digest = createHash('sha256').update('preuve-qpp').digest()
    const nonce = randomBytes(16)
    const request = buildTimeStampReq(digest, nonce)

    expect(request[0]).toBe(0x30)
    expect(request.includes(SHA256_OID_DER)).toBe(true)
    expect(request.includes(digest)).toBe(true)
    expect(request.subarray(request.length - 3)).toEqual(Buffer.from([0x01, 0x01, 0xff]))
  })

  it('refuse une empreinte qui n’est pas du SHA-256 (32 octets)', () => {
    expect(() => buildTimeStampReq(Buffer.alloc(20), randomBytes(16))).toThrow('TSA_DIGEST_MUST_BE_SHA256')
  })
})

describe('tsa.client — parsing TimeStampResp', () => {
  it('lit le statut granted et détecte la présence du jeton', () => {
    const parsed = parseTimeStampResp(craftResponse(0, Buffer.from([0x30, 0x02, 0xca, 0xfe])))
    expect(parsed).toEqual({ status: 0, hasToken: true })
  })

  it('lit un rejet (status 2) sans jeton', () => {
    const parsed = parseTimeStampResp(craftResponse(2, Buffer.alloc(0)))
    expect(parsed).toEqual({ status: 2, hasToken: false })
  })

  it('rejette un DER tronqué ou malformé', () => {
    expect(() => parseTimeStampResp(Buffer.from([0x30]))).toThrow('TSA_RESPONSE_TRUNCATED')
    expect(() => parseTimeStampResp(Buffer.from([0x04, 0x02, 0x00, 0x00]))).toThrow('TSA_RESPONSE_MALFORMED')
  })
})

describe('tsa.client — failover', () => {
  it('bascule sur le fournisseur secondaire quand le primaire est en panne', async () => {
    const fetchImpl = fakeFetch([
      () => {
        throw new Error('ECONNREFUSED')
      },
      // Le secondaire répond granted en réutilisant la requête comme corps de
      // jeton : elle contient l'empreinte et le nonce, donc la validation passe.
      (body) => new Response(craftResponse(0, Buffer.from(body)), { status: 200 }),
    ])

    const stamp = await requestTimestamp('preuve-qpp-failover', { providers: PROVIDERS, fetchImpl })
    expect(stamp.providerId).toBe('secondary')
    expect(stamp.responseDer.length).toBeGreaterThan(0)
    expect(stamp.messageImprintHex).toBe(createHash('sha256').update('preuve-qpp-failover').digest('hex'))
    expect(stamp.estimatedCostCents).toBe(7)
  })

  it('logue le coût de l’opération avec le fournisseur utilisé', async () => {
    const infoSpy = vi.spyOn(logger, 'info')
    const fetchImpl = fakeFetch([(body) => new Response(craftResponse(0, Buffer.from(body)), { status: 200 })])

    await requestTimestamp('preuve-qpp-cout', { providers: PROVIDERS, fetchImpl })

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'tsa.timestamp.granted',
        providerId: 'primary',
        estimatedCostCents: 5,
        durationMs: expect.any(Number),
      }),
      'TSA timestamp granted',
    )
    infoSpy.mockRestore()
  })

  it('refuse un jeton dont l’empreinte ne correspond pas (pas de bascule aveugle)', async () => {
    const foreignToken = craftResponse(0, buildTimeStampReq(createHash('sha256').update('autre-message').digest(), randomBytes(16)))
    const fetchImpl = fakeFetch([
      () => new Response(foreignToken, { status: 200 }),
      () => new Response(foreignToken, { status: 200 }),
    ])

    await expect(requestTimestamp('preuve-qpp', { providers: PROVIDERS, fetchImpl })).rejects.toThrow(
      'TSA_IMPRINT_MISMATCH',
    )
  })

  it('lève TsaError avec le détail de chaque tentative si toute la chaîne échoue', async () => {
    const fetchImpl = fakeFetch([
      () => new Response(null, { status: 503 }),
      (body) => new Response(craftResponse(2, Buffer.from(body)), { status: 200 }),
    ])

    const failure = await requestTimestamp('preuve-qpp', { providers: PROVIDERS, fetchImpl }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(TsaError)
    const tsaError = failure as TsaError
    expect(tsaError.code).toBe('TSA_ALL_PROVIDERS_FAILED')
    expect(tsaError.attempts).toEqual(['primary: TSA_HTTP_503', 'secondary: TSA_STATUS_REJECTED_2'])
  })
})

describe('tsa.client — intégration réelle (sautée en CI)', () => {
  it.skipIf(process.env.CI === 'true')(
    'obtient un horodatage granted via la chaîne de fournisseurs par défaut',
    async () => {
      const stamp = await requestTimestamp(`waylo-qpp-live-${randomBytes(8).toString('hex')}`)
      expect(['sectigo', 'certum', 'digicert']).toContain(stamp.providerId)
      expect(parseTimeStampResp(stamp.responseDer)).toEqual({ status: 0, hasToken: true })
    },
    45_000,
  )
})
