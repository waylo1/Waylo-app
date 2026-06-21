import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Canal webhook prod (Slack-compatible). Posés AVANT tout import de src/alerts.ts :
 * l'URL du webhook ET le chemin du sink critique sont lus au chargement du module.
 * Ce test ne touche PAS la base — il valide uniquement le routage réseau best-effort.
 */
const CRITICAL_FILE = join(tmpdir(), `waylo-test-webhook-${process.pid}.ndjson`)
process.env.WAYLO_CRITICAL_ALERTS_FILE = CRITICAL_FILE
process.env.WAYLO_ALERT_WEBHOOK_URL = 'https://hooks.slack.test/services/T000/B000/XXX'

describe('Canal webhook d’alerte (Slack-compatible)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('ok', { status: 200 }))),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(CRITICAL_FILE, { force: true })
  })

  afterAll(() => {
    rmSync(CRITICAL_FILE, { force: true })
  })

  it('buildWebhookPayload : payload Slack-compatible ({ text } + champs structurés)', async () => {
    const { buildWebhookPayload, toOpsAlert } = await import('./alerts')
    const payload = buildWebhookPayload(
      toOpsAlert({
        code: 'LEDGER_INVARIANT_BROKEN',
        message: 'corruption comptable',
        details: { escrowId: 'esc_1' },
      }),
    )
    expect(payload.text).toContain('CRITICAL')
    expect(payload.text).toContain('LEDGER_INVARIANT_BROKEN')
    expect(payload.text).toContain('corruption comptable')
    expect(payload).toMatchObject({
      severity: 'critical',
      code: 'LEDGER_INVARIANT_BROKEN',
      details: { escrowId: 'esc_1' },
    })
  })

  it('critical → POST webhook (URL + corps JSON Slack) ET persistance NDJSON', async () => {
    const { safeEmit } = await import('./alerts')
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>

    safeEmit(undefined, {
      code: 'TRANSFER_ABANDONED',
      message: 'transfert terminal',
      details: { escrowId: 'esc_2' },
    })

    // L'appel fetch est synchrone (seule la réponse est asynchrone) → assertable de suite.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://hooks.slack.test/services/T000/B000/XXX')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ code: 'TRANSFER_ABANDONED', severity: 'critical' })
    expect(body.text).toContain('TRANSFER_ABANDONED')
  })

  it('warn → PAS de webhook (canal stderr seul)', async () => {
    const { safeEmit } = await import('./alerts')
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>

    safeEmit(undefined, { code: 'PAYOUT_NOT_SETTLED', message: 'latence', details: {} })

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('webhook qui rejette : ne propage JAMAIS (chemin webhook Stripe protégé)', async () => {
    const { safeEmit } = await import('./alerts')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('slack down'))),
    )

    // Ne doit pas throw malgré le rejet réseau.
    expect(() =>
      safeEmit(undefined, {
        code: 'TRAVELER_ACCOUNT_MISSING',
        message: 'fonds bloqués',
        details: {},
      }),
    ).not.toThrow()
  })
})
