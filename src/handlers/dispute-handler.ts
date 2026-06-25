import { runAlias, WatchdogExhaustedError } from '@waylo/shared/automation'

export interface DisputeHandlerLogger {
  error(data: Record<string, unknown>, msg: string): void
}

export interface DisputeInput {
  id: string
}

async function resolveDisputeLogic(_dispute: DisputeInput): Promise<void> {
  // Placeholder — connecter à disputeResolutionWorker ou au service métier.
  throw new Error('resolveDisputeLogic: not connected to a dispute worker')
}

export async function handleDisputeResolution(
  dispute: DisputeInput,
  log: DisputeHandlerLogger,
): Promise<void> {
  try {
    await runAlias(
      'dispute-resolve',
      () => resolveDisputeLogic(dispute),
      { idempotencyKey: `dispute:${dispute.id}` },
    )
  } catch (err) {
    if (err instanceof WatchdogExhaustedError) {
      log.error(
        { alias: err.alias, attempts: err.attempts, disputeId: dispute.id },
        'Watchdog exhausted on dispute-resolve',
      )
      throw err
    }
    throw err
  }
}
