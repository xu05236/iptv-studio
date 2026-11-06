import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './lib/auth';
import { PortalLayout } from './layouts/PortalLayout';
import { AdminLayout } from './layouts/AdminLayout';

const Home = lazy(() => import('./pages/Home').then((module) => ({ default: module.Home })));
const Channels = lazy(() => import('./pages/Channels').then((module) => ({ default: module.Channels })));
const ChannelDetail = lazy(() => import('./pages/ChannelDetail').then((module) => ({ default: module.ChannelDetail })));
const Help = lazy(() => import('./pages/Help').then((module) => ({ default: module.Help })));
const Login = lazy(() => import('./pages/admin/Login').then((module) => ({ default: module.Login })));
const Dashboard = lazy(() => import('./pages/admin/Dashboard').then((module) => ({ default: module.Dashboard })));
const Sources = lazy(() => import('./pages/admin/Sources').then((module) => ({ default: module.Sources })));
const Epg = lazy(() => import('./pages/admin/Epg').then((module) => ({ default: module.Epg })));
const SourceDetail = lazy(() => import('./pages/admin/SourceDetail').then((module) => ({ default: module.SourceDetail })));
const Pool = lazy(() => import('./pages/admin/Pool').then((module) => ({ default: module.Pool })));
const ChannelsAdmin = lazy(() => import('./pages/admin/ChannelsAdmin').then((module) => ({ default: module.ChannelsAdmin })));
const Probe = lazy(() => import('./pages/admin/Probe').then((module) => ({ default: module.Probe })));
const SubscriptionsAdmin = lazy(() => import('./pages/admin/SubscriptionsAdmin').then((module) => ({ default: module.SubscriptionsAdmin })));
const Runs = lazy(() => import('./pages/admin/Runs').then((module) => ({ default: module.Runs })));
const SettingsPage = lazy(() => import('./pages/admin/Settings').then((module) => ({ default: module.SettingsPage })));
const Rules = lazy(() => import('./pages/admin/Rules').then((module) => ({ default: module.Rules })));

export function App() {
  return (
    <Suspense fallback={<div className="route-loading">加载中…</div>}>
      <Routes>
        <Route element={<PortalLayout />}>
          <Route path="/" element={<Home />} />
          <Route path="/channels" element={<Channels />} />
          <Route path="/channels/:id" element={<ChannelDetail />} />
          <Route path="/help" element={<Help />} />
        </Route>

        <Route path="/admin/login" element={<Login />} />
        <Route
          path="/admin"
          element={
            <RequireAuth>
              <AdminLayout />
            </RequireAuth>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="sources" element={<Sources />} />
          <Route path="epg" element={<Epg />} />
          <Route path="sources/:id" element={<SourceDetail />} />
          <Route path="pool" element={<Pool />} />
          <Route path="channels" element={<ChannelsAdmin />} />
          <Route path="probe" element={<Probe />} />
          <Route path="subscriptions" element={<SubscriptionsAdmin />} />
          <Route path="runs" element={<Runs />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="rules" element={<Rules />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
