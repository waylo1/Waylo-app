import { describe, expect, it } from 'vitest'
import { hashQrCode, qrCodeMatches } from './qr-proof'

/**
 * Sceau QR interne — primitive crypto pure (aucune DB). Couvre le hash, le match
 * en temps constant, et la robustesse aux sceaux mal formés (pas de throw).
 */
describe('qr-proof — sceau QR interne', () => {
  it('hashQrCode : sha256 hex 64 caractères, déterministe', () => {
    const h = hashQrCode('WAYLO-SEAL-123')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(hashQrCode('WAYLO-SEAL-123')).toBe(h)
  })

  it('qrCodeMatches : code brut correct → true', () => {
    expect(qrCodeMatches('WAYLO-SEAL-123', hashQrCode('WAYLO-SEAL-123'))).toBe(true)
  })

  it('qrCodeMatches : code brut faux → false', () => {
    expect(qrCodeMatches('WAYLO-SEAL-123', hashQrCode('autre-valeur'))).toBe(false)
  })

  it('qrCodeMatches : sceau mal formé (longueur ≠, hex invalide) → false sans throw', () => {
    expect(qrCodeMatches('x', '')).toBe(false)
    expect(qrCodeMatches('x', 'deadbeef')).toBe(false) // 4 octets ≠ 32
    expect(qrCodeMatches('x', 'zz')).toBe(false) // hex invalide → buffer tronqué
  })
})
