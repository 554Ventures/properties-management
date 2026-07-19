// Single source of truth for the app's navigation destinations. Both the
// desktop SideNav and the mobile BottomTabBar (+ its "More" sheet) derive from
// this list so the two surfaces can never drift apart.
import {
  IconBuilding,
  IconCalendarCheck,
  IconDollar,
  IconFileText,
  IconGear,
  IconHome,
  IconWrench,
} from '../ui/icons';

export interface NavItem {
  to: string;
  label: string;
  /** Compact label for the mobile bottom-bar tab (falls back to `label`). */
  shortLabel?: string;
  icon: (props: { size?: number }) => JSX.Element;
  end?: boolean;
  ai?: boolean;
}

export const navItems: NavItem[] = [
  { to: '/', label: 'Dashboard', shortLabel: 'Home', icon: IconHome, end: true },
  { to: '/properties', label: 'Properties', icon: IconBuilding },
  { to: '/maintenance/contractors', label: 'Maintenance', icon: IconWrench },
  { to: '/money', label: 'Money', icon: IconDollar },
  { to: '/rent', label: 'Rent Collection', shortLabel: 'Rent', icon: IconCalendarCheck },
  { to: '/documents', label: 'Documents', icon: IconFileText },
  { to: '/reports', label: 'Reports & Tax', icon: IconFileText },
];

// Settings (and Sign out, in auth mode) are pinned separately at the bottom of
// both surfaces rather than living inline in the destination list.
// The "Send feedback" trigger is also not a destination — it's a shell-level
// button (AppShell passes onFeedbackClick to SideNav/BottomTabBar).
export const settingsItem: NavItem = { to: '/settings', label: 'Settings', icon: IconGear };

// Paths surfaced directly as mobile bottom-bar tabs; every other destination
// falls into the "More" sheet. (The center "Add" button is a quick action, not
// a destination, so it isn't part of navItems.)
export const MOBILE_PRIMARY: readonly string[] = ['/', '/money', '/rent'];
