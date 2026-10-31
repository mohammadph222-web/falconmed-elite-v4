import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, X } from 'lucide-react';
import { cn } from '../lib/format';

/**
 * Accessible dialog: Esc closes, focus moves inside, background click closes.
 * Rendered into <body> so an animated (transformed) parent cannot shift it.
 */
export function Modal({ title, subtitle, onClose, children, footer, wide }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector('input, select, button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/65 backdrop-blur-[2px]" onClick={onClose} />
      <div
        ref={ref}
        className={cn(
          'panel relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-b-none animate-rise sm:rounded-b-panel',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-lg',
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-ink-700/60 px-5 py-4">
          <div className="min-w-0">
            <h2 className="font-display text-base font-semibold text-white">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-mist-400">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-mist-400 hover:bg-ink-800 hover:text-white" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-ink-700/60 px-5 py-3.5">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function Field({ label, hint, error, children }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <div className="mt-1.5">{children}</div>
      {error ? <p className="mt-1 text-xs text-crit-300">{error}</p> : hint ? <p className="mt-1 text-xs text-mist-500">{hint}</p> : null}
    </label>
  );
}

export function FormError({ error }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-xl border border-crit/35 bg-crit/10 px-3.5 py-2.5 text-sm text-crit-300">
      {error.message ?? String(error)}
      {Array.isArray(error.details) && error.details.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {error.details.map((d) => (
            <li key={`${d.field}${d.message}`}>{d.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Shows a temporary password once, with a copy button. */
export function TemporaryPassword({ name, email, password }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`Email: ${email}\nTemporary password: ${password}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the password is still visible to copy by hand */
    }
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-mist-300">
        Give these details to <span className="font-semibold text-white">{name}</span>. They will be asked to choose their own password the
        first time they sign in.
      </p>
      <div className="rounded-xl border border-ink-600 bg-ink-900 p-4">
        <div className="label">Email</div>
        <div className="mt-0.5 break-all font-mono text-sm text-white">{email}</div>
        <div className="label mt-3">Temporary password</div>
        <div className="mt-0.5 select-all font-mono text-xl tracking-wider text-brand-200">{password}</div>
      </div>
      <button onClick={copy} className="btn-ghost w-full">
        {copied ? <Check className="h-4 w-4 text-ok-300" /> : <Copy className="h-4 w-4" />}
        {copied ? 'Copied' : 'Copy email and password'}
      </button>
      <p className="text-xs text-warn-300">This password is shown only once. If it is lost, reset it again.</p>
    </div>
  );
}
