import { describe, expect, it } from 'vitest'
import type { Mission } from '../../generated/prisma'
import { MissionStatus } from '../../generated/prisma'
import { mapToPublicMissionDTO, PublicMissionDTO } from './mission.dto'

/**
 * Whitelist DTO de GET /api/missions (privacy-first) — fonction pure.
 * Garantit que seules les 7 clés autorisées sortent, indépendamment des
 * champs internes/sensibles portés par la ligne Mission.
 */

const WHITELIST = [
  'budgetCents',
  'buyerId',
  'commissionCents',
  'createdAt',
  'id',
  'status',
  'travelerId',
]

// Fixture : ligne Mission réaliste (7 champs whitelistés) + champs internes
// sensibles. Le cast unique évite de recopier les ~40 colonnes du modèle.
const makeMission = (overrides: Record<string, unknown> = {}): Mission =>
  ({
    id: 'ckmission0001',
    status: MissionStatus.FUNDED,
    buyerId: 'usr_buyer',
    travelerId: 'usr_traveler',
    budgetCents: 10_000,
    commissionCents: 1_500,
    createdAt: new Date('2026-01-15T10:00:00.000Z'),
    // champs internes/sensibles — JAMAIS exposés au client
    targetProduct: 'Sac introuvable',
    purchaseAmountCents: 9_800,
    deliveryProofHash: 'deadbeef',
    innerQrCodeHash: 'cafebabe',
    ...overrides,
  } as unknown as Mission)

describe('mapToPublicMissionDTO — whitelist privacy-first', () => {
  it('nominal : exactement les 7 clés whitelistées, ni plus ni moins', () => {
    const dto = mapToPublicMissionDTO(makeMission())
    expect(Object.keys(dto).sort()).toEqual(WHITELIST)
  })

  it('anti-fuite : aucun champ non whitelisté (réel ou injecté) ne sort', () => {
    const dto = mapToPublicMissionDTO(
      makeMission({ internalNote: 'PII interne', _secret: 'token' }),
    )
    expect(Object.keys(dto).sort()).toEqual(WHITELIST)
    expect(dto).not.toHaveProperty('internalNote')
    expect(dto).not.toHaveProperty('_secret')
    expect(dto).not.toHaveProperty('targetProduct')
    expect(dto).not.toHaveProperty('purchaseAmountCents')
    expect(dto).not.toHaveProperty('deliveryProofHash')
  })

  it('intégrité : valeurs transmises sans transformation, montants entiers', () => {
    const dto = mapToPublicMissionDTO(makeMission())
    expect(dto).toEqual({
      id: 'ckmission0001',
      status: MissionStatus.FUNDED,
      buyerId: 'usr_buyer',
      travelerId: 'usr_traveler',
      budgetCents: 10_000,
      commissionCents: 1_500,
      createdAt: new Date('2026-01-15T10:00:00.000Z'),
    })
    expect(Number.isInteger(dto.budgetCents)).toBe(true)
    expect(Number.isInteger(dto.commissionCents)).toBe(true)
    expect(dto.createdAt).toBeInstanceOf(Date)
  })

  it('intégrité : travelerId null (mission non matchée) préservé', () => {
    const dto = mapToPublicMissionDTO(makeMission({ travelerId: null }))
    expect(dto.travelerId).toBeNull()
  })

  it('collection : N missions → N DTO, ordre préservé', () => {
    const missions = [
      makeMission({ id: 'm1' }),
      makeMission({ id: 'm2' }),
      makeMission({ id: 'm3' }),
    ]
    const dtos: PublicMissionDTO[] = missions.map(mapToPublicMissionDTO)
    expect(dtos).toHaveLength(3)
    expect(dtos.map(d => d.id)).toEqual(['m1', 'm2', 'm3'])
    dtos.forEach(d => expect(Object.keys(d).sort()).toEqual(WHITELIST))
  })

  it('collection : tableau vide → tableau vide', () => {
    const dtos: PublicMissionDTO[] = ([] as Mission[]).map(mapToPublicMissionDTO)
    expect(dtos).toEqual([])
  })
})
