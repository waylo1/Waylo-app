// Miroir STRICT des modèles Prisma du backend (prisma/schema.prisma).
// Argent : centimes Int partout (jamais Float). Dates : ISO strings (JSON).

export const MISSION_STATUSES = [
  "CREATED",
  "FUNDED",
  "MATCHED",
  "IN_PROGRESS",
  "AWAITING_VALIDATION",
  "VALIDATED",
  "AWAITING_TRAVELER_ACCOUNT",
  "RELEASED",
  "REFUNDED",
  "CANCELLED",
] as const;

export type MissionStatus = (typeof MISSION_STATUSES)[number];

export type KycStatus = "PENDING" | "VERIFIED" | "REJECTED";

// Reçu scellé tel qu'exposé par GET /missions/:id — champs publics seulement
// (jamais les sha256). receiptUrl nullable : reçus legacy antérieurs au champ.
export interface MissionReceipt {
  totalTtcCents: number;
  receiptUrl: string | null;
  sealedAt: string;
}

export interface Mission {
  id: string;
  buyerId: string;
  travelerId: string | null;
  status: MissionStatus;
  targetProduct: string;
  budgetCents: number;
  commissionCents: number;
  origin: string;
  destination: string;
  trackingReference: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  // Présent uniquement sur GET /missions/:id (null si aucun reçu scellé) ;
  // absent des réponses liste.
  receipt?: MissionReceipt | null;
}

export interface Receipt {
  id: string;
  missionId: string;
  totalTtcCents: number;
  receiptUrl: string | null;
  sha256Client: string;
  sha256Server: string;
  sealedAt: string;
}

export interface AuthUser {
  id: string;
  email: string;
  kycStatus: KycStatus;
  createdAt: string;
}

// POST /api/missions/:id/intent
export interface IntentResponse {
  clientSecret: string | null;
  paymentIntentId: string;
  amountCents: number;
}

// POST /api/missions/:id/checkout-session
export interface CheckoutSessionResponse {
  checkoutUrl: string | null;
  sessionId: string;
}

// POST /api/missions — corps attendu par le backend.
export interface CreateMissionBody {
  targetProduct: string;
  budgetCents: number;
  commissionCents: number;
  origin: string;
  destination: string;
  expiresAt: string;
}

// POST /api/missions/:id/submit-receipt — corps attendu par le backend.
export interface SubmitReceiptBody {
  urlRecu: string;
  purchaseAmountCents: number;
}
