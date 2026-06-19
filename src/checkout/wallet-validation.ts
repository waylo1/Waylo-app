import { prisma } from '../db'

/**
 * Validation de financement au checkout (Sprint 19) — garde « capacité acheteur ».
 *
 * Au moment de valider une commande, on vérifie que l'acheteur dispose d'une
 * capacité de paiement suffisante pour couvrir une éventuelle substitution
 * « Drive » : l'autorisation Stripe (hold carte) CUMULÉE au solde du Wallet
 * interne (S18) doit atteindre 120% du prix total de la mission. En dessous, la
 * commande est BLOQUÉE (INSUFFICIENT_FUNDS_FOR_MISSION) avant tout engagement.
 *
 * Argent : centimes Int partout (jamais Float). Le seuil 120% est calculé en
 * Math.floor — miroir exact de substitutionCeilingCents (mission.route), mais
 * appliqué au TOTAL (budget + commission), pas au seul budget.
 *
 * Lecture seule en DB (mission + wallet acheteur) ; erreurs typées (code
 * SNAKE_CASE), miroir de EscrowCaptureError.
 */
export class CheckoutValidationError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CheckoutValidationError'
  }
}

/**
 * Capacité requise = 120% du prix total mission, centimes Int strict (Math.floor,
 * jamais Float). budgetCents + commissionCents = prix total à la charge de l'acheteur.
 */
export const requiredCapacityCents = (missionTotalCents: number): number =>
  Math.floor((missionTotalCents * 12) / 10)

export interface ValidateMissionFundingArgs {
  missionId: string
  /** Montant autorisé côté Stripe (hold carte acheteur), centimes Int ≥ 0. */
  stripeAuthorizationCents: number
}

export interface MissionFundingCapacity {
  missionTotalCents: number
  requiredCapacityCents: number
  stripeAuthorizationCents: number
  walletBalanceCents: number
  totalCapacityCents: number
}

/**
 * Vérifie qu'(autorisation Stripe + solde Wallet acheteur) ≥ 120% du prix total
 * de la mission. Résout avec le détail de la capacité si OK ; rejette avec
 * CheckoutValidationError('INSUFFICIENT_FUNDS_FOR_MISSION') sinon.
 *
 * MISSION_NOT_FOUND si la mission n'existe pas. INVALID_AUTHORIZATION_AMOUNT si
 * l'autorisation n'est pas un entier de centimes ≥ 0 (anti-Float, anti-négatif).
 */
export async function validateMissionFunding(
  args: ValidateMissionFundingArgs,
): Promise<MissionFundingCapacity> {
  if (!Number.isInteger(args.stripeAuthorizationCents) || args.stripeAuthorizationCents < 0) {
    throw new CheckoutValidationError('INVALID_AUTHORIZATION_AMOUNT')
  }

  // Anti-TOCTOU (VULN #3) : le solde Wallet est une ressource PARTAGÉE entre toutes
  // les missions d'un acheteur. Sans sérialisation, deux financements concurrents
  // lisent le même solde et passent tous deux la garde de capacité (course de
  // lecture-snapshot). On exécute donc le contrôle dans UNE transaction et on prend
  // un verrou consultatif transactionnel par acheteur (pg_advisory_xact_lock) AVANT
  // de lire le Wallet : les contrôles concurrents d'un même acheteur s'exécutent en
  // série, chacun voyant l'état committé par le précédent. Le verrou (clé dérivée du
  // buyerId, indépendant de l'existence d'une ligne Wallet) est relâché au commit.
  //
  // NB : ferme la course de lecture ; la prévention complète du double-engagement du
  // reliquat Wallet exigerait une réservation persistée du solde au financement
  // (déférée — le solde Wallet n'est pas encore dépensable, S18).
  return prisma.$transaction(async tx => {
    const mission = await tx.mission.findUnique({
      where: { id: args.missionId },
      select: { buyerId: true, budgetCents: true, commissionCents: true },
    })
    if (!mission) throw new CheckoutValidationError('MISSION_NOT_FOUND')

    // $executeRaw (et non $queryRaw) : pg_advisory_xact_lock renvoie `void`, non
    // désérialisable en colonne — executeRaw n'attend qu'un nombre de lignes.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${mission.buyerId}))`

    // Solde du Wallet interne acheteur (S18). Pas de wallet ouvert ⇒ 0 (jamais négatif).
    const wallet = await tx.wallet.findUnique({
      where: { userId: mission.buyerId },
      select: { balanceCents: true },
    })
    const walletBalanceCents = wallet?.balanceCents ?? 0

    const missionTotalCents = mission.budgetCents + mission.commissionCents
    const required = requiredCapacityCents(missionTotalCents)
    const totalCapacityCents = args.stripeAuthorizationCents + walletBalanceCents

    if (totalCapacityCents < required) {
      throw new CheckoutValidationError('INSUFFICIENT_FUNDS_FOR_MISSION')
    }

    return {
      missionTotalCents,
      requiredCapacityCents: required,
      stripeAuthorizationCents: args.stripeAuthorizationCents,
      walletBalanceCents,
      totalCapacityCents,
    }
  })
}
