// Team / multi-user account contract (docs/WHATS_NEXT.md §4 "Multi-user
// teams/roles"). An account owner invites teammates by email; the teammate
// signs up with that same email via the normal Supabase flow and is attached
// to the owner's account. Seats are capped (SEAT_LIMIT) with an upgrade CTA
// stub beyond the cap. The owner grants each member a set of MemberPermissions.
import { z } from 'zod';
import { MemberPermissionSchema, UserRoleSchema } from '../enums';

/** Max users per account (owner + members) before the pay gate. */
export const SEAT_LIMIT = 2;

// An active user in the account (has signed in at least once → has a User row).
export const AccountMemberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  role: UserRoleSchema,
  permissions: z.array(MemberPermissionSchema), // empty for a member with no grants; owners hold all implicitly
  createdAt: z.string().datetime(),
});
export type AccountMember = z.infer<typeof AccountMemberSchema>;

// An invited email that hasn't signed in yet (no User row).
export const PendingInviteSchema = z.object({
  id: z.string(),
  email: z.string(),
  permissions: z.array(MemberPermissionSchema),
  createdAt: z.string().datetime(),
});
export type PendingInvite = z.infer<typeof PendingInviteSchema>;

// GET /team
export const TeamResponseSchema = z.object({
  members: z.array(AccountMemberSchema),
  pendingInvites: z.array(PendingInviteSchema),
  seatsUsed: z.number().int(), // active members + pending invites
  seatLimit: z.number().int(),
});
export type TeamResponse = z.infer<typeof TeamResponseSchema>;

// POST /team/invites
export const InviteMemberInputSchema = z.object({
  email: z.string().email(),
  permissions: z.array(MemberPermissionSchema).default([]),
});
export type InviteMemberInput = z.infer<typeof InviteMemberInputSchema>;

// PATCH /team/members/:userId
export const UpdateMemberInputSchema = z.object({
  permissions: z.array(MemberPermissionSchema),
});
export type UpdateMemberInput = z.infer<typeof UpdateMemberInputSchema>;

// GET /settings/me — the authenticated user's own role + granted permissions,
// so the web app can gate its own write affordances. In demo mode (no auth)
// the API returns role 'owner' with all permissions.
export const CurrentUserSchema = z.object({
  userId: z.string().nullable(), // null in demo mode (no User row)
  role: UserRoleSchema,
  permissions: z.array(MemberPermissionSchema),
});
export type CurrentUser = z.infer<typeof CurrentUserSchema>;
