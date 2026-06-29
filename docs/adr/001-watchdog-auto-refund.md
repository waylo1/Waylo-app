# ADR 001: Mise en place du Watchdog Auto-Refund

* **Statut** : Accepté
* **Contexte** : Nécessité de sécuriser les fonds en cas d'inactivité du voyageur (délai > 72h).
* **Décision** : Ajout de autoRefundDeadline sur les missions. Le mission-lifecycle.ts déclenche triggerAutoRefundWatchdog au tick horaire.
* **Conséquences** :
    * Réduction de la dette technique par suppression de dispute-handler.ts.
    * Idempotence garantie par vérification d'état (IN_DISPUTE et innerQrCodeHash).
    * Migration additive (safe pour la prod).
