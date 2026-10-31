import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Building2, CheckCircle2, Circle, FileUp, Users, X } from 'lucide-react';
import { useApi } from '../lib/useApi';
import { cn } from '../lib/format';

const KEY = (orgId) => `fm.setup-hidden.${orgId}`;
const readHidden = (orgId) => {
  try {
    return localStorage.getItem(KEY(orgId)) === '1';
  } catch {
    return false;
  }
};

/** Checklist for a new organisation; disappears once everything is done (or when dismissed). */
export default function GettingStarted({ orgId }) {
  const org = useApi('/org');
  const [hidden, setHidden] = useState(() => readHidden(orgId));
  const setup = org.data?.setup;
  if (!setup || hidden || org.data.plan === 'demo' || (setup.branch && setup.team && setup.data)) return null;

  const steps = [
    { done: setup.branch, icon: Building2, title: 'Add your first branch', body: 'Its name, city and how many counters it has.', to: '/settings?tab=branches', cta: 'Add branch' },
    { done: setup.team, icon: Users, title: 'Add your team', body: 'Pharmacists get a counter; managers run a branch.', to: '/settings?tab=team', cta: 'Add team', locked: !setup.branch },
    { done: setup.data, icon: FileUp, title: 'Bring in your data', body: 'Import an export from your queue system, or try the simulator.', to: '/import', cta: 'Import data', locked: !setup.branch },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const dismiss = () => {
    try {
      localStorage.setItem(KEY(orgId), '1');
    } catch {
      /* storage unavailable — hide for this visit only */
    }
    setHidden(true);
  };

  return (
    <section className="panel mb-6 overflow-hidden animate-rise">
      <header className="flex items-start justify-between gap-4 border-b border-ink-700/60 bg-brand/[0.06] px-5 py-4">
        <div>
          <h2 className="font-display text-base font-semibold text-white">Welcome to FalconMed — let’s set up {org.data.name}</h2>
          <p className="mt-0.5 text-xs text-mist-400">{doneCount} of 3 done · the dashboards fill in as soon as tickets arrive</p>
        </div>
        <button onClick={dismiss} className="rounded-lg p-1.5 text-mist-500 hover:bg-ink-800 hover:text-white" aria-label="Hide the checklist">
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="h-1 bg-ink-800">
        <div className="h-full bg-ok transition-all" style={{ width: `${(doneCount / 3) * 100}%` }} />
      </div>
      <ol className="grid gap-px bg-ink-700/50 md:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s.title} className={cn('flex flex-col gap-3 bg-ink-850 p-5', s.locked && 'opacity-50')}>
            <div className="flex items-center gap-2.5">
              {s.done ? <CheckCircle2 className="h-5 w-5 text-ok-300" /> : <Circle className="h-5 w-5 text-mist-500" />}
              <span className={cn('text-sm font-semibold', s.done ? 'text-mist-400 line-through' : 'text-white')}>
                {i + 1}. {s.title}
              </span>
            </div>
            <p className="text-sm text-mist-400">{s.body}</p>
            {!s.done && !s.locked && (
              <Link to={s.to} className="btn-primary mt-auto self-start px-3 py-2 text-xs">
                <s.icon className="h-3.5 w-3.5" /> {s.cta} <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
