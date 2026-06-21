/**
 * Contrat partagé du job d'extraction OCR de reçu (file `ReceiptExtractionOutbox`).
 *
 * `ReceiptJobStatus` est le MIROIR EXACT de l'enum Prisma `ReceiptJobStatus`
 * (convention projet : enums TS = miroir des enums Prisma). `ReceiptJobData` est
 * le descripteur LÉGER du job — sans les octets image (`imageData`) ni le snapshot
 * extrait (`resultJson`) — utilisé là où l'on manipule l'état d'un job sans charger
 * sa charge utile (réponses d'API, journalisation, vues de file d'attente).
 */

export type ReceiptJobStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'CONSUMED'
  | 'FAILED'

export interface ReceiptJobData {
  id: string
  missionId: string
  /** Voyageur déposant — `mission.travelerId` vérifié à l'upload (anti-IDOR). */
  uploaderId: string
  mimeType: 'image/jpeg' | 'image/png'
  status: ReceiptJobStatus
  /** Nombre de prises en charge (claims). Borne les ré-essais d'échecs transitoires. */
  attempts: number
  /** Dernier code/erreur d'extraction — diagnostic, jamais de secret. */
  lastError: string | null
  createdAt: Date
}
