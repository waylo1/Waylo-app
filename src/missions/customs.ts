// Seuils de minimis douaniers par pays de destination, en UNITÉS monétaires
// entières (pas de centimes — valeur réglementaire). Au-delà du seuil, la prime
// est bloquée (mission ESCROW_LOCKED_CUSTOMS) jusqu'à la preuve de paiement des
// taxes (POST /:id/customs-receipt).
const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
])

export function getCustomsThreshold(countryCode: string): number {
  const cc = countryCode.toUpperCase()
  if (cc === 'US') return 800
  if (cc === 'GB') return 450
  if (EU_COUNTRIES.has(cc)) return 430
  return 150
}
