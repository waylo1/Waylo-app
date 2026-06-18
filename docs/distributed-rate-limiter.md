# Module — Rate-limiter distribué (store Postgres)

> Anti-brute-force partagé entre toutes les instances Fly et persistant aux
> redémarrages. Remplace l'ancienne `Map` en mémoire mono-process (contournable
> par scale-out et réinitialisée à chaque suspend/restart).

## Principe — fenêtre fixe, UPSERT atomique

Une ligne `RateLimit` par **clé** ; `count` requêtes autorisées par fenêtre de
`RATE_LIMIT_WINDOW_MS`, puis réinitialisation. Le compteur est incrémenté par un
**UPSERT atomique en une seule instruction SQL** → verrou de ligne implicite
Postgres → sûr sous requêtes concurrentes multi-instances (aucun TOCTOU).

[`src/rate-limit.ts`](../src/rate-limit.ts) :

```sql
INSERT INTO "RateLimit" ("key","count","expiresAt") VALUES ($key, 1, $expiresAt)
ON CONFLICT ("key") DO UPDATE SET
  "count"     = CASE WHEN "RateLimit"."expiresAt" < $now THEN 1 ELSE "RateLimit"."count" + 1 END,
  "expiresAt" = CASE WHEN "RateLimit"."expiresAt" < $now THEN $expiresAt ELSE "RateLimit"."expiresAt" END
RETURNING "count"
```

- Bloqué quand `count > RATE_LIMIT_MAX` ⇒ **N requêtes autorisées par fenêtre, la (N+1)ᵉ refusée**.
- `now`/`expiresAt` fournis par l'app (pas `NOW()` SQL) → pas d'ambiguïté `timestamp`/`timestamptz` ; la dérive d'horloge NTP entre instances (~ms) est négligeable pour une fenêtre.
- **Fail-open** : une erreur DB renvoie `false` (non limité) — l'opération protégée requiert de toute façon la DB et échouera d'elle-même, donc ouvrir le limiteur n'expose aucune surface.

## API

| Symbole | Signature | Rôle |
|---|---|---|
| `isRateLimited(key)` | `(string) => Promise<boolean>` | incrémente la fenêtre et renvoie `true` si dépassée. |
| `maskIp(ip)` | `(string) => string` | IPv4 → `/24`, IPv6 → `/64` — anti rotation d'adresse intra-sous-réseau. |

### Configuration (env, surchargeable)

| Variable | Défaut | Effet |
|---|---|---|
| `RATE_LIMIT_MAX` | `5` | requêtes autorisées par fenêtre/clé. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | durée de la fenêtre. |
| `RATE_LIMIT_CLEANUP_INTERVAL_MS` | `3600000` | cadence de purge. |

> En test, [`vitest.config.ts`](../vitest.config.ts) force `RATE_LIMIT_MAX=1000000` :
> le store étant désormais persistant, sans cela les compteurs s'additionneraient
> sur la durée du run. Aucune suite n'asserte le 429.

## Clés (robustes)

| Route(s) | Clé | Fichier |
|---|---|---|
| `POST /api/auth/register`, `/login` | `name:maskIp(ip):email` (email en minuscules) | [`auth.route.ts`](../src/auth/auth.route.ts) |
| `POST /api/missions/:id/receive`, `/customs-receipt` | `name:maskIp(ip):userId` | [`mission.route.ts`](../src/missions/mission.route.ts) |

## Modèle de données

`RateLimit { key @id, count Int, expiresAt DateTime, createdAt, @@index([expiresAt]) }`
— [`prisma/schema.prisma`](../prisma/schema.prisma) · migration `20260618131221_add_rate_limit`.
Pas de FK ni d'`updatedAt` (incompatible avec l'écriture en SQL brut).

## Purge des fenêtres expirées

[`src/workers/rate-limit-cleanup.ts`](../src/workers/rate-limit-cleanup.ts) :
- `purgeExpiredRateLimits()` → `DELETE FROM "RateLimit" WHERE "expiresAt" < NOW()` (indexé), renvoie le nb supprimé.
- `startRateLimitCleanupLoop(intervalMs=1h)` → `setInterval` + garde `inFlight` (pas de chevauchement) + `.catch` (panne DB n'effondre pas le scheduler).
- Démarré/arrêté dans [`src/server.ts`](../src/server.ts) (avec les autres workers).

## Tests

[`src/workers/rate-limit-cleanup.test.ts`](../src/workers/rate-limit-cleanup.test.ts) — purge uniquement les fenêtres expirées ; no-op si rien d'expiré.

## Limites connues

- Compteur DB partagé : ajoute une écriture par requête limitée (acceptable au volume actuel).
- `maskIp` suppose une IP cliente fiable (`req.ip`) — derrière le LB Fly, dépend de la confiance accordée aux en-têtes `X-Forwarded-For` (cf. config Fastify `trustProxy`).
