/**
 * Client RFC 3161 minimal — zéro dépendance (crypto + fetch natifs Node ≥ 20).
 *
 * Construit la TimeStampReq en DER brut (le sous-ensemble requis est trivial),
 * poste en binaire, valide la TimeStampResp, et bascule sur le fournisseur
 * suivant de la chaîne (cf. tsa.config.ts) en cas d'échec.
 *
 * Validations appliquées avant d'accepter un jeton :
 *   - statut PKI `granted` (0) ou `grantedWithMods` (1) ;
 *   - présence d'un TimeStampToken après le PKIStatusInfo ;
 *   - echo de notre empreinte SHA-256 dans le jeton (messageImprint) ;
 *   - echo de notre nonce (anti-rejeu d'une réponse antérieure).
 * La vérification cryptographique complète de la signature CMS reste possible
 * hors-ligne sur le DER stocké (`openssl ts -verify`).
 */

import { createHash, randomBytes } from 'node:crypto'
import { getTsaProviders, type TsaProvider } from './tsa.config'

export class TsaError extends Error {
  readonly code = 'TSA_ALL_PROVIDERS_FAILED'
  constructor(readonly attempts: readonly string[]) {
    super(`TSA_ALL_PROVIDERS_FAILED: ${attempts.join(' | ')}`)
    this.name = 'TsaError'
  }
}

export interface TsaTimestamp {
  /** Fournisseur ayant délivré le jeton (traçabilité de la chaîne de preuves). */
  providerId: string
  /** TimeStampResp DER complet — à stocker tel quel, vérifiable offline. */
  responseDer: Buffer
  /** Empreinte SHA-256 (hex) du message horodaté. */
  messageImprintHex: string
}

// ── Encodage DER (sous-ensemble TimeStampReq) ──────────────────────────────

/** OID 2.16.840.1.101.3.4.2.1 (SHA-256), pré-encodé. */
const SHA256_OID_DER = Buffer.from([0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01])
const DER_NULL = Buffer.from([0x05, 0x00])
/** certReq BOOLEAN TRUE — exiger le certificat du signataire dans le jeton. */
const CERT_REQ_TRUE = Buffer.from([0x01, 0x01, 0xff])

function derLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len])
  const bytes: number[] = []
  let n = len
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n = Math.floor(n / 256)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function der(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

/** INTEGER DER positif : préfixe 0x00 si le bit de poids fort est levé. */
function derPositiveInteger(bytes: Buffer): Buffer {
  const positive = bytes.length > 0 && (bytes[0] & 0x80) !== 0 ? Buffer.concat([Buffer.from([0x00]), bytes]) : bytes
  return der(0x02, positive)
}

/**
 * TimeStampReq ::= SEQUENCE { version 1, messageImprint, nonce, certReq TRUE }
 * (reqPolicy et extensions omis — optionnels et inutiles ici.)
 */
export function buildTimeStampReq(sha256Digest: Buffer, nonce: Buffer): Buffer {
  if (sha256Digest.length !== 32) throw new Error('TSA_DIGEST_MUST_BE_SHA256')
  const version = der(0x02, Buffer.from([0x01]))
  const algorithmId = der(0x30, Buffer.concat([SHA256_OID_DER, DER_NULL]))
  const messageImprint = der(0x30, Buffer.concat([algorithmId, der(0x04, sha256Digest)]))
  return der(0x30, Buffer.concat([version, messageImprint, derPositiveInteger(nonce), CERT_REQ_TRUE]))
}

// ── Décodage DER (sous-ensemble TimeStampResp) ─────────────────────────────

interface DerHeader {
  tag: number
  length: number
  contentStart: number
}

function readDerHeader(buf: Buffer, offset: number): DerHeader {
  if (offset + 2 > buf.length) throw new Error('TSA_RESPONSE_TRUNCATED')
  const tag = buf[offset]
  const first = buf[offset + 1]
  if ((first & 0x80) === 0) return { tag, length: first, contentStart: offset + 2 }
  const numBytes = first & 0x7f
  if (numBytes === 0 || numBytes > 4 || offset + 2 + numBytes > buf.length) {
    throw new Error('TSA_RESPONSE_MALFORMED')
  }
  let length = 0
  for (let i = 0; i < numBytes; i++) length = length * 256 + buf[offset + 2 + i]
  return { tag, length, contentStart: offset + 2 + numBytes }
}

/**
 * TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken OPTIONAL }
 * PKIStatusInfo ::= SEQUENCE { status INTEGER, ... }
 */
export function parseTimeStampResp(responseDer: Buffer): { status: number; hasToken: boolean } {
  const outer = readDerHeader(responseDer, 0)
  if (outer.tag !== 0x30) throw new Error('TSA_RESPONSE_MALFORMED')
  const statusInfo = readDerHeader(responseDer, outer.contentStart)
  if (statusInfo.tag !== 0x30) throw new Error('TSA_RESPONSE_MALFORMED')
  const statusInt = readDerHeader(responseDer, statusInfo.contentStart)
  if (statusInt.tag !== 0x02 || statusInt.length < 1) throw new Error('TSA_RESPONSE_MALFORMED')
  const status = responseDer[statusInt.contentStart]
  const statusInfoEnd = statusInfo.contentStart + statusInfo.length
  const outerEnd = outer.contentStart + outer.length
  return { status, hasToken: outerEnd > statusInfoEnd }
}

// ── Requête avec failover ──────────────────────────────────────────────────

/** PKIStatus acceptés : 0 = granted, 1 = grantedWithMods. */
const GRANTED_STATUSES: readonly number[] = [0, 1]

export interface RequestTimestampOptions {
  /** Chaîne de fournisseurs (défaut : tsa.config.ts / TSA_ENDPOINTS). */
  providers?: readonly TsaProvider[]
  /** Injectable pour les tests de failover — défaut : fetch global Node. */
  fetchImpl?: typeof fetch
}

async function postTimestampQuery(provider: TsaProvider, request: Buffer, fetchImpl: typeof fetch): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), provider.timeoutMs)
  try {
    const response = await fetchImpl(provider.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query' },
      body: new Uint8Array(request),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`TSA_HTTP_${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}

function validateResponse(responseDer: Buffer, digest: Buffer, nonce: Buffer): void {
  const { status, hasToken } = parseTimeStampResp(responseDer)
  if (!GRANTED_STATUSES.includes(status)) throw new Error(`TSA_STATUS_REJECTED_${status}`)
  if (!hasToken) throw new Error('TSA_TOKEN_MISSING')
  if (!responseDer.includes(digest)) throw new Error('TSA_IMPRINT_MISMATCH')
  const positiveNonce = (nonce[0] & 0x80) !== 0 ? Buffer.concat([Buffer.from([0x00]), nonce]) : nonce
  if (!responseDer.includes(positiveNonce)) throw new Error('TSA_NONCE_MISMATCH')
}

/**
 * Horodate un message (preuve QPP scellée) via la chaîne TSA avec failover.
 * Essaie chaque fournisseur dans l'ordre ; lève TsaError si tous échouent —
 * la chaîne de preuves ne doit jamais recevoir de jeton non validé.
 */
export async function requestTimestamp(
  message: Buffer | string,
  options: RequestTimestampOptions = {},
): Promise<TsaTimestamp> {
  const providers = options.providers ?? getTsaProviders()
  const fetchImpl = options.fetchImpl ?? fetch
  if (providers.length === 0) throw new TsaError(['NO_PROVIDERS_CONFIGURED'])

  const digest = createHash('sha256').update(message).digest()
  // Nonce crypto-secure (jamais Math.random — cf. audit AUDIT-00 RNG).
  const nonce = randomBytes(16)
  const request = buildTimeStampReq(digest, nonce)

  const attempts: string[] = []
  for (const provider of providers) {
    try {
      const responseDer = await postTimestampQuery(provider, request, fetchImpl)
      validateResponse(responseDer, digest, nonce)
      return { providerId: provider.id, responseDer, messageImprintHex: digest.toString('hex') }
    } catch (error) {
      attempts.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new TsaError(attempts)
}
