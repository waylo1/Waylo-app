# Audit de dette technique — `main` @ ecf980a

Périmètre : `src/` (hors `src/generated`, exclu du typecheck). Méthode : `tsc --strict`,
scan marqueurs, métriques LOC, résolution de dépendances. Une certification complète du
**code mort** nécessite un outil dédié (voir P1-a).

## Synthèse

| # | Sévérité | Sujet | Action |
|---|---|---|---|
| P1-a | **Haute** | `tsconfig` sans `noUnusedLocals`/`noUnusedParameters` | activer + ajouter `knip`/`ts-prune` en CI |
| P1-b | **Haute** | `mission.route.ts` = 1812 lignes (un seul plugin) | scinder par domaine |
| P2-a | Moyenne | override `fast-uri` redondant | retirer après vérif |
| P2-b | Moyenne | vulns dev `vitest/vite/esbuild` (majeur `vitest@4`) | planifier le bump |
| P2-c | Moyenne | `webhook.route.ts handleCapture` (~210 l, multi-branches) | extraire les étapes |
| P2-d | Moyenne | pool Prisma unique (HTTP+workers+JIT, `connection_limit=5`) | surveiller / isoler |
| P3-a | Basse | `alerts.ts:122` TODO canal critique non branché | brancher PagerDuty/Slack |
| P3-b | Basse | dérive migrations sur base de test partagée | documenter `migrate reset` |

## Détail

### P1-a — Code mort invisible (priorité racine)
[`tsconfig.json`](../tsconfig.json) est `strict: true` mais **n'active pas**
`noUnusedLocals` ni `noUnusedParameters`. Conséquence : imports, variables et
paramètres inutilisés **ne sont pas détectés**. Je ne peux donc pas certifier
« zéro code mort ».
- **Fix** : ajouter `"noUnusedLocals": true, "noUnusedParameters": true` au tsconfig
  (corriger les éventuels échecs), et intégrer `knip` (ou `ts-prune`) en CI pour les
  **exports/fichiers** non référencés (que `tsc` ne voit pas).
- Constat positif : aucun `any`/`as any` dans le code applicatif (uniquement dans
  `src/generated`, exclu) — conforme à la règle « zéro any ».

### P1-b — `mission.route.ts` monolithique
**1812 lignes** dans un seul plugin Fastify (≈ 20 routes : CRUD mission, financement,
logistique/dépôt, douane, arbitrage admin, collecte/QR…). Complexité cyclomatique et
surface de test élevées ; tout changement touche un fichier énorme.
- **Fix** : extraire en sous-plugins par domaine (`missions.crud`, `logistics`,
  `customs`, `admin`, `collection`) montés sous le même préfixe. Les helpers
  (`isRequestAdmin`, schémas) déjà isolables.

### P2-a — Override `fast-uri` redondant
[`package.json`](../package.json) `overrides.fast-uri: "^3.1.2"`. Sous Fastify 5.8.5,
`@fastify/ajv-compiler@4` et `fast-json-stringify@6` résolvent **déjà** `fast-uri@3.1.2`
— l'override ne force que ce qui serait choisi de toute façon. Risque latent : il
**bloquerait** une future migration de Fastify vers `fast-uri@4`.
- **Fix** : retirer l'override et revalider `npm audit` (les avis `<=3.1.1` étant
  couverts par Fastify 5), ou le conserver avec un commentaire de justification.

### P2-b — Vulnérabilités dev résiduelles
`npm audit` : chaîne `vitest`/`vite`/`vite-node`/`esbuild`/`@vitest/mocker`
(dev-only). Fix = `vitest@4` (majeur). Sans impact runtime, mais à planifier.

### P2-c — `handleCapture` (webhook)
[`webhook.route.ts`](../src/stripe/webhook.route.ts) ~645 l ; `handleCapture` enchaîne
journalisation capture / précondition Connect / libération / Wallet « Drive » /
garde douane en une fonction longue à branches multiples.
- **Fix** : extraire chaque étape (testable isolément), garder l'orchestration mince.

### P2-d — Pool Prisma partagé
[`db.ts`](../src/db.ts) : un seul `PrismaClient` (`connection_limit=5` par instance)
sert l'HTTP, tous les workers (transfer/penalty/buyer-compensation/réconciliation/purge)
et le chemin JIT (< 2 s). Contention possible sous charge.
- **Fix** : surveiller (métriques pool), envisager un pool/identité dédié aux workers,
  ou ajuster `DATABASE_CONNECTION_LIMIT` selon le nb d'instances Fly vs plafond Supabase.

### P3-a — Alerte critique non branchée
[`alerts.ts`](../src/alerts.ts) `:122` — `TODO(prod)`: brancher le canal réel
(PagerDuty/Slack). Les alertes critiques risquent d'être log-only en prod.

### P3-b — Dérive de migrations (base de test partagée)
`waylo_test` partagée entre branches aux migrations divergentes → frictions
(`migrate deploy` vs colonnes/tables d'une autre branche). Documenter le réflexe
`npm run migrate:reset` au changement de branche, ou base de test éphémère par run.

## Métriques (LOC source)
```
mission.route.ts   1812   <- hotspot
webhook.route.ts    645
reconciliation.ts   450
server.ts           217
```

## Dépendances
- **Prod** (`@fastify/jwt`, `@prisma/client`, `argon2`, `fastify`, `stripe`) : toutes utilisées, **aucune inutile**.
- **Dev** (`@types/node`, `prisma`, `tsx`, `typescript`, `vitest`) : toutes utilisées.
