import { useMemo, useState } from 'react';
import { Building2, Eye, Info, KeyRound, Lock, Pencil, Plus, Power, Search, UserPlus, Users } from 'lucide-react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuth } from '../lib/auth';
import { cn, ROLE_LABEL } from '../lib/format';
import { PageHeader, Panel, Segmented } from '../components/ui';
import { EmptyState, Spinner } from '../components/States';
import { Field, FormError, Modal, TemporaryPassword } from '../components/Modal';

const ROLE_OPTIONS = [
  { id: 'pharmacist', label: 'Pharmacist' },
  { id: 'manager', label: 'Branch manager' },
  { id: 'admin', label: 'Admin' },
];

function useSubmit(fn) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (...args) => {
    setBusy(true);
    setError(null);
    try {
      return await fn(...args);
    } catch (err) {
      setError(err);
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error, setError };
}

function Badge({ tone = 'muted', children }) {
  const cls = {
    ok: 'bg-ok/15 text-ok-300 ring-ok/30',
    muted: 'bg-ink-700 text-mist-300 ring-ink-600',
    warn: 'bg-warn/15 text-warn-300 ring-warn/30',
    brand: 'bg-brand/15 text-brand-200 ring-brand/30',
  }[tone];
  return <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset', cls)}>{children}</span>;
}

const ProtectedMark = () => (
  <span title="Protected demo record" className="inline-flex text-mist-500">
    <Lock className="h-3.5 w-3.5" aria-label="Protected demo record" />
  </span>
);

// ── team ─────────────────────────────────────────────────────────
function MemberForm({ member, branches, team, onSaved, onClose }) {
  const editing = Boolean(member);
  const [form, setForm] = useState({
    fullName: member?.name ?? '',
    email: member?.email ?? '',
    role: member?.role ?? 'pharmacist',
    branchId: member?.branchId ?? branches.find((b) => b.isActive)?.id ?? '',
    counterNo: member?.counterNo ?? '',
  });
  const [temp, setTemp] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  const activeBranches = branches.filter((b) => b.isActive);
  const branch = branches.find((b) => b.id === form.branchId);
  const taken = useMemo(
    () => new Map(team.filter((u) => u.isActive && u.role === 'pharmacist' && u.branchId === form.branchId && u.id !== member?.id).map((u) => [u.counterNo, u.name])),
    [team, form.branchId, member],
  );

  const save = useSubmit(async () => {
    const body = {
      fullName: form.fullName,
      role: form.role,
      branchId: form.role === 'admin' ? null : form.branchId || null,
      counterNo: form.role === 'pharmacist' ? Number(form.counterNo) || null : null,
    };
    if (editing) {
      await api(`/org/users/${member.id}`, { method: 'PATCH', body });
      onSaved();
      onClose();
    } else {
      const r = await api('/org/users', { method: 'POST', body: { ...body, email: form.email } });
      onSaved();
      setTemp({ name: r.data.user.name, email: r.data.user.email, password: r.data.temporaryPassword });
    }
  });
  const reset = useSubmit(async () => {
    const r = await api(`/org/users/${member.id}/reset-password`, { method: 'POST' });
    onSaved();
    setTemp({ name: member.name, email: member.email, password: r.data.temporaryPassword });
  });
  const toggle = useSubmit(async () => {
    await api(`/org/users/${member.id}`, { method: 'PATCH', body: { isActive: !member.isActive } });
    onSaved();
    onClose();
  });

  if (temp) {
    return (
      <Modal title={editing ? 'Password reset' : 'Team member added'} onClose={onClose} footer={<button className="btn-primary" onClick={onClose}>Done</button>}>
        <TemporaryPassword {...temp} />
      </Modal>
    );
  }

  const locked = member?.demoProtected;
  const error = save.error || reset.error || toggle.error;
  return (
    <Modal
      title={editing ? member.name : 'Add a team member'}
      subtitle={editing ? member.email : 'They get a temporary password and choose their own at first sign-in.'}
      onClose={onClose}
      footer={
        <>
          {editing && !locked && (
            <div className="mr-auto flex flex-wrap gap-2">
              {member.isActive && (
                <button type="button" className="btn-ghost px-3" onClick={reset.run} disabled={reset.busy}>
                  <KeyRound className="h-4 w-4" /> Reset password
                </button>
              )}
              <button type="button" className={member.isActive ? 'btn-warn px-3' : 'btn-ghost px-3'} onClick={toggle.run} disabled={toggle.busy}>
                <Power className="h-4 w-4" /> {member.isActive ? 'Deactivate' : 'Reactivate'}
              </button>
            </div>
          )}
          <button type="button" className="btn-ghost" onClick={onClose}>{locked ? 'Close' : 'Cancel'}</button>
          {!locked && (
            <button form="member-form" className="btn-primary" disabled={save.busy}>
              {save.busy ? <Spinner className="h-4 w-4 text-white" /> : null}
              {editing ? 'Save changes' : 'Add and create password'}
            </button>
          )}
        </>
      }
    >
      {locked && (
        <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-ink-600 bg-ink-900 p-3.5 text-sm text-mist-300">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-mist-400" />
          This is a protected demo account so the demo keeps working for everyone. Add your own team member to try editing.
        </div>
      )}
      <form id="member-form" onSubmit={(e) => (e.preventDefault(), save.run())} className="space-y-4">
        <fieldset disabled={locked} className="space-y-4">
          <Field label="Full name">
            <input className="input" value={form.fullName} onChange={set('fullName')} required maxLength={80} />
          </Field>
          {!editing && (
            <Field label="Work email" hint="Used to sign in.">
              <input type="email" className="input" value={form.email} onChange={set('email')} required maxLength={120} placeholder="name@pharmacy.ae" />
            </Field>
          )}
          <div>
            <span className="label">Role</span>
            <div className="mt-1.5">
              <Segmented options={ROLE_OPTIONS} value={form.role} onChange={set('role')} size="sm" />
            </div>
            <p className="mt-1 text-xs text-mist-500">
              {form.role === 'pharmacist' && 'Works one counter and sees their own performance.'}
              {form.role === 'manager' && 'Runs one branch: its dashboard, live queue and imports.'}
              {form.role === 'admin' && 'Sees every branch and manages settings for the whole organisation.'}
            </p>
          </div>
          {form.role !== 'admin' && (
            <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
              <Field label="Branch">
                <select className="input" value={form.branchId} onChange={(e) => setForm((f) => ({ ...f, branchId: e.target.value, counterNo: '' }))} required>
                  <option value="" disabled>Choose a branch</option>
                  {activeBranches.map((b) => (
                    <option key={b.id} value={b.id}>{b.name} · {b.city}</option>
                  ))}
                </select>
              </Field>
              {form.role === 'pharmacist' && (
                <Field label="Counter">
                  <select className="input" value={form.counterNo} onChange={set('counterNo')} required>
                    <option value="" disabled>—</option>
                    {Array.from({ length: branch?.counters ?? 0 }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n} disabled={taken.has(n)}>
                        {n}{taken.has(n) ? ` · ${taken.get(n)}` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
          )}
        </fieldset>
        <FormError error={error} />
      </form>
    </Modal>
  );
}

function TeamTab({ team, branches, reload }) {
  const [q, setQ] = useState('');
  const [show, setShow] = useState('active');
  const [editing, setEditing] = useState(undefined); // undefined = closed, null = new, object = edit
  const rows = team.filter(
    (u) => (show === 'all' || u.isActive) && (!q || `${u.name} ${u.email} ${u.branchName ?? ''}`.toLowerCase().includes(q.toLowerCase())),
  );
  const inactive = team.filter((u) => !u.isActive).length;

  return (
    <Panel
      title="Team"
      subtitle={`${team.filter((u) => u.isActive).length} active${inactive ? ` · ${inactive} inactive` : ''}`}
      bodyClassName="!p-0"
      right={
        <button className="btn-primary px-3 py-2" onClick={() => setEditing(null)} disabled={!branches.some((b) => b.isActive)}>
          <UserPlus className="h-4 w-4" /> Add team member
        </button>
      }
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-700/60 px-5 py-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mist-500" />
          <input className="input py-2 pl-9" placeholder="Search name, email or branch" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Segmented size="sm" value={show} onChange={setShow} options={[{ id: 'active', label: 'Active' }, { id: 'all', label: 'All' }]} />
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No team members match" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="label text-left">
                <th className="whitespace-nowrap px-5 py-3 font-normal">Name</th>
                <th className="whitespace-nowrap px-3 py-3 font-normal">Role</th>
                <th className="whitespace-nowrap px-3 py-3 font-normal">Branch · counter</th>
                <th className="whitespace-nowrap px-3 py-3 font-normal">Status</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} className={cn('border-t border-ink-700/50 transition hover:bg-ink-800/50', !u.isActive && 'opacity-60')}>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-1.5 font-medium text-white">
                      {u.name} {u.demoProtected && <ProtectedMark />}
                    </div>
                    <div className="text-xs text-mist-400">{u.email}</div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-mist-200">{ROLE_LABEL[u.role]}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-mist-300">
                    {u.role === 'admin' ? <span className="text-mist-500">All branches</span> : `${u.branchName ?? '—'}${u.counterNo ? ` · ${u.counterNo}` : ''}`}
                  </td>
                  <td className="px-3 py-3">
                    {!u.isActive ? <Badge>Inactive</Badge> : u.mustChangePassword ? <Badge tone="warn">Invited</Badge> : <Badge tone="ok">Active</Badge>}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => setEditing(u)}>
                      {u.demoProtected ? <Eye className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />} {u.demoProtected ? 'View' : 'Edit'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing !== undefined && <MemberForm member={editing} branches={branches} team={team} onSaved={reload} onClose={() => setEditing(undefined)} />}
    </Panel>
  );
}

// ── branches ─────────────────────────────────────────────────────
function BranchForm({ branch, onSaved, onClose }) {
  const editing = Boolean(branch);
  const [form, setForm] = useState({ name: branch?.name ?? '', city: branch?.city ?? '', counters: branch?.counters ?? 3 });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useSubmit(async () => {
    const body = { ...form, counters: Number(form.counters) };
    await api(editing ? `/org/branches/${branch.id}` : '/org/branches', { method: editing ? 'PATCH' : 'POST', body });
    onSaved();
    onClose();
  });
  const toggle = useSubmit(async () => {
    await api(`/org/branches/${branch.id}`, { method: 'PATCH', body: { isActive: !branch.isActive } });
    onSaved();
    onClose();
  });
  const locked = branch?.demoProtected;

  return (
    <Modal
      title={editing ? branch.name : 'Add a branch'}
      subtitle={editing ? `${branch.activeStaff} active team member(s)` : 'It appears in every dashboard as soon as it has tickets.'}
      onClose={onClose}
      footer={
        <>
          {editing && !locked && (
            <button type="button" className={cn('mr-auto px-3', branch.isActive ? 'btn-warn' : 'btn-ghost')} onClick={toggle.run} disabled={toggle.busy}>
              <Power className="h-4 w-4" /> {branch.isActive ? 'Deactivate' : 'Reactivate'}
            </button>
          )}
          <button type="button" className="btn-ghost" onClick={onClose}>{locked ? 'Close' : 'Cancel'}</button>
          {!locked && (
            <button form="branch-form" className="btn-primary" disabled={save.busy}>
              {save.busy ? <Spinner className="h-4 w-4 text-white" /> : null} {editing ? 'Save changes' : 'Add branch'}
            </button>
          )}
        </>
      }
    >
      {locked && (
        <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-ink-600 bg-ink-900 p-3.5 text-sm text-mist-300">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-mist-400" />
          This is a protected demo branch. Add your own branch to try editing.
        </div>
      )}
      <form id="branch-form" onSubmit={(e) => (e.preventDefault(), save.run())} className="space-y-4">
        <fieldset disabled={locked} className="space-y-4">
          <Field label="Branch name">
            <input className="input" value={form.name} onChange={set('name')} required maxLength={80} placeholder="e.g. Corniche" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
            <Field label="City">
              <input className="input" value={form.city} onChange={set('city')} required maxLength={60} placeholder="e.g. Abu Dhabi" />
            </Field>
            <Field label="Counters" hint="1–50">
              <input type="number" min={1} max={50} className="input" value={form.counters} onChange={set('counters')} required />
            </Field>
          </div>
        </fieldset>
        {editing && branch.isActive && branch.activeStaff > 0 && !locked && (
          <p className="text-xs text-mist-500">To deactivate this branch, first move or deactivate its team members.</p>
        )}
        <FormError error={save.error || toggle.error} />
      </form>
    </Modal>
  );
}

function BranchesTab({ branches, reload }) {
  const [editing, setEditing] = useState(undefined);
  return (
    <Panel
      title="Branches"
      subtitle={`${branches.filter((b) => b.isActive).length} active`}
      right={
        <button className="btn-primary px-3 py-2" onClick={() => setEditing(null)}>
          <Plus className="h-4 w-4" /> Add branch
        </button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {branches.map((b) => (
          <button
            key={b.id}
            onClick={() => setEditing(b)}
            className={cn('group rounded-xl border border-ink-700 bg-ink-900/60 p-4 text-left transition hover:border-brand/50 hover:bg-ink-800', !b.isActive && 'opacity-60')}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 font-semibold text-white">
                  <span className="truncate">{b.name}</span> {b.demoProtected && <ProtectedMark />}
                </div>
                <div className="text-xs text-mist-400">{b.city}</div>
              </div>
              {b.isActive ? <Badge tone="ok">Active</Badge> : <Badge>Inactive</Badge>}
            </div>
            <div className="mt-4 flex gap-6 text-xs text-mist-400">
              <span><span className="font-display text-lg font-semibold text-white tabular">{b.counters}</span> counters</span>
              <span><span className="font-display text-lg font-semibold text-white tabular">{b.activeStaff}</span> team</span>
            </div>
          </button>
        ))}
      </div>
      {editing !== undefined && <BranchForm branch={editing} onSaved={reload} onClose={() => setEditing(undefined)} />}
    </Panel>
  );
}

// ── organisation ─────────────────────────────────────────────────
function OrganisationTab({ org, reload }) {
  const { refreshUser } = useAuth();
  const [name, setName] = useState(org.name);
  const [saved, setSaved] = useState(false);
  const save = useSubmit(async () => {
    await api('/org', { method: 'PATCH', body: { name } });
    await Promise.all([reload(), refreshUser()]);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  });
  return (
    <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
      <Panel title="Organisation profile">
        <form onSubmit={(e) => (e.preventDefault(), save.run())} className="space-y-4">
          <Field label="Organisation name" hint={org.demoProtected ? 'The demo organisation keeps its name.' : 'Shown to everyone in your organisation.'}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required disabled={org.demoProtected} />
          </Field>
          <FormError error={save.error} />
          {!org.demoProtected && (
            <div className="flex items-center gap-3">
              <button className="btn-primary" disabled={save.busy || name.trim() === org.name}>
                {save.busy && <Spinner className="h-4 w-4 text-white" />} Save
              </button>
              {saved && <span className="text-sm text-ok-300">Saved</span>}
            </div>
          )}
        </form>
      </Panel>
      <Panel title="Plan and usage">
        <dl className="space-y-3 text-sm">
          {[
            ['Plan', <Badge key="p" tone="brand">{org.plan}</Badge>],
            ['Active branches', org.activeBranches],
            ['Active team members', org.activeTeam],
            ['Organisation ID', <code key="i" className="font-mono text-xs text-mist-300">{org.slug}</code>],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-4 border-b border-ink-700/50 pb-3 last:border-0 last:pb-0">
              <dt className="text-mist-400">{k}</dt>
              <dd className="font-medium text-white tabular">{v}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    </div>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState('team');
  const org = useApi('/org');
  const branches = useApi('/org/branches');
  const team = useApi('/org/users');
  const reloadAll = () => Promise.all([org.reload(), branches.reload(), team.reload()]);
  const ready = org.data && branches.data && team.data;
  const error = org.error || branches.error || team.error;

  return (
    <>
      <PageHeader
        eyebrow={org.data ? `${org.data.name} · settings` : 'Settings'}
        title="Settings"
        subtitle="Manage your organisation’s branches and team. Changes apply immediately."
        actions={
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { id: 'team', label: <span className="inline-flex items-center gap-1.5"><Users className="h-4 w-4" />Team</span> },
              { id: 'branches', label: <span className="inline-flex items-center gap-1.5"><Building2 className="h-4 w-4" />Branches</span> },
              { id: 'org', label: 'Organisation' },
            ]}
          />
        }
      />
      {org.data?.demoProtected && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-brand/30 bg-brand/[0.07] px-4 py-3 text-sm text-mist-200">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand-300" />
          <span>
            <span className="font-semibold text-white">Demo organisation.</span> The original branches and accounts (marked{' '}
            <Lock className="inline h-3.5 w-3.5 align-[-2px]" />) are protected so the demo works for everyone. Anything you add can be edited
            freely and is removed at the next demo refresh.
          </span>
        </div>
      )}
      {error && !ready ? (
        <Panel error={error} onRetry={reloadAll} />
      ) : !ready ? (
        <Spinner className="mx-auto my-24 h-7 w-7" />
      ) : tab === 'team' ? (
        <TeamTab team={team.data} branches={branches.data} reload={reloadAll} />
      ) : tab === 'branches' ? (
        <BranchesTab branches={branches.data} reload={reloadAll} />
      ) : (
        <OrganisationTab org={org.data} reload={reloadAll} />
      )}
    </>
  );
}
