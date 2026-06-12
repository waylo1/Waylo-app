# Waylo — Gotchas : pièges identifiés et parades

> Contexte : marketplace de personal shopping transfrontalier sécurisée par escrow
> (PostgreSQL + Prisma + Fastify + Stripe + TypeScript — dépôt `waylo1/Waylo-app`).

## Latence réseau magasin (Stripe Issuing JIT)
- **Piège** : le webhook `issuing_authorization.request` doit répondre en **< 2 s**
  (sinon Stripe applique le fallback de refus/approbation par défaut). Or l'autorisation
  part souvent d'un TPE en magasin avec réseau dégradé côté runner — la latence
  qu'on ne contrôle pas est déjà consommée avant d'atteindre notre serveur.
- **Parade** :
  - Décision pré-calculée : plafond de mission figé en DB au départ de la mission,
    le webhook ne fait qu'une lecture indexée + comparaison (pas d'agrégation, pas d'appel externe).
  - Aucun appel réseau sortant (Stripe API, e-mail, push) dans le chemin du webhook —
    tout effet secondaire en post-traitement asynchrone.
  - Fallback Stripe configuré en **refus par défaut** : un timeout ne doit jamais approuver.
  - Idempotence sur `authorization.id` : les retries Stripe ne doivent pas double-débiter.

## Anti-TOCTOU (escrow & plafonds)
- **Piège** : lire l'état puis écrire en deux requêtes = fenêtre de course
  (deux webhooks concurrents sur le même escrow : double libération, double journalisation
  d'un refund, double capture).
- **Parade** (cf. `src/stripe/webhook.route.ts`, `src/workers/transfer-worker.ts`) :
  - Jamais de `findUnique` puis `update` séparés. Toute transition d'état =
    `prisma.$transaction()` avec `updateMany` conditionnel atomique (ex. `where: { status:
    HELD }` pour HELD → RELEASED, `capturedAmountCents: 0` pour la capture) ou
    `SELECT ... FOR UPDATE` explicite via `$queryRaw` (refund : verrou de la ligne escrow
    AVANT lecture du Σ(REFUND) ; worker : `FOR UPDATE SKIP LOCKED` au claim).
  - Vérifier le rowcount : 0 ligne affectée = état incompatible → abort + alerte, pas
    d'exception silencieuse.
  - Le plafond JIT (`spendingLimitCents`) et le statut de l'escrow vivent sur la même ligne
    `EscrowTransaction` lue par le webhook d'autorisation — une seule source de vérité,
    pas deux compteurs à réconcilier.

## Supabase + Prisma (connexions)
- **Piège** : avec Supabase, les migrations Prisma (`migrate`, `db push`) exigent la
  connexion DIRECTE à Postgres — pas le pooler (PgBouncer/Supavisor en mode transaction).
- **Parade** :
  - Déclarer `directUrl` dans le datasource du schéma : `DATABASE_URL` pour le runtime,
    `DIRECT_URL` pour les migrations.
  - Instance Fastify unique : connexion directe pour TOUT au début ; n'introduire le
    pooler qu'en cas de scaling horizontal.
  - Les verrous `FOR UPDATE` / `SKIP LOCKED` s'exécutent dans une transaction Prisma
    unique (même connexion de bout en bout) — compatibles si la connexion est bien
    configurée.

## Divers
- Stripe webhook : ne jamais skipper `constructEvent()` en dev.
- DB dev locale : conteneur Docker partagé `flipsync-pg` (postgres:16-alpine), port **5433** —
  bases Waylo : `waylo` (dev) et `waylo_test` (tests, purgée par les suites). Pas de SQLite possible.
