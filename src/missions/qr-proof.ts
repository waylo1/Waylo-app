import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Preuve cryptographique du QR scellé À L'INTÉRIEUR du colis (anti « colis vide »).
 * Waylo ne persiste QUE le sha256 (hex) du code ; le code brut est imprimé/scellé
 * dans le colis et n'existe jamais en clair côté serveur. À la collecte, l'acheteur
 * scanne le brut et le poste : on en recalcule le hash et on le compare au sceau
 * stocké, en TEMPS CONSTANT (timingSafeEqual) — pas d'oracle de timing sur le sceau.
 */

/** sha256 hex du code brut (32 octets → 64 hex). */
export function hashQrCode(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

/**
 * `true` si sha256(raw) == sceau stocké, comparé en temps constant. Tout sceau
 * mal formé (longueur ≠ 32 octets après décodage hex) → `false` sans throw :
 * timingSafeEqual exige des buffers de même longueur.
 */
export function qrCodeMatches(raw: string, storedHashHex: string): boolean {
  const submitted = Buffer.from(hashQrCode(raw), 'hex')
  const stored = Buffer.from(storedHashHex, 'hex')
  if (stored.length !== submitted.length) return false
  return timingSafeEqual(submitted, stored)
}
