import type { PrismaClient } from '../../src/generated/prisma'

/**
 * Purge FK-safe de la base de test `waylo_test` — SOURCE UNIQUE de l'ordre de
 * suppression. Remplace les séquences `deleteMany` recopiées dans chaque suite
 * (anti-dérive : une seule liste à maintenir quand le schéma évolue).
 *
 * Ordre = enfants AVANT parents. Deux FK sont en `RESTRICT` (pas de cascade) et
 * imposent la fin de la chaîne — c'est l'invariant que les purges manuelles
 * oubliaient et qui cassait le `user.deleteMany()` de la suite suivante :
 *
 *   - `WalletTransaction.walletId → Wallet`  (RESTRICT) → walletTransaction AVANT wallet
 *   - `Wallet.userId → User`                 (RESTRICT) → wallet            AVANT user
 *   - `EscrowTransaction.missionId → Mission`(RESTRICT) → escrow            AVANT mission
 *   - `Mission.buyerId/travelerId → User`    (RESTRICT) → mission           AVANT user
 *
 * d'où le chaînage critique : WalletTransaction → Wallet → User.
 * (`WalletTransaction.missionId` et `Review.missionId` sont en CASCADE, mais on
 * les purge explicitement pour ne pas dépendre de l'ordre relatif mission/wallet.)
 */
export async function resetDb(prisma: PrismaClient): Promise<void> {
  // 1. Enfants d'EscrowTransaction (avant escrow).
  await prisma.ledgerEntry.deleteMany()
  await prisma.transferOutbox.deleteMany()

  // 2. Chaîne Wallet — walletTransaction → wallet (wallet purgé AVANT user).
  await prisma.walletTransaction.deleteMany()
  await prisma.wallet.deleteMany()

  // 3. Enfants de Mission (avant mission).
  await prisma.review.deleteMany()
  await prisma.receipt.deleteMany()
  await prisma.substitutionRequest.deleteMany()
  await prisma.issuingAuthorizationLog.deleteMany()
  await prisma.penaltyDebitOutbox.deleteMany()
  await prisma.buyerCompensationOutbox.deleteMany()
  await prisma.escrowTransaction.deleteMany()

  // 4. Enfant de User hors mission (avant user).
  await prisma.adminAuditLog.deleteMany()

  // 5. Tables sans FK.
  await prisma.processedStripeEvent.deleteMany()
  await prisma.rateLimit.deleteMany()

  // 6. Racines — mission puis user (en dernier).
  await prisma.mission.deleteMany()
  await prisma.user.deleteMany()
}
