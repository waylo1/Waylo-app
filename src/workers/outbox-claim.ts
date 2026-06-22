import type { PrismaClient, Prisma } from '../generated/prisma'

/** Logger structuré (info + error) — compatible pino (Fastify) et console. */
export interface OutboxWorkerLogger {
  info(data: Record<string, unknown>, msg: string): void
  error(data: Record<string, unknown>, msg: string): void
}

/**
 * Claim ATOMIQUE d'un lot d'items outbox éligibles en une seule transaction
 * (`FOR UPDATE SKIP LOCKED`). Incrémente `attempts` AVANT tout appel externe
 * (backoff naturel au crash). Chaque item est traité AU PLUS UNE FOIS par tick :
 * un échec qui repasse l'item PENDING ne sera ré-essayé qu'au prochain tick.
 *
 * Callbacks (propres à chaque worker) :
 * - `selectIds`      — SELECT … FOR UPDATE SKIP LOCKED (table + filtres du worker)
 * - `updateAttempts` — updateMany({ attempts: { increment: 1 } }) dans la même tx
 * - `fetchClaimed`   — projection finale (joins, champs spécifiques) dans la même tx
 *
 * Garanties identiques à celles des anciens `claimRefundBatch` / `claimPenaltyBatch` :
 * même tx atomique, même ordre d'opérations, même comportement au crash. La signature
 * de la requête SQL (FOR UPDATE SKIP LOCKED) reste inchangée — seul l'enrobage
 * transactionnel est mutualisé.
 *
 * Note : `penalty.worker` utilise un modèle différent (SUBMITTED + backoff 2^n +
 * stale recovery), incompatible avec ce pattern. Il conserve son propre `claimNext`.
 */
export async function claimOutboxBatch<T>(
  prisma: PrismaClient,
  opts: {
    selectIds: (tx: Prisma.TransactionClient) => Promise<Array<{ id: string }>>
    updateAttempts: (tx: Prisma.TransactionClient, ids: string[]) => Promise<unknown>
    fetchClaimed: (tx: Prisma.TransactionClient, ids: string[]) => Promise<T[]>
  },
): Promise<T[]> {
  return prisma.$transaction(async tx => {
    const rows = await opts.selectIds(tx)
    if (rows.length === 0) return []
    const ids = rows.map(r => r.id)
    await opts.updateAttempts(tx, ids)
    return opts.fetchClaimed(tx, ids)
  })
}
