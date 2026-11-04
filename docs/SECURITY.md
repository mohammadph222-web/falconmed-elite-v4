# Security

How FalconMed Elite protects each organisation's data, and what operators must do.

## Controls

| Area | Control |
|---|---|
| Tenant isolation | Every query filtered by the signed-in user's organisation, loaded from the database on each request; cross-organisation IDs refused (403); composite foreign keys stop cross-organisation links. See [MULTI_TENANCY.md](MULTI_TENANCY.md). |
| Queue machines | Per-organisation keys (`fmq_…`), stored as SHA-256 hashes, shown once, revocable, optionally limited to one branch. A key can never reach another organisation. The legacy `QUEUE_API_KEY` reaches demo organisations only. |
| Sessions | HS256 JWT with issuer and audience, algorithm pinned. Tokens carry a version: a password change or reset signs out every other session. Tokens are kept in `sessionStorage` (cleared when the tab closes). |
| Passwords | bcrypt (cost 12), at least 10 characters with a letter and a digit. Temporary passwords must be changed at first sign-in. |
| Two-factor sign-in | Authenticator-app codes (TOTP, RFC 6238) for any user; organisations can require it for admins. Secrets encrypted at rest (AES-256-GCM, `DATA_ENCRYPTION_KEY`); a code is never accepted twice; ten single-use recovery codes stored as hashes. A password-reset link does not get past it. Wrong codes count towards the account lock. Admins can reset a member's two-factor (lost phone), which signs them out. Shared demo accounts cannot enable it. |
| Sign-in abuse | 10 failed attempts per 15 min per IP and per email address; the account itself locks for 15 minutes after 10 failures within the window (stored in the database, so it holds across restarts and instances). Older failures expire. While locked, the right password from the IP of the last successful sign-in still works, so an attacker cannot lock the owner out. Old bcrypt hashes are upgraded at sign-in. "Forgot password" answers before any email work, so timing does not reveal accounts. |
| Account recovery | Single-use, hashed email links: reset (1 h), invitation (72 h), email confirmation (48 h). Links are revoked on password change, admin reset and deactivation, and never work for inactive accounts. Without an email key in production, link-bearing emails are not written to the log. Demo accounts cannot be reset. |
| Plans | Trial expiry and subscription status enforced on the server (402), not only in the UI. Plan limits are checked under a per-organisation lock, so parallel requests cannot exceed them. |
| Billing | Stripe webhook signature verified on the raw body; each event claimed atomically and processed once. Checkout is refused while Stripe shows any open subscription for the customer, so an organisation cannot be charged twice. Deleting an organisation cancels every open subscription. No card data touches FalconMed. |
| Input | zod validation on every body and query; parameterised SQL only; 50 KB body limit (9 MB for imports). |
| Output | Errors never leak stack traces in production; 5xx responses carry a request ID that matches the server log. API responses are `Cache-Control: no-store`. CSV export neutralises spreadsheet formulas. |
| Browser | Build-time Content Security Policy (scripts only from the site, network only to the site and the API), HSTS, `X-Frame-Options: DENY`, `nosniff`, Permissions-Policy, COOP. |
| Audit | Sign-ins, failed sign-ins, password events, team, branch and key changes, exports and billing events are recorded per organisation (Settings → Security log). |
| Privacy | No patient names stored; the importer drops identifying columns before reading them. Organisations can export and delete all their data. |
| Rate limits | Sign-in, sign-up, email-sending and two-factor limits are counted in PostgreSQL, so they hold across every API instance and restarts. The general ceiling (600 requests per minute per IP) is kept in memory per instance. |

## Operator responsibilities

- Generate `JWT_SECRET` with at least 32 random bytes. The server refuses weak secrets in production.
- Keep `DATABASE_URL`, `STRIPE_*` and `RESEND_API_KEY` in the host's secret store only. Use a Stripe **restricted** key.
- Set `CORS_ORIGINS` to your exact dashboard origin(s). Only set `CORS_PREVIEW_PATTERN` to a pattern that matches deployments you own.
- Set `DEMO_LOGIN=false` and leave `QUEUE_API_KEY` empty on a customer-only deployment.
- Set `DATA_ENCRYPTION_KEY` once (Render generates it) and never change it: two-factor secrets are encrypted with it.
- The general per-IP ceiling is per instance; for a hard global limit add edge rate limiting (e.g. Cloudflare). Security-relevant limits are already shared through the database.
- Turn on Neon point-in-time restore and test a restore before launch.

## Reporting a vulnerability

Email the address in `VITE_LEGAL_EMAIL` with steps to reproduce. Please do not open a public issue.
