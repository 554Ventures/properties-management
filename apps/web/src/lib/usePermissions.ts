// Client-side write-UI gating (docs/WHATS_NEXT.md §4). The backend is the real
// authority (guarded routes return 403); this just hides/disables write
// affordances a member can't use. Owners — and demo mode, where /settings/me
// reports role 'owner' with every permission — pass every check. While the
// query is in flight we default permissive so an owner never sees their own
// buttons flicker out; the member view settles once the response lands.
import type { MemberPermission, UserRole } from '@hearth/shared';
import { useCurrentUser } from '../api/queries';

export interface Permissions {
  role: UserRole;
  isOwner: boolean;
  /** True if the user may perform writes in the given area. */
  can: (permission: MemberPermission) => boolean;
  loading: boolean;
}

export function usePermissions(): Permissions {
  const { data, isPending } = useCurrentUser();
  const role: UserRole = data?.role ?? 'owner';
  const isOwner = role === 'owner';
  const granted = data?.permissions ?? [];
  return {
    role,
    isOwner,
    can: (permission) => isOwner || granted.includes(permission),
    loading: isPending,
  };
}
