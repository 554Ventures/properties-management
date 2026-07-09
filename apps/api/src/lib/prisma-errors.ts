import { Prisma } from '@prisma/client';

/** Prisma P2002: an insert lost a unique-constraint race — catch and re-read/skip. */
export function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
