// Convention projet : centimes Int partout. Conversion uniquement à l'affichage
// et à la saisie — jamais de Float stocké ou envoyé.

export function centsToEur(cents: number): string {
  return (cents / 100).toLocaleString("fr-FR", {
    style: "currency",
    currency: "EUR",
  });
}

/** Saisie "12,34" ou "12.34" → 1234 centimes. null si invalide. */
export function eurToCents(input: string): number | null {
  const normalized = input.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, decimals = ""] = normalized.split(".");
  return Number(whole) * 100 + Number(decimals.padEnd(2, "0") || "0");
}
