/**
 * Erreur applicative OPÉRATIONNELLE — attendue et maîtrisée (refus d'accès,
 * ressource absente, conflit d'état, validation métier), par opposition à un
 * défaut programme / panne (bug, DB indisponible) qui, lui, n'est PAS
 * opérationnel et finit en 500.
 *
 * Le gestionnaire d'erreurs CENTRAL (cf. `src/app.ts` → `setErrorHandler`) la
 * sérialise en `{ error: code, details? }` avec le `statusCode` porté. Les
 * routes se contentent donc de `throw new AppError(...)` — aucun mapping
 * HTTP manuel, aucun `try/catch` de présentation.
 *
 * Convention projet (cf. CLAUDE.md) : `code` en SNAKE_CASE, c'est lui qui part
 * dans `{ error: '...' }`.
 */
export class AppError extends Error {
  /**
   * Marqueur d'erreur prévue : `true` distingue un échec métier (mapping HTTP
   * propre) d'un défaut non maîtrisé. Le handler central ne loggue en `error`
   * que ce qui N'EST PAS une `AppError`.
   */
  readonly isOperational = true as const

  constructor(
    /** Code stable `{ error: code }` — SNAKE_CASE. */
    readonly code: string,
    /** Statut HTTP renvoyé tel quel par le handler central. */
    readonly statusCode: number,
    /** Contexte structuré optionnel, joint à la réponse sous `details`. */
    readonly details?: unknown,
  ) {
    super(code)
    this.name = 'AppError'
  }
}
