// Desktop navigation spine (hidden below md; BottomTabBar takes over).
import { NavLink } from 'react-router-dom';
import { cx } from '../../lib/cx';
import { useAuth } from '../../state/auth';
import {
  IconBuilding,
  IconCalendarCheck,
  IconDollar,
  IconFileText,
  IconGear,
  IconHome,
  IconSparkle,
  IconUsers,
} from '../ui/icons';

interface NavItem {
  to: string;
  label: string;
  icon: (props: { size?: number }) => JSX.Element;
  end?: boolean;
  ai?: boolean;
}

const items: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: IconHome, end: true },
  { to: '/properties', label: 'Properties', icon: IconBuilding },
  { to: '/tenants', label: 'Tenants & Leases', icon: IconUsers },
  { to: '/money', label: 'Money', icon: IconDollar },
  { to: '/rent', label: 'Rent Collection', icon: IconCalendarCheck },
  { to: '/reports', label: 'Reports & Tax', icon: IconFileText },
  { to: '/insights', label: 'AI Insights', icon: IconSparkle, ai: true },
];

function navLinkClasses(isActive: boolean, ai?: boolean): string {
  return cx(
    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors duration-fast',
    isActive
      ? 'bg-brand-soft text-brand'
      : cx('text-ink-muted hover:bg-surface-sunken hover:text-ink', ai && 'text-ink-ai hover:text-ink-ai'),
  );
}

function NavItemLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink to={item.to} end={item.end} className={({ isActive }) => navLinkClasses(isActive, item.ai)}>
      <Icon size={18} />
      <span>
        {item.ai && <span aria-hidden="true">✦ </span>}
        {item.label}
      </span>
    </NavLink>
  );
}

export function SideNav() {
  const { enabled, signOut } = useAuth();
  return (
    <nav
      aria-label="Main"
      className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-surface md:flex"
    >
      <div className="flex items-center gap-2.5 px-5 py-5">
        <span
          aria-hidden="true"
          className="grid h-8 w-8 place-items-center rounded-md bg-brand text-base font-bold text-ink-on-brand"
        >
          H
        </span>
        <span className="text-lg font-semibold tracking-tight text-ink">Hearth</span>
      </div>
      <ul className="flex flex-1 flex-col gap-1 px-3">
        {items.map((item) => (
          <li key={item.to}>
            <NavItemLink item={item} />
          </li>
        ))}
      </ul>
      {/* Settings (and sign out, in auth mode) pinned to the bottom */}
      <ul className="border-t border-border px-3 py-3">
        <li>
          <NavItemLink item={{ to: '/settings', label: 'Settings', icon: IconGear }} />
        </li>
        {enabled && (
          <li>
            <button
              type="button"
              onClick={() => void signOut()}
              className={cx(navLinkClasses(false), 'w-full')}
            >
              Sign out
            </button>
          </li>
        )}
      </ul>
    </nav>
  );
}
