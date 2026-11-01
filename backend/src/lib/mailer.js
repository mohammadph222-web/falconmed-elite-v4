import { env } from '../config/env.js';

/** Sent emails, kept in memory in tests so they can be read back. */
export const outbox = [];

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A plain, readable transactional email: a greeting, some lines and one button. */
function render({ greeting, lines, action }) {
  const text = [greeting, '', ...lines, '', action ? `${action.label}: ${action.url}` : '', '', '— FalconMed Elite'].join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;color:#0f172a;line-height:1.5">
<p>${escape(greeting)}</p>${lines.map((l) => `<p>${escape(l)}</p>`).join('')}
${action ? `<p><a href="${escape(action.url)}" style="display:inline-block;background:#2563a8;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${escape(action.label)}</a></p>
<p style="font-size:12px;color:#64748b">Or paste this link into your browser:<br>${escape(action.url)}</p>` : ''}
<p style="font-size:12px;color:#64748b">— FalconMed Elite</p></div>`;
  return { text, html };
}

/**
 * Send an email through Resend. Without RESEND_API_KEY the email is logged
 * (development) or kept in `outbox` (tests). Never throws: callers must not
 * reveal to the visitor whether an email went out.
 */
export async function sendEmail({ to, subject, ...content }) {
  const { text, html } = render(content);
  if (env.NODE_ENV === 'test') {
    outbox.push({ to, subject, text });
    return;
  }
  if (!env.RESEND_API_KEY) {
    // In production the body holds live sign-in links, so it never goes to the log.
    console.log(`✉️  [email not sent — RESEND_API_KEY unset] to=${to} subject="${subject}"${env.isProd ? '' : `\n${text}`}`);
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, text, html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`email to ${to} failed: ${res.status} ${await res.text().catch(() => '')}`);
  } catch (err) {
    console.error(`email to ${to} failed:`, err.message);
  }
}
