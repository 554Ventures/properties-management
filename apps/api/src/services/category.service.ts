import type { Category, CreateCategoryInput, TransactionType } from '@hearth/shared';
import { prisma } from '../lib/prisma';
import type { Category as DbCategory } from '@prisma/client';

export function toApiCategory(c: DbCategory): Category {
  return {
    id: c.id,
    accountId: c.accountId,
    name: c.name,
    type: c.type as TransactionType,
    irsScheduleELine: c.irsScheduleELine,
    isSystem: c.isSystem,
  };
}

/** System categories plus the account's own. */
export async function list(accountId: string): Promise<Category[]> {
  const rows = await prisma.category.findMany({
    where: { OR: [{ isSystem: true }, { accountId }] },
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
  });
  return rows.map(toApiCategory);
}

export async function create(accountId: string, input: CreateCategoryInput): Promise<Category> {
  const row = await prisma.category.create({
    data: {
      accountId,
      name: input.name,
      type: input.type,
      irsScheduleELine: input.irsScheduleELine ?? null,
      isSystem: false,
    },
  });
  return toApiCategory(row);
}
