import { runAlias, WatchdogExhaustedError } from '@waylo/shared/automation'

export interface WebhookHandlerLogger {
  error(data: Record<string, unknown>, msg: string): void
}

export interface StripeEventInput {
  id: string
}

async function processWebhookLogic(_event: StripeEventInput): Promise<void> {
  // Placeholder — connecter à webhook.route.ts ou au handler Stripe existant.
  throw new Error('processWebhookLogic: not connected to a webhook handler')
}

export async function handleWebhookWithRetry(
  event: StripeEventInput,
  log: WebhookHandlerLogger,
): Promise<void> {
  try {
    await runAlias(
      'webhook-retry',
      () => processWebhookLogic(event),
      { idempotencyKey: `webhook:${event.id}` },
    )
  } catch (err) {
    if (err instanceof WatchdogExhaustedError) {
      log.error(
        { alias: err.alias, attempts: err.attempts, webhookEventId: event.id },
        'Watchdog exhausted on webhook-retry',
      )
      throw err
    }
    throw err
  }
}
