import { Prisma, EscrowStatus } from '../../generated/prisma'
import type { PrismaClient } from '../../generated/prisma'

/**
 * Garde d'immutabilité des escrows — défense en profondeur (OWASP A04).
 *
 * L'audit a montré que l'immutabilité reposait UNIQUEMENT sur la discipline des
 * appelants (chaque `updateMany` doit filtrer `status: HELD`). Cette extension
 * fournit le garde-fou manquant côté client : toute tentative de mutation
 * (`update` / `updateMany` / `upsert`) ciblant un escrow déjà en état TERMINAL
 * est rejetée par exception.
 *
 * `create` (financement légitime) et `delete` (purge des tests) ne sont PAS
 * interceptés.
 */

/** États terminaux : un escrow qui les atteint ne doit plus jamais être muté. */
const IMMUTABLE_STATUSES: readonly EscrowStatus[] = [
  EscrowStatus.RELEASED,
  EscrowStatus.REFUNDED,
  EscrowStatus.CANCELLED,
]

/** Levée sur toute mutation d'un escrow en état terminal. */
export class EscrowImmutableError extends Error {
  constructor(statuses: EscrowStatus[]) {
    super(
      `ESCROW_IMMUTABLE: mise à jour interdite d'un escrow en état terminal ` +
        `(${[...new Set(statuses)].join(', ')})`,
    )
    this.name = 'EscrowImmutableError'
  }
}

/** Surface minimale de lecture — accepte le client de base (non étendu). */
type EscrowReader = Pick<PrismaClient, 'escrowTransaction'>

function ensureMutable(rows: { status: EscrowStatus }[]): void {
  const terminal = rows.map(r => r.status).filter(s => IMMUTABLE_STATUSES.includes(s))
  if (terminal.length > 0) throw new EscrowImmutableError(terminal)
}

/**
 * Pré-lecture des lignes ciblées par `where` (VERBATIM, garde de statut incluse) :
 * - les transitions légitimes filtrent déjà `status: HELD` (ou `in [HELD,
 *   PARTIALLY_REFUNDED]`) → la pré-lecture ne renvoie aucune ligne terminale, donc
 *   l'idempotence des rejeux de webhooks (count 0) est PRÉSERVÉE ;
 * - une mutation NON gardée (`where: { id }`) visant un escrow terminal renvoie la
 *   ligne → on lève.
 *
 * Lecture en état COMMITTÉ (reader = client de base, hors transaction courante) :
 * suffisant, « terminal » étant un fait committé et aucune transition légitime ne
 * partant d'un état terminal.
 */
async function assertManyMutable(
  reader: EscrowReader,
  where: Prisma.EscrowTransactionWhereInput | undefined,
): Promise<void> {
  const rows = await reader.escrowTransaction.findMany({ where, select: { status: true } })
  ensureMutable(rows)
}

async function assertUniqueMutable(
  reader: EscrowReader,
  where: Prisma.EscrowTransactionWhereUniqueInput,
): Promise<void> {
  const row = await reader.escrowTransaction.findUnique({ where, select: { status: true } })
  if (row) ensureMutable([row])
}

/**
 * Extension Prisma à appliquer au client central via `base.$extends(escrowGuard(base))`.
 * `reader` = client de base (non étendu) : ses lectures ne sont pas interceptées
 * → aucune récursion.
 */
export function escrowGuard(reader: EscrowReader) {
  return Prisma.defineExtension({
    name: 'escrow-immutability-guard',
    query: {
      escrowTransaction: {
        async update({ args, query }) {
          await assertUniqueMutable(reader, args.where)
          return query(args)
        },
        async updateMany({ args, query }) {
          await assertManyMutable(reader, args.where)
          return query(args)
        },
        async upsert({ args, query }) {
          await assertUniqueMutable(reader, args.where)
          return query(args)
        },
      },
    },
  })
}
