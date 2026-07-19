// Mobile tab bar (< md): Home / Money / Add / Rent / More. The first three
// destinations are the MOBILE_PRIMARY paths from the shared nav list; "More"
// opens a bottom sheet with every remaining destination (+ Settings/Sign out),
// so nothing in the desktop sidebar is unreachable on mobile.
import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { cx } from '../../lib/cx';
import { useAuth } from '../../state/auth';
import { BottomSheet } from '../ui/BottomSheet';
import { IconMail, IconMore, IconPlus } from '../ui/icons';
import { MOBILE_PRIMARY, navItems, settingsItem, type NavItem } from './navItems';
import { NavItemLink, navLinkClasses } from './navLink';

// Destinations surfaced directly as tabs, in bar order.
const primaryTabs: NavItem[] = MOBILE_PRIMARY.map(
  (path) => navItems.find((item) => item.to === path)!,
);
// Everything else lives behind "More" (Settings appended, matching the sidebar).
const overflowItems: NavItem[] = [
  ...navItems.filter((item) => !MOBILE_PRIMARY.includes(item.to)),
  settingsItem,
];

function tabClasses(isActive: boolean): string {
  return cx(
    'flex flex-col items-center gap-0.5 py-2 text-[0.6875rem] font-medium transition-colors duration-fast',
    isActive ? 'text-brand' : 'text-ink-muted hover:text-ink',
  );
}

function isPathActive(pathname: string, item: NavItem): boolean {
  return item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`);
}

export function BottomTabBar({ onFeedbackClick }: { onFeedbackClick?: () => void }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const { pathname } = useLocation();
  const { enabled, signOut } = useAuth();

  // "More" reflects the active route whenever you're on one of its destinations.
  const overflowActive = overflowItems.some((item) => isPathActive(pathname, item));

  return (
    <>
      <nav
        aria-label="Main menu"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] md:hidden"
      >
        <ul className="flex items-stretch justify-around">
          <TabLink item={primaryTabs[0]!} />
          <TabLink item={primaryTabs[1]!} />
          <li className="flex-1">
            <NavLink
              to="/money/new"
              className={() => cx(tabClasses(false), 'text-brand')}
            >
              <span className="grid h-7 w-7 place-items-center rounded-full bg-brand text-ink-on-brand">
                <IconPlus size={16} />
              </span>
              Add
            </NavLink>
          </li>
          <TabLink item={primaryTabs[2]!} />
          <li className="flex-1">
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              className={cx(tabClasses(overflowActive), 'w-full')}
            >
              <IconMore size={20} />
              More
            </button>
          </li>
        </ul>
      </nav>

      <BottomSheet open={moreOpen} onClose={() => setMoreOpen(false)} label="More menu" title="More">
        <ul className="flex flex-col gap-1">
          {overflowItems.map((item) => (
            <li key={item.to}>
              <NavItemLink item={item} onNavigate={() => setMoreOpen(false)} />
            </li>
          ))}
          {onFeedbackClick && (
            <li className="mt-1 border-t border-border pt-1">
              <button
                type="button"
                onClick={() => {
                  // Close the sheet first — the feedback modal takes over focus.
                  setMoreOpen(false);
                  onFeedbackClick();
                }}
                className={cx(navLinkClasses(false), 'w-full')}
              >
                <IconMail size={18} />
                Send feedback
              </button>
            </li>
          )}
          {enabled && (
            <li className="mt-1 border-t border-border pt-1">
              <button
                type="button"
                onClick={() => {
                  setMoreOpen(false);
                  void signOut();
                }}
                className={cx(navLinkClasses(false), 'w-full')}
              >
                Sign out
              </button>
            </li>
          )}
        </ul>
      </BottomSheet>
    </>
  );
}

function TabLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <li className="flex-1">
      <NavLink to={item.to} end={item.end} className={({ isActive }) => tabClasses(isActive)}>
        <Icon size={20} />
        {item.shortLabel ?? item.label}
      </NavLink>
    </li>
  );
}
