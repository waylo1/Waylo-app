import { FastifyPluginAsync } from 'fastify'
import { prisma } from '../../../db'
import { findMissionForBuyer } from '../../mission-access'
import {
  missionIdParamsSchema,
  MissionRouteOptions,
  WalletView,
} from '../../mission-common'
import { AppError } from '../../../errors/app.error'
import { withRlsContext } from '../../../lib/rls-context'
import { KycStatus } from '../../../generated/prisma'

/**
 * Domaine WALLET — solde interne acheteur (modèle « Drive », S18) + historique.
 *
 * Le Wallet est une ressource user-level (`Wallet.userId @unique`) ; il est
 * alimenté par le reliquat de substitution à la capture (webhook) et par la
 * compensation de fraude (worker). Aucune écriture financière ici : lecture
 * seule, donc pas de `$transaction` ni d'appel Stripe.
 *
 * La mission de l'URL sert de VÉHICULE D'AUTORISATION : seul l'acheteur de cette
 * mission peut consulter SON wallet — `findMissionForBuyer` → 404 masquant pour
 * un voyageur/tiers (invariant IDOR du module, identique aux routes sœurs).
 *
 * RLS « bancaire » (validé 2026-06-30) : la policy `wallet_select` exige
 * `app.is_certified = 'on'` EN PLUS de l'identité. Un appelant authentifié mais
 * non-KYC verrait sa ligne Wallet RENDUE INVISIBLE par la RLS — indistinguable
 * d'un wallet jamais crédité (`findUnique` → null). Pour ne pas mentir (« solde
 * 0 ») à un utilisateur non-certifié, la garde KYC est vérifiée EXPLICITEMENT
 * ici, avant la lecture, avec un code d'erreur dédié.
 */
export const walletRoutes: FastifyPluginAsync<MissionRouteOptions> = async app => {
  // GET /api/missions/:id/wallet — solde + historique du wallet de l'acheteur.
  app.get('/:id/wallet', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }

    // KYC requis pour le Wallet (niveau bancaire) — vérifié AVANT la lecture
    // RLS pour distinguer « non-certifié » de « wallet vide ».
    const caller = await prisma.user.findUnique({
      where: { id: req.user.sub },
      select: { kycStatus: true },
    })
    const isCertified = caller?.kycStatus === KycStatus.VERIFIED
    if (!isCertified) throw new AppError('KYC_REQUIRED', 403)

    const body = await withRlsContext(
      { userId: req.user.sub, isCertified, flagKey: 'rls.wallets', readOnly: true },
      async tx => {
        // Garde IDOR : 404 si la mission n'existe pas OU si l'appelant n'en est pas
        // l'acheteur (voyageur/tiers) — les deux cas indistinguables.
        const mission = await findMissionForBuyer(tx, id, req.user.sub)
        if (!mission) throw new AppError('MISSION_NOT_FOUND', 404)

        // Wallet de l'acheteur (= appelant). Absent ⇒ jamais crédité ⇒ wallet vide
        // (200, pas 404 : un solde nul est un état légitime, pas une erreur).
        const wallet = await tx.wallet.findUnique({
          where: { userId: req.user.sub },
          include: { transactions: { orderBy: { createdAt: 'desc' } } },
        })

        const view: WalletView = wallet
          ? {
              balanceCents: wallet.balanceCents,
              transactions: wallet.transactions.map(t => ({
                id: t.id,
                missionId: t.missionId,
                amountCents: t.amountCents,
                reason: t.reason,
                createdAt: t.createdAt,
              })),
            }
          : { balanceCents: 0, transactions: [] }
        return view
      },
    )

    return reply.code(200).send(body)
  })
}
