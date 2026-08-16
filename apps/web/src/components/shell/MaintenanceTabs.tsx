// Sibling section tabs joining the two Maintenance surfaces: work orders
// (/maintenance) and the contractor directory (/maintenance/contractors).
// Renders on the two index pages only — detail pages (a work order, a
// contractor) drop it in favor of their own breadcrumb trail back here.
import { NavLink } from 'react-router';
import { cx } from '../../lib/cx';

const TABS = [
  { to: '/maintenance', label: 'Work orders', end: true },
  { to: '/maintenance/contractors', label: 'Contractors', end: false },
] as const;

export function MaintenanceTabs() {
  return (
    <nav aria-label="Maintenance sections" className="flex gap-4 border-b border-border">
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) =>
            cx(
              '-mb-px border-b-2 px-1 py-2.5 text-sm font-medium transition-colors duration-fast',
              isActive
                ? 'border-brand text-brand'
                : 'border-transparent text-ink-muted hover:text-ink',
            )
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
