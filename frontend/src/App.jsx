import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import AppShell from './components/AppShell';
import { FullScreenMessage, PageLoader } from './components/States';
import Login from './pages/Login';
import { HOME } from './lib/routes';

const PharmacistPage = lazy(() => import('./pages/PharmacistPage'));
const ManagerPage = lazy(() => import('./pages/ManagerPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const LiveQueuePage = lazy(() => import('./pages/LiveQueuePage'));
const SimulatorPage = lazy(() => import('./pages/SimulatorPage'));


function RequireRole({ roles, children }) {
  const { user } = useAuth();
  if (!roles.includes(user.role)) return <Navigate to={HOME[user.role]} replace />;
  return children;
}

export default function App() {
  const { user, status, retry } = useAuth();

  if (status === 'checking') return <FullScreenMessage title="Restoring your session…" spinner />;
  if (status === 'offline')
    return (
      <FullScreenMessage
        title="Server unreachable"
        body="The API did not respond. If it is on a free hosting tier it may be waking up."
        action={{ label: 'Try again', onClick: retry }}
      />
    );

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <AppShell>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/counter" element={<RequireRole roles={['pharmacist']}><PharmacistPage /></RequireRole>} />
          <Route path="/branch" element={<RequireRole roles={['manager']}><ManagerPage /></RequireRole>} />
          <Route path="/network" element={<RequireRole roles={['admin']}><AdminPage /></RequireRole>} />
          <Route path="/live" element={<RequireRole roles={['manager', 'admin']}><LiveQueuePage /></RequireRole>} />
          <Route path="/simulator" element={<RequireRole roles={['manager', 'admin']}><SimulatorPage /></RequireRole>} />
          <Route path="*" element={<Navigate to={HOME[user.role]} replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}
