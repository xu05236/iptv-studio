import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  ClipboardList,
  Gauge,
  ListVideo,
  LogOut,
  RadioTower,
  Settings,
  SlidersHorizontal,
  Tv,
  Users,
} from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../lib/auth';
import { ThemeToggle } from '../components/ThemeToggle';
import { UsageAlert } from '../components/UsageAlert';

const LINKS = [
  { to: '/admin', label: '概览', icon: Gauge, end: true },
  { to: '/admin/sources', label: '采集站', icon: RadioTower },
  { to: '/admin/channels', label: '频道', icon: Tv },
  { to: '/admin/probe', label: '检测中心', icon: SlidersHorizontal },
  { to: '/admin/subscriptions', label: '订阅与导出', icon: Users },
  { to: '/admin/runs', label: '运行与日志', icon: ClipboardList },
  { to: '/admin/settings', label: '设置', icon: Settings },
];

export function AdminLayout() {
  const { logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="admin">
      <aside className="sidebar">
        <div className="topbar__brand" style={{ padding: '0 10px 18px' }}>
          <span className="brand-mark">
            <ListVideo size={15} />
          </span>
          <div>
            <div style={{ fontSize: 15 }}>IPTV Studio</div>
            <div className="caption">管理后台</div>
          </div>
        </div>

        {LINKS.map((link) => {
          const Icon = link.icon;
          return (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) => clsx('sidebar__link', isActive && 'sidebar__link--active')}
            >
              <Icon size={17} />
              {link.label}
            </NavLink>
          );
        })}

        <div className="grow" />
        <NavLink to="/" className="sidebar__link">
          <Tv size={17} /> 返回前台
        </NavLink>
        <button
          className="sidebar__link"
          onClick={() => {
            logout();
            navigate('/admin/login');
          }}
          style={{ textAlign: 'left', width: '100%' }}
        >
          <LogOut size={17} /> 退出登录
        </button>
      </aside>

      <div className="admin__main">
        <header className="topbar" style={{ position: 'sticky' }}>
          <div className="topbar__brand" style={{ fontSize: 15 }}>
            管理后台
          </div>
          <div className="grow" />
          <ThemeToggle compact />
          <button
            className="btn btn--sm"
            onClick={() => {
              logout();
              navigate('/admin/login');
            }}
          >
            退出
          </button>
        </header>

        <nav className="admin-mobile-nav">
          {LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) => clsx('chip', isActive && 'chip--active')}
            >
              {link.label}
            </NavLink>
          ))}
        </nav>

        <div className="page page--admin">
          <UsageAlert />
          <Outlet />
        </div>
      </div>
    </div>
  );
}
