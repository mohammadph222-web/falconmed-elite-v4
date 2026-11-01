import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import AppShell from './components/AppShell';
import { FullScreenMessage, PageLoader } from './components/States';
import Login from './pages/Login';
import Signup from './pages/Signup';
import { ForgotPassword, ResetPassword, VerifyEmail } from './pages/AuthLinks';
import { HOME } from './lib/routes';
import { ForcedPasswordChange } from './pages/AccountPage';

const PharmacistPage = lazy(() => import('./pages/PharmacistPage'));
const ManagerPage = lazy(() => import('./pages/ManagerPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const LiveQueuePage = lazy(() => import('./pages/LiveQueuePage'));
const SimulatorPage = lazy(() => import('./pages/SimulatorPage'));
const ImportPage = lazy(() => import('./pages/ImportPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const AccountPage = lazy(() => import('./pages/AccountPage'));
const BillingPage = lazy(() => import('./pages/BillingPage'));
const Terms = lazy(() => import('./pages/Legal').then((m) => ({ default: m.Terms })));
const Privacy = lazy(() => import('./pages/Legal').then((m) => ({ default: m.Privacy })));

function RequireRole({ roles, children }) {
  const { user } = useAuth();
  if (!roles.includes(user.role)) return <Navigate to={HOME[user.role]} replace />;
  return children;
}

/**
 * The product pages need an active trial or subscription. Admins are sent to
 * Billing to sort it out; everyone else is told to ask an admin.
 */
function RequirePlan({ children }) {
  const { user, logout } = useAuth();
  if (user.entitled !== false) return children;
  if (user.role === 'admin') return <Navigate to="/billing" replace />;
  return (
    <FullScreenMessage
      title={user.entitlementReason === 'trial_ended' ? 'The free trial has ended' : 'The subscription is not active'}
      body={`${user.orgName}’s data is safe. Ask your organisation admin to choose a plan under Billing, then sign in again.`}
      action={{ label: 'Sign out', onClick: logout }}
    />
  );
}

// Pages that work with or without a session: legal text and links from emails.
const publicRoutes = [
  <Route key="terms" path="/terms" element={<Suspense fallback={<PageLoader />}><Terms /></Suspense>} />,
  <Route key="privacy" path="/privacy" element={<Suspense fallback={<PageLoader />}><Privacy /></Suspense>} />,
  <Route key="reset" path="/reset-password" element={<ResetPassword />} />,
  <Route key="verify" path="/verify-email" element={<VerifyEmail />} />,
];

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
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        {publicRoutes}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  // A temporary password must be replaced before anything else.
  if (user.mustChangePassword) return <ForcedPasswordChange />;

  const product = (roles, page) => (
    <RequireRole roles={roles}>
      <RequirePlan>{page}</RequirePlan>
    </RequireRole>
  );

  return (
    <Routes>
      {publicRoutes}
      <Route
        path="*"
        element={
          <AppShell>
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path="/counter" element={product(['pharmacist'], <PharmacistPage />)} />
                <Route path="/branch" element={product(['manager'], <ManagerPage />)} />
                <Route path="/network" element={product(['admin'], <AdminPage />)} />
                <Route path="/live" element={product(['manager', 'admin'], <LiveQueuePage />)} />
                <Route path="/simulator" element={product(['manager', 'admin'], <SimulatorPage />)} />
                <Route path="/import" element={product(['manager', 'admin'], <ImportPage />)} />
                <Route path="/settings" element={<RequireRole roles={['admin']}><SettingsPage /></RequireRole>} />
                <Route path="/billing" element={<RequireRole roles={['admin']}><BillingPage /></RequireRole>} />
                <Route path="/account" element={<AccountPage />} />
                <Route path="*" element={<Navigate to={HOME[user.role]} replace />} />
              </Routes>
            </Suspense>
          </AppShell>
        }
      />
    </Routes>
  );
}
