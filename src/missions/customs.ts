// Seuils de minimis douaniers par pays de destination, en UNITÉS monétaires
// entières (pas de centimes — valeur réglementaire). Au-delà du seuil, la prime
// est bloquée (mission ESCROW_LOCKED_CUSTOMS) jusqu'à la preuve de paiement des
// taxes (POST /:id/customs-receipt).

/** Seuil UE de minimis en centimes (430 €). Référence constante partagée tests ↔ service. */
export const CUSTOMS_THRESHOLD_CENTS = 43_000

const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
])

/** Seuil en unités entières (€, £, $). Multiplier par 100 pour obtenir des centimes. */
export function getCustomsThreshold(countryCode: string): number {
  const cc = countryCode.toUpperCase()
  if (cc === 'US') return 800
  if (cc === 'GB') return 450
  if (EU_COUNTRIES.has(cc)) return CUSTOMS_THRESHOLD_CENTS / 100
  return 150
}
