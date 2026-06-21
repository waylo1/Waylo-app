import { z } from 'zod'

const itemSchema = z.object({
  name: z.string(),
  price: z.number().int().nonnegative(),
  quantity: z.number().int().positive().optional(),
})

export const receiptSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  totalAmount: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  merchantName: z.string(),
  date: z.string().datetime(),
  items: z.array(itemSchema).nonempty(),
})

export type ReceiptInput = z.infer<typeof receiptSchema>
