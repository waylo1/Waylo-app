# Receipt Reconciliation Module

## Overview

Defensive receipt validation pipeline for escrow marketplace. Three layers:
1. **Input Guard** — metadata stripping + adversarial pattern detection
2. **Receipt Reconciliation** — pure arithmetic integrity checks + OCR pipeline orchestration
3. **Dispute Guard** — violations freeze mission via dispute + critical alert

**Status**: Production-ready. Adversarial review (4 finders): 0 confirmed bypasses.

---

## Layer 1: Input Guard

**File**: `src/services/inputGuard.ts`

### `sanitizeVisionInput(imageBuffer: Buffer): Promise<Buffer>`

Removes metadata from JPEG/PNG images before OCR processing.

**JPEG handling**:
- Strips APPn (0xFFE0–0xFFEF): EXIF, XMP, ICC, IPTC, JFIF
- Strips COM (0xFFFE): free-text comments
- Preserves: SOI, EOI, functional segments (DQT, DHT, SOFn, DRI), scan entropy stream

**PNG handling**:
- Strips ancillary chunks: `tEXt`, `zTXt`, `iTXt` (text vectors), `eXIf` (EXIF), `tIME` (timestamp)
- Preserves: critical chunks (IHDR, PLTE, IDAT, IEND), render ancillaries (gAMA, cHRM, sRGB, etc.)

**Fail-closed**:
- Unknown formats → `UnsupportedImageError` (magic bytes non-JPEG/PNG)
- Malformed/truncated → `MalformedImageError` (segment overflow, missing EOF, invalid markers)
- Buffer < 8 bytes → `MalformedImageError`

**Scope**: Segment-level stripping only. **Does not** re-encode pixels; pixel-domain steganography out of scope (would require full image library).

### `detectPromptInjection(ocrText: string): boolean`

Heuristic detection for adversarial patterns in OCR'd text.

**Normalization** (obfuscation-resistant):
- NFKC (folds fullwidth/compatibility variants)
- Strips zero-width characters (ZWSP, ZWNJ, ZWJ, WJ, BOM)
- Strips control characters (0x00–0x1F)
- Lowercase + whitespace compression

**Pattern families detected**:
1. Instruction override: "ignore previous instructions", "disregard all prior prompts", "forget everything above"
2. Role switch: "you are now", "act as", "pretend to be", "do anything now", "jailbreak"
3. Fake system markers: `<|im_start|>`, `[system]`, `system:`, `## system`
4. Amount falsification: "set/change total to €X", "the real total is €Y" (numeric context required)

**False positives**: Minimal on legitimate receipt text ("return policy", "total refund within 30 days").

---

## Layer 2: Receipt Reconciliation

**File**: `src/services/receiptReconciliation.ts`

### Data Model

**`Receipt`** (interface):
```typescript
{
  id: string                           // unique receipt ID
  orderId: string                      // foreign key to Order
  totalAmount: number                  // cents, int — LINE TOTAL (sum of items[].price)
  currency: string                     // ISO 4217 (e.g. "EUR")
  merchantName: string                 // e.g. "Carrefour Market"
  date: string                         // ISO 8601 datetime
  items: ReceiptItem[]                 // nonempty array
}

ReceiptItem:
  name: string                         // e.g. "Widget"
  price: number                        // cents, int — LINE TOTAL (not unit price)
  quantity?: number                    // metadata: future decomposition
```

**`Order`** (interface):
```typescript
{
  id: string                           // matches Receipt.orderId
  currency: string                     // matches Receipt.currency
}
```

**Zod schema** (`src/schemas/receipt.ts`):
- Validates at route boundaries (not inside pure functions)
- `receiptSchema`: mirrors Receipt interface exactly
- `totalAmount`: int, positive
- `currency`: regex `/^[A-Z]{3}$/` (ISO 4217)
- `date`: ISO datetime
- `items`: nonempty array, each with `name`, `price` (int ≥ 0), optional `quantity` (int > 0)

### `verifyReceiptIntegrity(receipt: Receipt, order: Order): void`

**Contract**: PURE function (no I/O, no side-effects, deterministic).

**Checks** (fail-fast order):
1. `receipt.orderId === order.id` → throw `IntegrityViolation('ORDER_MISMATCH', expected, actual)`
2. `receipt.currency === order.currency` → throw `IntegrityViolation('CURRENCY_MISMATCH', …)`
3. `sum(receipt.items[].price) === receipt.totalAmount` → throw `IntegrityViolation('TOTAL_MISMATCH', …)`

**Semantics**:
- `price` is already the line total; `quantity` is informational (ignored in sum)
- All amounts in cents (int); zero float tolerance
- No budget check (that's escrow's job via `spendingLimitCents`)

### `reconcileExtractedReceipt(ocrText: string, receipt: Receipt, order: Order): void`

**Contract**: PURE function; orchestrates OCR pipeline (defense-in-depth).

**Order** (mandatory):
1. `detectPromptInjection(ocrText)` → `IntegrityViolation('MANIPULATION_DETECTED')` if true
2. `verifyReceiptIntegrity(receipt, order)` → throws if any guard fails

**Rationale**: Hostile OCR text blocks release before parsing. A receipt whose source text is suspect is never reconciled, even if the structured form looks valid.

---

## Layer 3: Dispute Guard

**File**: `src/services/disputeGuard.ts`

### `guardReceiptForRelease(input: ReceiptGuardInput): Promise<ReceiptGuardResult>`

Links integrity verdict to escrow state and mission freeze.

**Contract**: Depends on I/O (tx client, alert sink injected for DI testability).

**Input**:
```typescript
{
  missionId: string
  actorId: string                      // initiator of auto-freeze
  receipt: Receipt
  order: Order
  escrowStatus: EscrowStatus           // current state
  ocrText?: string                     // if provided: full OCR pipeline; else integrity only
  client: { dispute: DisputeWriter }   // tx-aware Prisma (for createDisputeInTx + openDisputeInTx)
  alertSink?: AlertSink                // injectable (default: defaultAlertSink)
  reason?: string                      // custom reason for dispute (default: derived from violation code)
}
```

**Decision branches**:

| Escrow Status | Integrity | Decision | Effect |
|---|---|---|---|
| `HELD` | ✓ OK | `RELEASE_ALLOWED` | None; caller may release |
| `HELD` | ✗ Violation | `FROZEN` | createDisputeInTx + openDisputeInTx → DRAFT→OPEN; emit RECEIPT_INTEGRITY_VIOLATION (critical) |
| ≠ `HELD` | (any) | `NOT_GUARDABLE` | None; escrow decided elsewhere |

**Key invariants**:
- Escrow is NEVER mutated (compliant with `escrow-guard`)
- Violation → dispute freeze + alert (no silent failure)
- NOT_GUARDABLE → no surprise alert (escrow was already decided)
- Alert severity: `RECEIPT_INTEGRITY_VIOLATION` = `critical` (fonds gelés → arbitrage humain requis)

---

## Testing

### Unit Tests

**inputGuard.test.ts** (23 tests):
- JPEG metadata stripping: APP1/COM removed, DQT/SOS/EOI preserved
- PNG metadata stripping: tEXt/eXIf/tIME removed, IHDR/IDAT/IEND preserved
- Fail-closed: unknown format → `UnsupportedImageError`, malformed → `MalformedImageError`
- Adversarial inputs: zero-width obfuscation, fullwidth chars, fake system markers, amount-falsification
- False positives: realistic receipt text does not trigger

**receiptReconciliation.test.ts** (9 tests):
- Nominal: clean receipt passes
- ORDER_MISMATCH, CURRENCY_MISMATCH, TOTAL_MISMATCH guarded in order
- OCR pipeline: injection detected before reconciliation (MANIPULATION_DETECTED prime)
- OCR pipeline ordering: sain text allows integrity check; injection blocks even coherent receipt

**disputeGuard.test.ts** (5 tests):
- HELD + coherent → RELEASE_ALLOWED
- HELD + violation → FROZEN: litige ouvert + alerte
- Adversarial Input (MANIPULATION_DETECTED) → FROZEN
- Non-HELD escrow → NOT_GUARDABLE (no effect)
- Full pipeline: OCR sain + reçu cohérent → RELEASE_ALLOWED

**Full suite**: 261 passed / 50 files, zero regressions.

---

## Integration Notes

### When OCR Pipeline Exists

Routes handling receipt image extraction will:
1. Sanitize via `sanitizeVisionInput(imageBuffer)`
2. Extract text via OCR library
3. Parse into structured `Receipt`
4. Call `reconcileExtractedReceipt(ocrText, receipt, order)` before release

OR (transactional):
1. Validate via Zod schema (boundary check)
2. Call `guardReceiptForRelease(…)` inside `prisma.$transaction`
3. Only release if `decision === 'RELEASE_ALLOWED'`

### Conventions Respected

- ✓ Integer cents everywhere (no Float)
- ✓ Pure functions stay pure (verifyReceiptIntegrity, reconcileExtractedReceipt, detectPromptInjection)
- ✓ Zod validates at route boundary
- ✓ Escrow immutability (never mutated inside guards)
- ✓ Errors SNAKE_CASE (ORDER_MISMATCH, TOTAL_MISMATCH, MANIPULATION_DETECTED)
- ✓ Alert severity correct (RECEIPT_INTEGRITY_VIOLATION = critical)
- ✓ DI-based design (client + sink injected → unit-testable)

---

## Architecture Decision Record

### Why three layers?

**Defense-in-depth**:
- Layer 1 (Input Guard) removes exfiltration vectors and detects adversarial text before it reaches the parser
- Layer 2 (Reconciliation) pure checks don't trust Layer 1 (defense-in-depth: injection *before* integrity)
- Layer 3 (Dispute Guard) enforces monetary consequence (freeze) for integrity violations, not silent errors

### Why not re-encode pixels?

Pixel-domain steganography detection would require full image reprocessing (heavy dependency, computational cost). Segment-level metadata stripping is the appropriate scope for a lightweight guard.

### Why is `price` line-total, not unit price?

Waylo receipts are scanned from physical documents. A line item is "1x Widget @€15 = €15 EUR". The `price` field captures the line total (what the merchant charged). `quantity` is metadata for future decomposition when/if needed.

### Why DI (injected client + sink) in disputeGuard?

Keeps dispute creation and alerting testable without a live DB. The guard can be unit-tested with mock clients and mock sinks, ensuring correctness before production.

---

## Files & Metrics

| File | Lines | Purpose |
|---|---|---|
| `src/types/receipt.ts` | 21 | Receipt, ReceiptItem, Order interfaces |
| `src/schemas/receipt.ts` | 19 | Zod schema (boundary validation) |
| `src/services/inputGuard.ts` | 240 | Metadata stripper + injection detector |
| `src/services/receiptReconciliation.ts` | 71 | Pure reconciliation logic |
| `src/services/disputeGuard.ts` | 112 | Integrity verdict → freeze + alert |
| Test files | 247 | inputGuard (23), reconciliation (9), disputeGuard (5) |
| **Total** | **~710** | **All new (no existing code modified except alerts.ts)** |

**Dependencies added**: `zod` (runtime, for schema validation at boundaries).

---

**Last updated**: 2026-06-21  
**Status**: Merged to main (#18), all tests passing  
**Author**: Claude Sonnet 4.6 (multi-agent adversarial review)
