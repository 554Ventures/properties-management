// Shared nav-link presentation used by both the desktop SideNav and the mobile
// "More" sheet, so active/hover states and the AI-violet styling for AI Insights
// stay identical across surfaces.
import { NavLink } from 'react-router-dom';
import { cx } from '../../lib/cx';
import type { NavItem } from './navItems';

export function navLinkClasses(isActive: boolean, ai?: boolean): string {
  return cx(
    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors duration-fast',
    isActive
      ? 'bg-brand-soft text-brand'
      : cx('text-ink-muted hover:bg-surface-sunken hover:text-ink', ai && 'text-ink-ai hover:text-ink-ai'),
  );
}

export function NavItemLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) => navLinkClasses(isActive, item.ai)}
    >
      <Icon size={18} />
      <span>
        {item.ai && <span aria-hidden="true">✦ </span>}
        {item.label}
      </span>
    </NavLink>
  );
}
