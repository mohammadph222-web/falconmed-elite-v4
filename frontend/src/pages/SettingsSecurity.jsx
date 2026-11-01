import { useState } from 'react';
import { Check, Copy, Download, KeyRound, Plus, Trash2 } from 'lucide-react';
import { api, API_ORIGIN, apiDownload } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuth } from '../lib/auth';
import { useSubmit } from '../lib/useSubmit';
import { presetRange } from '../lib/dates';
import { Badge, Panel } from '../components/ui';
import { EmptyState, Spinner } from '../components/States';
import { Field, FormError, Modal } from '../components/Modal';

const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Never');

// ── queue keys ───────────────────────────────────────────────────
function NewKey({ branches, onCreated, onClose }) {
  const [name, setName] = useState('');
  const [branchId, setBranchId] = useState('');
  const [secret, setSecret] = useState(null);
  const [copied, setCopied] = useState(false);
  const save = useSubmit(async () => {
    const r = await api('/org/api-keys', { method: 'POST', body: { name, branchId: branchId || null } });
    setSecret(r.data.secret);
    onCreated();
  });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the key is still visible to copy by hand */
    }
  };

  if (secret) {
    return (
      <Modal title="Queue key created" onClose={onClose} footer={<button className="btn-primary" onClick={onClose}>Done</button>}>
        <div className="space-y-4">
          <p className="text-sm text-mist-300">
            Put this key in your queue machine’s settings. It is sent in the <code className="font-mono text-xs">X-Queue-Key</code> header to{' '}
            <code className="break-all font-mono text-xs">{API_ORIGIN}/api/queue/tickets</code>.
          </p>
          <div className="select-all break-all rounded-xl border border-ink-600 bg-ink-900 p-4 font-mono text-sm text-brand-200">{secret}</div>
          <button onClick={copy} className="btn-ghost w-full">
            {copied ? <Check className="h-4 w-4 text-ok-300" /> : <Copy className="h-4 w-4" />} {copied ? 'Copied' : 'Copy key'}
          </button>
          <p className="text-xs text-warn-300">This key is shown only once. If it is lost, revoke it and create a new one.</p>
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      title="New queue key"
      subtitle="For a kiosk or queue machine that registers patient arrivals."
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => save.run()} disabled={save.busy || !name.trim()}>
            {save.busy && <Spinner className="h-4 w-4 text-white" />} Create key
          </button>
        </>
      }
    >
      <form onSubmit={(e) => (e.preventDefault(), save.run())} className="space-y-4">
        <Field label="Name" hint="Where it is used, e.g. “Main entrance kiosk”.">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
        </Field>
        <Field label="Branch" hint="Limit the key to one branch. Recommended for a kiosk in a single branch.">
          <select className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">Any branch in the organisation</option>
            {branches.filter((b) => b.isActive).map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </Field>
        <FormError error={save.error} />
      </form>
    </Modal>
  );
}

export function ApiKeysTab({ branches }) {
  const keys = useApi('/org/api-keys');
  const [adding, setAdding] = useState(false);
  const revoke = useSubmit(async (k) => {
    if (!window.confirm(`Revoke “${k.name}”? Machines using it stop registering arrivals straight away.`)) return;
    await api(`/org/api-keys/${k.id}`, { method: 'DELETE' });
    await keys.reload();
  });

  return (
    <Panel
      title="Queue machine keys"
      subtitle="Each kiosk or queue system signs its requests with a key. Keys only reach this organisation’s branches."
      right={
        <button className="btn-primary" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> New key
        </button>
      }
      error={keys.error}
      onRetry={keys.reload}
      bodyClassName="p-0"
    >
      <FormError error={revoke.error} />
      {!keys.data ? (
        <Spinner className="mx-auto my-12 h-6 w-6" />
      ) : keys.data.length === 0 ? (
        <div className="p-5">
          <EmptyState title="No queue keys yet" body="Create one to connect a kiosk or queue machine. The web simulator does not need a key." />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-700/60 text-left text-xs text-mist-400">
                <th className="px-5 py-2.5 font-medium">Name</th>
                <th className="px-3 py-2.5 font-medium">Key</th>
                <th className="px-3 py-2.5 font-medium">Branch</th>
                <th className="px-3 py-2.5 font-medium">Last used</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {keys.data.map((k) => (
                <tr key={k.id} className="border-b border-ink-700/40 last:border-0">
                  <td className="whitespace-nowrap px-5 py-3 font-medium text-white">
                    <span className="inline-flex items-center gap-2">
                      <KeyRound className="h-4 w-4 text-mist-500" /> {k.name}
                    </span>
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-mist-300">{k.prefix}…</td>
                  <td className="px-3 py-3 text-mist-300">{k.branchName ?? 'Any branch'}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-mist-400">{fmtWhen(k.lastUsedAt)}</td>
                  <td className="px-5 py-3 text-right">
                    {k.revokedAt ? (
                      <Badge>Revoked</Badge>
                    ) : (
                      <button className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => revoke.run(k)} disabled={revoke.busy}>
                        <Trash2 className="h-3.5 w-3.5" /> Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && <NewKey branches={branches} onCreated={keys.reload} onClose={() => setAdding(false)} />}
    </Panel>
  );
}

// ── security log ─────────────────────────────────────────────────
const ACTION_LABEL = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in',
  'auth.password_change': 'Changed password',
  'auth.password_reset_requested': 'Asked for a password reset link',
  'auth.password_reset': 'Reset password from email link',
  'auth.email_verified': 'Confirmed email',
  'org.signup': 'Created the organisation',
  'org.rename': 'Renamed the organisation',
  'org.export': 'Exported data',
  'branch.create': 'Added a branch',
  'branch.update': 'Changed a branch',
  'user.create': 'Added a team member',
  'user.update': 'Changed a team member',
  'user.password_reset': 'Reset a team member’s password',
  'api_key.create': 'Created a queue key',
  'api_key.revoke': 'Revoked a queue key',
  'billing.checkout_started': 'Opened checkout',
  'billing.subscribed': 'Subscribed',
  'billing.created': 'Subscription created',
  'billing.updated': 'Subscription changed',
  'billing.deleted': 'Subscription ended',
  'billing.payment_failed': 'Payment failed',
};

export function AuditTab() {
  const log = useApi('/org/audit');
  return (
    <Panel title="Security log" subtitle="The latest 200 sign-ins and changes in your organisation." error={log.error} onRetry={log.reload} bodyClassName="p-0">
      {!log.data ? (
        <Spinner className="mx-auto my-12 h-6 w-6" />
      ) : log.data.length === 0 ? (
        <div className="p-5">
          <EmptyState title="Nothing recorded yet" />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-700/60 text-left text-xs text-mist-400">
                <th className="px-5 py-2.5 font-medium">When</th>
                <th className="px-3 py-2.5 font-medium">Who</th>
                <th className="px-3 py-2.5 font-medium">What</th>
                <th className="px-5 py-2.5 font-medium">IP address</th>
              </tr>
            </thead>
            <tbody>
              {log.data.map((a) => (
                <tr key={a.id} className="border-b border-ink-700/40 last:border-0">
                  <td className="whitespace-nowrap px-5 py-2.5 text-mist-400">{fmtWhen(a.createdAt)}</td>
                  <td className="px-3 py-2.5 text-white">{a.actor?.name ?? <span className="text-mist-500">System</span>}</td>
                  <td className={a.action === 'auth.login_failed' || a.action === 'billing.payment_failed' ? 'px-3 py-2.5 text-warn-300' : 'px-3 py-2.5 text-mist-200'}>
                    {ACTION_LABEL[a.action] ?? a.action}
                  </td>
                  <td className="px-5 py-2.5 font-mono text-xs text-mist-500">{a.ip ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ── data: export and delete ──────────────────────────────────────
function DeleteOrganisation({ org, onClose }) {
  const { logout } = useAuth();
  const [confirmName, setConfirmName] = useState('');
  const [password, setPassword] = useState('');
  const del = useSubmit(async () => {
    await api('/org', { method: 'DELETE', body: { confirmName, password } });
    logout();
  });
  return (
    <Modal
      title="Delete organisation"
      subtitle="This cannot be undone."
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary !bg-crit hover:!bg-crit/90" onClick={() => del.run()} disabled={del.busy || confirmName.trim() !== org.name || !password}>
            {del.busy && <Spinner className="h-4 w-4 text-white" />} Delete everything
          </button>
        </>
      }
    >
      <form onSubmit={(e) => (e.preventDefault(), del.run())} className="space-y-4">
        <p className="text-sm text-mist-300">
          Every branch, team member, ticket, import and queue key of <span className="font-semibold text-white">{org.name}</span> is deleted permanently,
          and any subscription is cancelled. Export your data first if you may need it.
        </p>
        <Field label={`Type “${org.name}” to confirm`}>
          <input className="input" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Your password">
          <input type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </Field>
        <FormError error={del.error} />
      </form>
    </Modal>
  );
}

export function DataPanel({ org }) {
  const [range, setRange] = useState(() => presetRange('30d'));
  const [deleting, setDeleting] = useState(false);
  const exp = useSubmit(() => apiDownload('/org/export', range));
  return (
    <Panel title="Your data" className="lg:col-span-2">
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold text-white">Export tickets</h3>
          <p className="mt-1 text-xs text-mist-400">Every ticket in the period as a CSV file, up to one year at a time. Available even after a trial ends.</p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Field label="From">
              <input type="date" className="input" value={range.from} max={range.to} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
            </Field>
            <Field label="To">
              <input type="date" className="input" value={range.to} min={range.from} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
            </Field>
            <button className="btn-ghost" onClick={() => exp.run()} disabled={exp.busy}>
              {exp.busy ? <Spinner className="h-4 w-4" /> : <Download className="h-4 w-4" />} Download CSV
            </button>
          </div>
          <div className="mt-2">
            <FormError error={exp.error} />
          </div>
        </div>
        {!org.demoProtected && (
          <div className="rounded-xl border border-crit/30 bg-crit/[0.05] p-4">
            <h3 className="text-sm font-semibold text-crit-300">Delete organisation</h3>
            <p className="mt-1 text-xs text-mist-400">Permanently remove the organisation and all of its data, and cancel its subscription.</p>
            <button className="btn-ghost mt-3 border-crit/40 text-crit-300 hover:border-crit/70" onClick={() => setDeleting(true)}>
              <Trash2 className="h-4 w-4" /> Delete organisation…
            </button>
          </div>
        )}
      </div>
      {deleting && <DeleteOrganisation org={org} onClose={() => setDeleting(false)} />}
    </Panel>
  );
}
