/**
 * Configuration des fournisseurs TSA (RFC 3161) pour l'horodatage des preuves QPP.
 *
 * Chaîne de failover ordonnée — le client essaie chaque fournisseur dans l'ordre
 * jusqu'au premier jeton `granted` validé :
 *   1. sectigo  — HTTPS, CA majeure, endpoint public stable.
 *   2. certum   — QTSP polonais inscrit sur la liste de confiance UE (ancrage eIDAS) ;
 *                 endpoint public HTTP (le jeton RFC 3161 est signé, donc
 *                 auto-protégé contre l'altération en transit).
 *   3. digicert — HTTP uniquement (le 443 ne sert pas l'API RFC 3161).
 *
 * FreeTSA est banni : ne jamais le réintroduire ici.
 *
 * Surcharge production sans redéploiement de code : variable d'environnement
 * `TSA_ENDPOINTS` = liste d'URLs séparées par des virgules, ordre = priorité.
 * Permet de brancher un QTSP qualifié sous contrat (ex. Universign, Certum payant)
 * en tête de chaîne le moment venu.
 */

export interface TsaProvider {
  /** Identifiant stable pour logs et métriques (hostname pour les surcharges env). */
  id: string
  /** Endpoint RFC 3161 — POST binaire `application/timestamp-query`. */
  url: string
  /** Délai maximal par tentative avant bascule sur le fournisseur suivant. */
  timeoutMs: number
  /** Coût estimé par jeton délivré, en centimes (convention Waylo : jamais de Float). */
  estimatedCostCents: number
}

export const DEFAULT_TSA_TIMEOUT_MS = 10_000

/**
 * Provision de coût par jeton pour un QTSP qualifié sous contrat, en centimes.
 * Fondement (cf. docs/tsa-economics.md) : milieu de fourchette des offres
 * qualifiées eIDAS en volume (~2–20 ¢/jeton ; Disig ~10–20 ¢, packs pro
 * Certum/GlobalTrust ~2–10 ¢). Les endpoints publics par défaut coûtent 0 ¢ ;
 * cette provision s'applique aux fournisseurs injectés via TSA_ENDPOINTS.
 */
export const ESTIMATED_COST_PER_TOKEN_CENTS = 5

const DEFAULT_PROVIDERS: readonly TsaProvider[] = [
  { id: 'sectigo', url: 'https://timestamp.sectigo.com', timeoutMs: DEFAULT_TSA_TIMEOUT_MS, estimatedCostCents: 0 },
  { id: 'certum', url: 'http://time.certum.pl', timeoutMs: DEFAULT_TSA_TIMEOUT_MS, estimatedCostCents: 0 },
  { id: 'digicert', url: 'http://timestamp.digicert.com', timeoutMs: DEFAULT_TSA_TIMEOUT_MS, estimatedCostCents: 0 },
]

/**
 * Retourne la chaîne de fournisseurs, `TSA_ENDPOINTS` prenant le pas sur les défauts.
 * Une URL invalide dans la surcharge est une erreur de configuration : on échoue
 * immédiatement plutôt que de dégrader silencieusement la chaîne de preuves.
 */
export function getTsaProviders(env: NodeJS.ProcessEnv = process.env): readonly TsaProvider[] {
  const raw = env.TSA_ENDPOINTS?.trim()
  if (!raw) return DEFAULT_PROVIDERS

  return raw.split(',').map((entry) => {
    const candidate = entry.trim()
    let parsed: URL
    try {
      parsed = new URL(candidate)
    } catch {
      throw new Error(`TSA_ENDPOINTS_INVALID_URL: ${candidate}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`TSA_ENDPOINTS_INVALID_URL: ${candidate}`)
    }
    // Un endpoint injecté par env est présumé sous contrat QTSP : on lui
    // applique la provision de coût plutôt que le 0 ¢ des endpoints publics.
    return {
      id: parsed.hostname,
      url: candidate,
      timeoutMs: DEFAULT_TSA_TIMEOUT_MS,
      estimatedCostCents: ESTIMATED_COST_PER_TOKEN_CENTS,
    }
  })
}
