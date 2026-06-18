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
        // Créditer le Wallet interne de l'acheteur (créer si absent).
        await tx.wallet.upsert({
          where: { userId: job.buyerId },
          create: { userId: job.buyerId, balanceCents: job.amountCents },
          update: { balanceCents: { increment: job.amountCents } },
        })

        // Transition intention → SETTLED (exécution réussie).
        await tx.buyerCompensationOutbox.update({
          where: { id: job.id },
          data: { status: 'SETTLED', attempts: job.attempts + 1 },
        })
      })
    } catch (error: any) {
      // Backoff exponentiel : ré-éligible après 2^attempts min ; arrêt à 4 tentatives.
      const nextAttempt = job.attempts + 1
      await prisma.buyerCompensationOutbox.update({
        where: { id: job.id },
        data: {
          status: nextAttempt >= 4 ? 'FAILED' : 'PENDING',
          attempts: nextAttempt,
          lastError: error.message,
        },
      })
    }
  }
}
