export interface ReceiptItem {
  name: string
  price: number // cents, int — LINE TOTAL (not unit price)
  quantity?: number // metadata: future decomposition (verifyReceiptIntegrity sums price, not price * quantity)
}

export interface Receipt {
  id: string
  orderId: string
  totalAmount: number // cents, int
  currency: string // ISO 4217
  merchantName: string
  date: string // ISO 8601
  items: ReceiptItem[]
}

/** Minimum de l'entité « commande » requis pour la réconciliation. */
export interface Order {
  id: string
  currency: string // ISO 4217
}
