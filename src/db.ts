import { PrismaClient } from './generated/prisma'

/** Client Prisma Waylo (schéma racine prisma/schema.prisma, sortie src/generated/prisma). */
export const prisma = new PrismaClient()
