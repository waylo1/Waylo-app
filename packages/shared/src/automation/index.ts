// @waylo/shared/automation — Infra d'automatisation générale du monorepo.
//
// Trois modules orthogonaux :
//   - Watchdog : retry exponentiel + timeout strict par tâche.
//   - Alias    : registry de profils Watchdog nommés + templates métier.
//   - Cleanup  : scheduler de janitors avec escalade d'erreurs.
//
// Consommé par le backend (Node.js) via import direct des sources (pas de build).
// Zéro dépendance runtime externe — uniquement les APIs JS standard (setTimeout,
// setInterval, Promise).

export {
  automate,
  WatchdogTimeoutError,
  WatchdogExhaustedError,
} from './watchdog'
export type { WatchdogOptions, AttemptLog, ExhaustLog } from './watchdog'

export {
  registerAlias,
  getAlias,
  listAliases,
  clearRegistry,
  runAlias,
  registerBuiltinAliases,
  AliasConfigError,
  AliasNotFoundError,
} from './alias'
export type { AliasConfig, AliasRunOptions } from './alias'

export {
  CleanupScheduler,
  CleanupWorkerError,
} from './cleanup'
export type { CleanupWorker, CleanupLog, CleanupSchedulerOptions } from './cleanup'
