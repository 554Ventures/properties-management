// Prisma client singleton. DATABASE_URL comes from apps/api/.env (default
// "file:./dev.db", resolved relative to prisma/schema.prisma) or the process
// env (tests point it at a throwaway file).
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
