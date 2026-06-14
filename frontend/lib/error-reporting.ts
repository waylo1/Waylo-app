// SDK léger de capture d'erreurs, piloté par variables d'environnement (aucune
// dépendance externe). POST JSON best-effort vers un DSN si activé. Les PII
// (mots de passe, cartes bancaires, jetons) sont STRICTEMENT scrubbées avant
// tout log/envoi.

const DSN = process.env.NEXT_PUBLIC_ERROR_DSN;
const ENABLED = process.env.NEXT_PUBLIC_ERROR_REPORTING_ENABLED === "true";

// Clés sensibles : leur valeur est remplacée par [REDACTED] (insensible à la casse).
const PII_KEY =
  /(pass(word)?|mot[\s_-]?de[\s_-]?passe|card|carte|cvc|cvv|iban|secret|token|authorization|bearer)/i;
// Motifs sensibles en texte libre : numéros de carte (13-19 chiffres) et jetons Bearer.
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._-]+/gi;

function scrubString(s: string): string {
  return s.replace(CARD_RE, "[REDACTED]").replace(BEARER_RE, "Bearer [REDACTED]");
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[…]";
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map(v => scrub(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = PII_KEY.test(k) ? "[REDACTED]" : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface ErrorContext {
  source?: string;
  [key: string]: unknown;
}

/** Capture une erreur : scrubbing PII, console en dev, POST au DSN si activé. */
export function captureError(error: unknown, context: ErrorContext = {}): void {
  const err = error instanceof Error ? error : new Error(String(error));
  const event = scrub({
    name: err.name,
    message: err.message,
    stack: err.stack,
    // pathname seulement — jamais la query string (PII/jetons potentiels).
    path: typeof window !== "undefined" ? window.location.pathname : undefined,
    context,
  }) as Record<string, unknown>;

  if (process.env.NODE_ENV !== "production") {
    console.error("[error-reporting]", event);
  }
  if (!ENABLED || !DSN || typeof navigator === "undefined") return;
  try {
    const body = JSON.stringify(event);
    if (navigator.sendBeacon) {
      navigator.sendBeacon(DSN, body);
    } else {
      void fetch(DSN, {
        method: "POST",
        body,
        keepalive: true,
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch {
    // Best-effort : le reporter ne doit jamais lever d'exception.
  }
}

let initialized = false;
/** Branche les handlers globaux (idempotent). À appeler côté client uniquement. */
export function initErrorReporting(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  window.addEventListener("error", e =>
    captureError(e.error ?? e.message, { source: "window.error" }),
  );
  window.addEventListener("unhandledrejection", e =>
    captureError(e.reason, { source: "unhandledrejection" }),
  );
}
