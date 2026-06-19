# Flux de sécurité global — Rate-limiter + validation QR

Deux contrôles indépendants :
1. **Rate-limiter distribué** — en bordure des routes sensibles (auth + actions mission), avant tout traitement.
2. **Sceau QR interne** — au point de libération du séquestre (`/confirm-collection`).

```mermaid
flowchart TD
    REQ([Requête entrante]) --> RL{Route sensible ?<br/>register / login / receive / customs-receipt}

    RL -- non --> ROUTE[Traitement route normal]
    RL -- oui --> CHK["isRateLimited(name:maskIp(ip):id)<br/>UPSERT atomique Postgres"]
    CHK -->|count &gt; MAX| R429[["429 RATE_LIMITED"]]
    CHK -->|count &le; MAX| ROUTE
    CHK -. erreur DB .-> FO[fail-open : on laisse passer]
    FO --> ROUTE

    %% Cycle de livraison sécurisé
    ROUTE --> SHIP["POST /ship  (MATCHED -> IN_PROGRESS)"]
    SHIP --> GEN["Génère sceau : randomBytes(32)<br/>stocke sha256 dans innerQrCodeHash<br/>renvoie le brut 1x (impression/scellage)"]
    GEN --> DEPOT["POST /dropoff-receipt -> DEPOSITED<br/>(génère le sceau si absent, idempotent)"]

    DEPOT --> COLL["POST /confirm-collection (acheteur)"]
    COLL --> OWN{Acheteur de la mission ?}
    OWN -- non --> R404[["404 MISSION_NOT_FOUND (IDOR)"]]
    OWN -- oui --> ST{Statut == DEPOSITED ?}
    ST -- non --> R400S[["400 INVALID_MISSION_STATE"]]
    ST -- oui --> SEAL{Sceau enregistré ?}

    SEAL -- non --> CAP
    SEAL -- oui --> QR{"timingSafeEqual(sha256(brut posté),<br/>innerQrCodeHash) ?"}
    QR -- non / absent --> RQR[["400 INVALID_QR_PROOF<br/>(aucune capture, séquestre intact)"]]
    QR -- oui --> CAP["Capture Stripe (hors tx)<br/>-> VALIDATED"]

    CAP --> WH["webhook payment_intent.succeeded<br/>PAYOUT + COMMISSION + TransferOutbox"]
    WH --> REL([RELEASED — voyageur payé])

    %% Purge
    CRON["cron horaire : purgeExpiredRateLimits()<br/>DELETE WHERE expiresAt &lt; NOW()"] -.-> CHK
```

## Lecture rapide
- Le rate-limiter et le sceau QR sont **orthogonaux** : le premier protège l'accès (brute-force, flood), le second protège la **libération des fonds** (anti colis vide).
- Aucune capture Stripe n'a lieu tant que la preuve QR n'est pas validée (quand un sceau existe).
- Le rate-limiter est **fail-open** ; le sceau QR est **fail-closed** (pas de preuve ⇒ pas de libération).

## Modèle de données — Wallet ↔ Mission ↔ User

Autorisation par ressource : « acheteur » / « voyageur » est dérivé des FK
`Mission.buyerId` / `Mission.travelerId` (pas de rôle de compte). Les FK en
`RESTRICT` (sans cascade) dictent l'ordre de purge des tests : il faut détruire
`WalletTransaction → Wallet → User` et `EscrowTransaction → Mission → User`
(cf. `tests/helpers/db-reset.ts`).

```mermaid
erDiagram
    USER ||--o| WALLET : "possède (userId @unique · RESTRICT)"
    USER ||--o{ MISSION : "achète (BuyerMissions · RESTRICT)"
    USER |o--o{ MISSION : "voyage (TravelerMissions? · RESTRICT)"
    WALLET ||--o{ WALLET_TRANSACTION : "historise (walletId · RESTRICT)"
    MISSION ||--o| WALLET_TRANSACTION : "crédite reliquat (missionId @unique · CASCADE)"
    MISSION ||--o| ESCROW_TRANSACTION : "séquestre (missionId @unique · RESTRICT)"

    USER {
        string id PK
        boolean isAdmin
    }
    WALLET {
        string id PK
        string userId UK "FK -> USER (RESTRICT)"
        int balanceCents
    }
    WALLET_TRANSACTION {
        string id PK
        string walletId FK "-> WALLET (RESTRICT)"
        string missionId UK "FK -> MISSION (CASCADE)"
        int amountCents
        string reason
    }
    MISSION {
        string id PK
        string buyerId FK "-> USER (RESTRICT)"
        string travelerId FK "-> USER? (RESTRICT)"
        int budgetCents
    }
    ESCROW_TRANSACTION {
        string id PK
        string missionId UK "FK -> MISSION (RESTRICT)"
        int spendingLimitCents
        EscrowStatus status
    }
```

- Un `User` a **0..1** `Wallet` (`userId @unique`) ; le `Wallet` est **RESTRICT** sur l'utilisateur ⇒ purge avant `user.deleteMany()`.
- Un `WalletTransaction` est **unique par mission** (idempotence du crédit résiduel de substitution) et **cascade** avec la mission, mais reste **RESTRICT** sur le wallet.
- L'`EscrowTransaction` (1:1 mission) est **RESTRICT** ⇒ purge avant la mission.
