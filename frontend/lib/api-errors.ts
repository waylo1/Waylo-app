import { ApiError } from "./api";

// Messages FR explicites pour chaque code d'erreur backend ({ error: 'SNAKE_CASE' }).
// Un code inconnu est affiché tel quel : on ne masque jamais une erreur API.

const ERROR_LABELS: Record<string, string> = {
  // Auth
  UNAUTHORIZED: "Session expirée — reconnectez-vous.",
  FORBIDDEN: "Accès refusé — vous n'êtes pas autorisé pour cette action.",
  RATE_LIMITED: "Trop de requêtes — patientez une minute puis réessayez.",
  INVALID_CREDENTIALS: "Email ou mot de passe incorrect.",
  EMAIL_ALREADY_REGISTERED: "Un compte existe déjà avec cet email.",
  INVALID_INPUT: "Champs invalides — vérifiez le formulaire.",
  // Missions — cycle de vie
  MISSION_NOT_FOUND: "Mission introuvable.",
  EXPIRES_AT_IN_PAST: "La date d'expiration doit être dans le futur.",
  MISSION_ALREADY_FUNDED: "Cette mission est déjà financée.",
  MISSION_NOT_FUNDABLE: "Cette mission n'est plus finançable (statut avancé).",
  MISSION_NOT_AWAITING_VALIDATION:
    "La mission n'est pas (ou plus) en attente de validation — déjà validée ?",
  ESCROW_NOT_HELD:
    "Le séquestre n'est pas en place — validation impossible, contactez le support.",
  CANNOT_MATCH_OWN_MISSION: "Vous ne pouvez pas accepter votre propre mission.",
  MISSION_NOT_MATCHABLE: "Cette mission n'est pas encore financée.",
  MISSION_ALREADY_MATCHED: "Trop tard — un autre voyageur a pris cette mission.",
  MISSION_NOT_MATCHED:
    "La mission n'est pas (ou plus) au statut « voyageur assigné ».",
  MISSION_NOT_IN_PROGRESS: "La mission n'est plus en cours — action refusée.",
  MISSION_NOT_CUSTOMS_LOCKED:
    "La mission n'est pas (ou plus) bloquée en douane — action refusée.",
  // Reçus
  RECEIPT_AMOUNT_EXCEEDS_BUDGET:
    "Le montant du reçu dépasse le budget figé de la mission.",
  RECEIPT_ALREADY_SUBMITTED: "Un reçu a déjà été scellé pour cette mission.",
  // Génériques
  INTERNAL_ERROR: "Erreur interne du serveur — réessayez.",
};

/** Message UI pour une erreur attrapée : code backend traduit, sinon code brut, sinon fallback réseau. */
export function apiErrorMessage(
  err: unknown,
  fallback = "Erreur réseau — backend joignable ?",
): string {
  if (err instanceof ApiError) {
    return ERROR_LABELS[err.code] ?? `Erreur API : ${err.code}`;
  }
  return fallback;
}
