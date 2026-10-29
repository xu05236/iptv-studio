import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './lib/auth';
import { PortalLayout } from './layouts/PortalLayout';
import { AdminLayout } from './layouts/AdminLayout';
import { Home } from './pages/Home';
import { Channels } from './pages/Channels';
import { ChannelDetail } from './pages/ChannelDetail';
import { Login } from './pages/admin/Login';
import { Dashboard } from './pages/admin/Dashboard';
import { Sources } from './pages/admin/Sources';
import { Pool } from './pages/admin/Pool';
import { ChannelsAdmin } from './pages/admin/ChannelsAdmin';
import { Probe } from './pages/admin/Probe';
import { SubscriptionsAdmin } from './pages/admin/SubscriptionsAdmin';
import { Runs } from './pages/admin/Runs';
import { SettingsPage } from './pages/admin/Settings';

export function App() {
  return (
    <Routes>
      <Route element={<PortalLayout />}>
        <Route path="/" element={<Home />} />
        <Route path="/channels" element={<Channels />} />
        <Route path="/channels/:id" element={<ChannelDetail />} />
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
        <Route path="pool" element={<Pool />} />
        <Route path="channels" element={<ChannelsAdmin />} />
        <Route path="probe" element={<Probe />} />
        <Route path="subscriptions" element={<SubscriptionsAdmin />} />
        <Route path="runs" element={<Runs />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
