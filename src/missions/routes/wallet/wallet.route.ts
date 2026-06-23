import { FastifyPluginAsync } from 'fastify'
import { prisma } from '../../../db'
import { findMissionForBuyer } from '../../mission-access'
import {
  missionIdParamsSchema,
  MissionRouteOptions,
  WalletView,
} from '../../mission-common'
import { AppError } from '../../../errors/app.error'

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
 */
export const walletRoutes: FastifyPluginAsync<MissionRouteOptions> = async app => {
  // GET /api/missions/:id/wallet — solde + historique du wallet de l'acheteur.
  app.get('/:id/wallet', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }

    // Garde IDOR : 404 si la mission n'existe pas OU si l'appelant n'en est pas
    // l'acheteur (voyageur/tiers) — les deux cas indistinguables.
    const mission = await findMissionForBuyer(prisma, id, req.user.sub)
    if (!mission) throw new AppError('MISSION_NOT_FOUND', 404)

    // Wallet de l'acheteur (= appelant). Absent ⇒ jamais crédité ⇒ wallet vide
    // (200, pas 404 : un solde nul est un état légitime, pas une erreur).
    const wallet = await prisma.wallet.findUnique({
      where: { userId: req.user.sub },
      include: { transactions: { orderBy: { createdAt: 'desc' } } },
    })

    const body: WalletView = wallet
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

    return reply.code(200).send(body)
  })
}
