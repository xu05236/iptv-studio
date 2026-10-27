import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { House, Radio, SlidersHorizontal, Tv } from 'lucide-react';
import clsx from 'clsx';
import { ThemeToggle } from '../components/ThemeToggle';

const TABS = [
  { to: '/', label: '首页', icon: House },
  { to: '/channels', label: '频道', icon: Tv },
  { to: '/admin', label: '管理', icon: SlidersHorizontal },
];

export function PortalLayout() {
  const location = useLocation();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = (): void => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="shell">
      <header className={clsx('topbar', scrolled && 'topbar--scrolled')}>
        <div className="topbar__brand">
          <span className="brand-mark">
            <Radio size={15} />
          </span>
          <span>IPTV Studio</span>
        </div>
        <nav className="topnav">
          <NavLink to="/" end className={({ isActive }) => clsx('topnav__link', isActive && 'topnav__link--active')}>
            首页
          </NavLink>
          <NavLink to="/channels" className={({ isActive }) => clsx('topnav__link', isActive && 'topnav__link--active')}>
            频道
          </NavLink>
          <NavLink to="/admin" className={({ isActive }) => clsx('topnav__link', isActive && 'topnav__link--active')}>
            管理后台
          </NavLink>
        </nav>
        <div className="grow" />
        <ThemeToggle compact />
      </header>

      <main className="page" key={location.pathname}>
        <Outlet />
      </main>

      <nav className="tabbar">
        {TABS.map((tab) => {
          const active = tab.to === '/' ? location.pathname === '/' : location.pathname.startsWith(tab.to);
          const Icon = tab.icon;
          return (
            <NavLink key={tab.to} to={tab.to} className={clsx('tabbar__item', active && 'tabbar__item--active')}>
              <Icon size={22} strokeWidth={active ? 2.4 : 1.9} />
              <span>{tab.label}</span>
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
