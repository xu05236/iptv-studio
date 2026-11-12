import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import {
  Activity,
  CalendarClock,
  ClipboardList,
  Gauge,
  Globe2,
  Layers3,
  ListFilter,
  ListVideo,
  LogOut,
  RadioTower,
  Settings,
  Share2,
  SlidersHorizontal,
  Tv,
} from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { ThemeToggle } from '../components/ThemeToggle';
import { UsageAlert } from '../components/UsageAlert';

const GROUPS = [
  {
    label: '总览',
    links: [{ to: '/admin', label: '概览', icon: Gauge, end: true }],
  },
  {
    label: '内容管理',
    links: [
      { to: '/admin/sources', label: '采集站', icon: RadioTower, end: false },
      { to: '/admin/pool', label: '线路池', icon: Layers3, end: false },
      { to: '/admin/channels', label: '频道', icon: Tv, end: false },
      { to: '/admin/epg', label: 'EPG', icon: CalendarClock, end: false },
    ],
  },
  {
    label: '运营发布',
    links: [
      { to: '/admin/probe', label: '检测中心', icon: SlidersHorizontal, end: false },
      { to: '/admin/proxies', label: '国内代理', icon: Globe2, end: false },
      { to: '/admin/subscriptions', label: '订阅与导出', icon: Share2, end: false },
      { to: '/admin/events', label: '运营事件', icon: Activity, end: false },
    ],
  },
  {
    label: '系统',
    links: [
      { to: '/admin/runs', label: '运行与日志', icon: ClipboardList, end: false },
      { to: '/admin/rules', label: '规则', icon: ListFilter, end: false },
      { to: '/admin/settings', label: '设置', icon: Settings, end: false },
    ],
  },
];

const LINKS = GROUPS.flatMap((group) => group.links);

const PAGE_TITLES: Record<string, string> = {
  '/admin': '概览',
  '/admin/sources': '采集站',
  '/admin/pool': '线路池',
  '/admin/channels': '频道',
  '/admin/epg': 'EPG 节目单',
  '/admin/probe': '检测中心',
  '/admin/proxies': '国内代理',
  '/admin/subscriptions': '订阅与导出',
  '/admin/events': '运营事件',
  '/admin/runs': '运行与日志',
  '/admin/rules': '规则',
  '/admin/settings': '设置',
};

export function AdminLayout() {
  const { logout } = useAuth();
  const [version, setVersion] = useState<{ shortCommit?: string; deployedAt?: string | null } | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<{ shortCommit: string; deployedAt: string | null }>('/api/version')
      .then((data) => {
        if (alive) setVersion(data);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const navigate = useNavigate();
  const location = useLocation();
  const currentTitle = PAGE_TITLES[location.pathname] ?? '管理后台';

  return (
    <div className="admin">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <span className="brand-mark">
            <ListVideo size={16} />
          </span>
          <div>
            <div className="sidebar__brand-name">IPTV Studio</div>
            <div className="caption">管理后台</div>
          </div>
        </div>

        <div className="sidebar__nav">
          {GROUPS.map((group) => (
            <div className="sidebar__group" key={group.label}>
              <div className="sidebar__title">{group.label}</div>
              {group.links.map((link) => {
                const Icon = link.icon;
                return (
                  <NavLink
                    key={link.to}
                    to={link.to}
                    end={link.end === true}
                    className={({ isActive }) => clsx('sidebar__link', isActive && 'sidebar__link--active')}
                  >
                    <Icon size={17} />
                    {link.label}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </div>

        <div className="sidebar__footer">
          {version?.shortCommit ? (
            <div className="caption" title={version.deployedAt ? `部署于 ${version.deployedAt}` : undefined} style={{ padding: '0 10px 6px' }}>
              版本 {version.shortCommit}
            </div>
          ) : null}
          <NavLink to="/" className="sidebar__link">
            <Tv size={17} /> 返回前台
          </NavLink>
          <button
            className="sidebar__link sidebar__link--button"
            onClick={() => {
              logout();
              navigate('/admin/login');
            }}
          >
            <LogOut size={17} /> 退出登录
          </button>
        </div>
      </aside>

      <div className="admin__main">
        <header className="topbar admin-topbar">
          <div className="admin-topbar__title">
            <span className="caption">管理后台</span>
            <strong>{currentTitle}</strong>
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
              end={link.end === true}
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
