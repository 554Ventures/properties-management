// App shell: skip link first in DOM, <nav aria-label="Main"> (SideNav),
// <main id="main">, mobile BottomTabBar, and the toast live region. Route
// changes get a subtle fade/slide that respects prefers-reduced-motion.
//
// The global assistant drawer (build-order task 9) mounts here as an <aside>,
// toggled via layout state / `?chat=open` (ChatProvider). At xl the open
// drawer is a docked sibling — the content column shifts left instead of
// being covered.
import { Outlet, useLocation } from 'react-router-dom';
import { cx } from '../../lib/cx';
import { ChatProvider, useChat } from '../../state/chat';
import { ChatDrawer } from '../chat/ChatDrawer';
import { ChatLauncher } from '../chat/ChatLauncher';
import { ToastViewport } from '../ui/Toast';
import { BottomTabBar } from './BottomTabBar';
import { SideNav } from './SideNav';

function ShellLayout() {
  const location = useLocation();
  const { open } = useChat();
  return (
    <div className="min-h-screen bg-app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <SideNav />
      <div
        className={cx(
          'pb-24 transition-[padding] duration-slow ease-ease md:pb-0 md:pl-60',
          open && 'xl:pr-[420px]',
        )}
      >
        <main id="main" tabIndex={-1} className="w-full px-4 py-6 outline-none md:px-8 md:py-8">
          <div key={location.pathname} className="animate-page-enter">
            <Outlet />
          </div>
        </main>
      </div>
      <BottomTabBar />
      <ChatLauncher />
      <ChatDrawer />
      <ToastViewport />
    </div>
  );
}

export function AppShell() {
  return (
    <ChatProvider>
      <ShellLayout />
    </ChatProvider>
  );
}
