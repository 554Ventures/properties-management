// App shell: skip link first in DOM, <nav aria-label="Main"> (SideNav),
// <main id="main">, mobile BottomTabBar, and the toast live region. Route
// changes get a subtle fade/slide that respects prefers-reduced-motion.
//
// TODO(chat-drawer, build-order task 9): the global assistant drawer mounts
// here as an <aside> and is toggled via layout state / `?chat=open`.
import { Outlet, useLocation } from 'react-router-dom';
import { ToastViewport } from '../ui/Toast';
import { BottomTabBar } from './BottomTabBar';
import { SideNav } from './SideNav';

export function AppShell() {
  const location = useLocation();
  return (
    <div className="min-h-screen bg-app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <SideNav />
      <div className="pb-24 md:pb-0 md:pl-60">
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl px-4 py-6 outline-none md:px-8 md:py-8">
          <div key={location.pathname} className="animate-page-enter">
            <Outlet />
          </div>
        </main>
      </div>
      <BottomTabBar />
      <ToastViewport />
    </div>
  );
}
