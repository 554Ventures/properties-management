// Mobile tab bar (< md): Home / Money / Add / Rent / Tax (PRD §5.8).
import { NavLink } from 'react-router-dom';
import { cx } from '../../lib/cx';
import {
  IconCalendarCheck,
  IconDollar,
  IconFileText,
  IconHome,
  IconPlus,
} from '../ui/icons';

const tabs = [
  { to: '/', label: 'Home', icon: IconHome, end: true },
  { to: '/money', label: 'Money', icon: IconDollar, end: true },
  { to: '/money/new', label: 'Add', icon: IconPlus, add: true },
  { to: '/rent', label: 'Rent', icon: IconCalendarCheck },
  { to: '/reports', label: 'Tax', icon: IconFileText },
];

export function BottomTabBar() {
  return (
    <nav
      aria-label="Main menu"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="flex items-stretch justify-around">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <li key={tab.to} className="flex-1">
              <NavLink
                to={tab.to}
                end={tab.end}
                className={({ isActive }) =>
                  cx(
                    'flex flex-col items-center gap-0.5 py-2 text-[0.6875rem] font-medium transition-colors duration-fast',
                    tab.add
                      ? 'text-brand'
                      : isActive
                        ? 'text-brand'
                        : 'text-ink-muted hover:text-ink',
                  )
                }
              >
                {tab.add ? (
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-brand text-ink-on-brand">
                    <Icon size={16} />
                  </span>
                ) : (
                  <Icon size={20} />
                )}
                {tab.label}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
