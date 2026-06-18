import { prisma } from '../db'

/**
 * Worker de compensation acheteur — traitement asynchrone des intentions de restitution
 * 120% (arbitrage de fraude, ledger `BUYER_REFUND_COMPENSATION`). Outbox PENDING → SETTLED|FAILED.
 *
 * Stratégie : créditer le Wallet interne acheteur (S18, modèle « Drive ») ; le payout
 * vers un compte bancaire externe sera porté par une future étape (S21+). Backoff
 * exponentiel : ré-éligible après 2^attempts minutes. Arrêt définitif après 4 tentatives.
 */

export async function processBuyerCompensations() {
  const pendings = await prisma.buyerCompensationOutbox.findMany({
    where: { status: 'PENDING' },
    take: 10,
  })

  for (const job of pendings) {
    try {
      await prisma.$transaction(async tx => {
        // Claim atomique anti-TOCTOU (miroir penalty.worker / transfer-worker) :
        // transition conditionnelle PENDING → SETTLED. count=0 ⇒ la ligne a déjà
        // été réclamée par un autre tick / une autre instance Fly → on NE crédite
        // PAS (return : rollback implicite, aucun double-crédit possible).
        const claim = await tx.buyerCompensationOutbox.updateMany({
          where: { id: job.id, status: 'PENDING' },
          data: { status: 'SETTLED', attempts: job.attempts + 1 },
        })
        if (claim.count !== 1) return

        // Créditer le Wallet interne de l'acheteur (créer si absent). Toute
        // exception ici annule aussi le claim (la ligne repasse PENDING).
        await tx.wallet.upsert({
          where: { userId: job.buyerId },
          create: { userId: job.buyerId, balanceCents: job.amountCents },
          update: { balanceCents: { increment: job.amountCents } },
        })
      })
    } catch (error) {
      // Backoff exponentiel : ré-éligible après 2^attempts min ; arrêt à 4 tentatives.
      const message = error instanceof Error ? error.message : String(error)
      const nextAttempt = job.attempts + 1
      await prisma.buyerCompensationOutbox.update({
        where: { id: job.id },
        data: {
          status: nextAttempt >= 4 ? 'FAILED' : 'PENDING',
          attempts: nextAttempt,
          lastError: message,
        },
      })
    }
  }
}

/**
 * Boucle cron explicite (~1 min) — miroir de `startPenaltyWorkerLoop`. Le `.catch`
 * de niveau tick garantit qu'une exception du batch (ex. DB injoignable au `findMany`)
 * n'effondre PAS le process scheduler : on log et le prochain tick reprend.
 */
export function startBuyerCompensationWorkerLoop(
  intervalMs = 60_000,
  log: { error(details: Record<string, unknown>, message?: string): void } = console,
): NodeJS.Timeout {
  return setInterval(() => {
    void processBuyerCompensations().catch(err =>
      log.error({ err: String(err) }, 'buyer compensation worker tick failed'),
    )
  }, intervalMs)
}
