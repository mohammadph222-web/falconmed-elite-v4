import { AlertTriangle, Inbox, Loader2, RefreshCw } from 'lucide-react';
import { cn } from '../lib/format';

export function Spinner({ className }) {
  return <Loader2 className={cn('animate-spin text-brand-300', className)} aria-hidden />;
}

export function FullScreenMessage({ title, body, spinner, action }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="panel max-w-md p-8 text-center animate-rise">
        {spinner ? <Spinner className="mx-auto mb-4 h-8 w-8" /> : <AlertTriangle className="mx-auto mb-4 h-8 w-8 text-warn-300" />}
        <h1 className="font-display text-xl font-semibold">{title}</h1>
        {body && <p className="mt-2 text-sm text-mist-300">{body}</p>}
        {action && (
          <button className="btn-primary mt-6" onClick={action.onClick}>
            <RefreshCw className="h-4 w-4" /> {action.label}
          </button>
        )}
      </div>
    </div>
  );
}

export function PageLoader() {
  return (
    <div className="flex h-64 items-center justify-center">
      <Spinner className="h-7 w-7" />
    </div>
  );
}

export function Skeleton({ className }) {
  return <div className={cn('animate-pulse rounded-lg bg-ink-700/50', className)} />;
}

export function ErrorState({ error, onRetry, compact }) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'py-6' : 'py-12')}>
      <AlertTriangle className="mb-2 h-6 w-6 text-warn-300" />
      <p className="text-sm text-mist-200">{error?.message || 'Something went wrong'}</p>
      {onRetry && (
        <button className="btn-ghost mt-3 px-3 py-1.5 text-xs" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title = 'No data for this period', body }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <Inbox className="mb-2 h-6 w-6 text-mist-500" />
      <p className="text-sm text-mist-300">{title}</p>
      {body && <p className="mt-1 text-xs text-mist-500">{body}</p>}
    </div>
  );
}
