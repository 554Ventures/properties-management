// Desktop navigation spine (hidden below md; BottomTabBar takes over).
import { cx } from '../../lib/cx';
import { useAuth } from '../../state/auth';
import { IconMail } from '../ui/icons';
import { navItems, settingsItem } from './navItems';
import { NavItemLink, navLinkClasses } from './navLink';

export function SideNav({ onFeedbackClick }: { onFeedbackClick?: () => void }) {
  const { enabled, signOut } = useAuth();
  return (
    <nav
      aria-label="Main"
      className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-surface md:flex"
    >
      <div className="flex items-center gap-2.5 px-5 py-6">
        <img src="/logo.svg" alt="" aria-hidden="true" className="h-8 w-8 rounded-md" />
        <span className="text-[15px] font-semibold tracking-tight text-ink">554 Properties</span>
      </div>
      <ul className="flex flex-1 flex-col gap-1 px-3">
        {navItems.map((item) => (
          <li key={item.to}>
            <NavItemLink item={item} />
          </li>
        ))}
      </ul>
      {/* Feedback + Settings (and sign out, in auth mode) pinned to the bottom */}
      <ul className="border-t border-border px-3 py-3">
        {onFeedbackClick && (
          <li>
            <button
              type="button"
              onClick={onFeedbackClick}
              className={cx(navLinkClasses(false), 'w-full')}
            >
              <IconMail size={18} />
              Send feedback
            </button>
          </li>
        )}
        <li>
          <NavItemLink item={settingsItem} />
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
