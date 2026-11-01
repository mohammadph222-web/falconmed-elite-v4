# FalconMed Elite — handoff after the SaaS hardening (v5.0)

This file is for whoever finishes the project next, and for their coding agent. It says what was done, what was checked, and what is still needed, in order. Read it top to bottom before changing anything.

- Branch: `saas-hardening` (merge into `main` through the pull request).
- State: 89/89 API tests pass against a real PostgreSQL, including on an empty database. The dashboard builds with 0 npm vulnerabilities. Every new flow was checked in a real browser.
- Last updated: 2 November 2026.

---

## 1. What the product is

Multi-tenant SaaS for pharmacy queue analytics. Pharmacy groups ("organisations") sign up, get a 14-day trial and subscribe through Stripe. Each organisation sees only its own branches, staff, tickets and imports.

| Part | Stack | Hosting (planned) |
|---|---|---|
| API | Node 20, Express 4, `pg`, zod, JWT, bcrypt, Stripe SDK 23 | Render (`render.yaml`) |
| Dashboard | React 18, Vite 8, Tailwind, Recharts | Vercel (`frontend/vercel.json`) |
| Database | PostgreSQL 16, schema `falconmed_v4`, SQL migrations `001`–`008` | Neon |
| Email | Resend over HTTP (no SDK) | Resend |
| CI | GitHub Actions: API tests on Postgres 16 plus `npm audit`; dashboard build | `.github/workflows/ci.yml` |

Read next: `README.md`, then `docs/SECURITY.md`, `docs/BILLING.md`, `docs/MULTI_TENANCY.md`, `docs/LAUNCH_CHECKLIST.md`. The deployment guide in Arabic is `docs/DEPLOYMENT_AR.md`.

---

## 2. What was done in the hardening

### Security fixes (bugs found and fixed)

| Problem found | Fix | Test |
|---|---|---|
| **Cross-tenant write.** One global `QUEUE_API_KEY` let any organisation's kiosk create tickets in any other organisation's branch. Reproduced before fixing. | Each organisation creates its own queue keys (`fmq_…`). Only a SHA-256 hash is stored, keys can be revoked, and a key can be limited to one branch. The legacy env key now reaches demo organisations only. | `saas.test.js` |
| **Trial never enforced.** `trial_ends_at` was only used for a banner. | The server answers 402 `SUBSCRIPTION_REQUIRED` for metrics, the queue, imports and kiosk keys. Settings, billing and export stay open. | `saas.test.js` |
| An attacker could keep any account locked out (found in the independent review). | While locked, the right password still works from the IP of the last successful sign-in, and failures expire after 15 minutes. | `saas.test.js` |
| Parallel requests could exceed plan limits (8 branches on a 3-branch plan). | Plan limits are checked under a per-organisation advisory lock. | `saas.test.js` |
| Deleting an organisation was not written to the audit log. | Fixed: an explicit `actorId: null` no longer falls back to the deleted user. | `saas.test.js` |
| An organisation could be charged for two Stripe subscriptions. | Checkout is refused while Stripe shows any open subscription, and deletion cancels all of them. | `saas.test.js` |
| A password-reset link could skip two-factor sign-in. | A reset link now asks for the 2FA code. | `mfa.test.js` |

### Features added

**API** (`backend/src`):
- **Billing**: Stripe Checkout, the Customer Portal, and a signed webhook that handles each event once. Plans and limits are in `lib/plans.js`.
- **Account recovery**: forgot/reset password, invitations by email, email confirmation. Links are single use and only their hash is stored.
- **Account lockout and rate limits**: sign-in, sign-up, email and 2FA limits are stored in PostgreSQL (`lib/rateLimitStore.js`).
- **Two-factor sign-in**: authenticator-app codes (TOTP, `lib/totp.js`) with recovery codes. Secrets are encrypted with `DATA_ENCRYPTION_KEY`, and organisations can require 2FA for admins.
- **Security log**: an audit log in `lib/audit.js`, shown in Settings.
- **Data**: CSV export that is safe to open in Excel, and deletion of the organisation with all its data.
- **Hardening**: request IDs, `Cache-Control: no-store`, strict JWT verification (issuer, audience, HS256), bcrypt cost 12 with old hashes upgraded at sign-in, 10-character passwords, and production checks that refuse to start with weak secrets.

**Dashboard** (`frontend/src`):
- Billing page.
- Forgot / reset / verify-email pages.
- 2FA: setup with a QR code, the code step at sign-in, and the forced-setup screen.
- Settings tabs: Queue keys, Security log, Your data, and Sign-in security.
- Terms and Privacy pages.
- A lock screen once the trial or subscription ends.
- A Content Security Policy generated at build time from `VITE_API_URL`, plus HSTS and other headers.

**Ops**: CI workflow, `render.yaml`, `.nvmrc` (Node 20), and housekeeping that deletes expired links, rate-limit rows and old webhook IDs every 10 minutes.

### Database migrations added

- `006_saas.sql`: `api_keys`, `auth_tokens`, `audit_log`, `stripe_events`; lockout and verification columns on `users`; Stripe columns on `organizations`.
- `007_review_fixes.sql`: `users.last_failed_login_at` and `last_login_ip`.
- `008_mfa_ratelimits.sql`: 2FA columns on `users`, `organizations.require_admin_2fa`, and the `rate_limits` table.

Migrations run automatically when the server starts. They only add things and never delete data.

---

## 3. What is still needed

### A. Needs a person: these cannot be done in code

1. **Merge the pull request** for `saas-hardening` after CI passes.
2. **Legal review.** `/terms` and `/privacy` (`frontend/src/pages/Legal.jsx`) are a draft that describes what the software does. They must be reviewed by a lawyer for the UAE (PDPL, plus DHA/DOH rules if serving regulated facilities). Then set `VITE_LEGAL_ENTITY`, `VITE_LEGAL_EMAIL` and `VITE_LEGAL_UPDATED`.
3. **Stripe**. Follow `docs/BILLING.md` step by step, in a Stripe sandbox first and then in live mode:
   - one Product per plan, each with a recurring Price;
   - a **restricted** key;
   - a webhook with the exact event list in BILLING.md;
   - the Customer Portal and Smart Retries.
4. **VAT decision.** If you must charge UAE VAT (5 %), set up Stripe Tax registrations **before** enabling automatic tax. It is deliberately not enabled in the code.
5. **Email.** Create a Resend account and verify the sending domain (SPF, DKIM, DMARC). Set `RESEND_API_KEY` and `EMAIL_FROM`.
6. **Production environment.** Generate `JWT_SECRET` and `DATA_ENCRYPTION_KEY`; `render.yaml` generates both. **Never change `DATA_ENCRYPTION_KEY` afterwards**, because 2FA secrets are encrypted with it. Set `APP_URL` (https) and `CORS_ORIGINS`, and on the dashboard set `VITE_API_URL`.
7. **Hosting.** Use paid tiers. Render's free tier sleeps (about 50 s cold start), and Neon's free tier has storage limits. Turn on Neon point-in-time restore and rehearse one restore.
8. **Separate the demo from customers.** Run the public demo on its own deployment, or set `DEMO_LOGIN=false` and leave `QUEUE_API_KEY` empty on the customer deployment.
9. **Monitoring.** Add an uptime check on `GET /api/health` and alerts on 5xx errors.
10. **Pricing.** The plan limits are placeholders: trial 3 branches / 25 people, Starter 2 / 20, Pro 15 / 200, Enterprise unlimited. Edit `backend/src/lib/plans.js` to match the real prices.

### B. Tested only with fakes: verify once accounts exist

- **Stripe** was tested with a fake client and real signed webhook payloads (`saas.test.js`); it has never called Stripe. After step A3:
  1. Run `stripe listen --forward-to localhost:5000/api/billing/webhook`.
  2. Subscribe in Checkout with card `4242 4242 4242 4242`.
  3. Confirm the organisation's plan and status update, open the portal, cancel, and confirm the product locks.
  4. Try `stripe trigger invoice.payment_failed`.
- **Email** was tested with an in-memory outbox and the dev log. After step A5, send a password reset to a real inbox and check it does not land in spam.

### C. Code work worth doing next (none blocks launch)

- **Error tracking**: add Sentry, or similar, to the API and the dashboard.
- **Plan downgrade**: when an organisation moves to a smaller plan, existing branches and users above the new limit are kept; only new ones are blocked. Decide whether to warn or enforce.
- **Admin tooling**: there is no super-admin console. Enterprise plans, extending a trial or suspending an organisation are done in SQL. For example:

  ```sql
  UPDATE falconmed_v4.organizations SET plan = 'enterprise' WHERE id = 'org_…';
  ```
- **Two `AccountPage` imports**: Vite warns that `AccountPage.jsx` is imported both directly and lazily. It is harmless; moving `ForcedPasswordChange` into its own file removes the warning.
- **Global rate limit**: the 600 requests/min per-IP ceiling is kept in memory on each instance. Add edge rate limiting (Cloudflare) for a hard global limit. The security-relevant limits are already shared through the database.
- **Email bounces**: Resend webhooks for bounces and complaints are not handled.

---

## 4. How to run and test locally

```bash
# a throwaway database (any Postgres 16 works)
docker run -d --name falconmed-test-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=falconmed_test -p 25499:5432 postgres:16-alpine

cd backend && npm ci
export DATABASE_URL=postgresql://postgres:test@localhost:25499/falconmed_test DB_SSL=off \
       JWT_SECRET=test-secret-test-secret-test-secret-1234 QUEUE_API_KEY=test-queue-key-123 NODE_ENV=test
npm run migrate && npm test          # expect: 89 pass, 0 fail

# run the app: API on :5000, dashboard on :5173
NODE_ENV=development npm run seed && NODE_ENV=development npm run dev
cd ../frontend && npm ci && VITE_API_URL=http://localhost:5000 npm run dev
```

- Use Node **20.19 or newer** (Vite 8 and Stripe SDK 23 need it).
- Without `RESEND_API_KEY`, emails, including reset and verification links, are printed in the API log in development. Copy the links from there.
- Demo sign-in: `admin@demo.falconmed.app` and the others, with `DEMO_PASSWORD` (default `Demo@2026`).
- **Tests use a real database and reseed demo organisations.** Never point `DATABASE_URL` at production when running `npm test`.

---

## 5. Rules for whoever changes the code next

- **Tenant isolation is the most important property.** Every query must filter by the signed-in user's `org_id`, loaded from the database (`req.user.org_id`), never from the request body. Add a test in `tenancy.test.js` or `saas.test.js` for any new endpoint that touches organisation data.
- New product endpoints need `requireAuth`, and also `requireEntitlement` unless they must keep working after a trial ends (billing, settings, export).
- Record security-relevant actions with `audit(req, 'thing.action', …)`. Add a readable label in `frontend/src/pages/SettingsSecurity.jsx`.
- Subscription state changes **only** in the Stripe webhook (`services/billing.js`), which re-reads the subscription from Stripe. Do not change `plan` or `subscription_status` from the success page.
- Use new SQL migration files (`009_…sql`). Never edit an applied migration.
- Keep `PASSWORD_RULES` (`frontend/src/lib/password.js`) in step with `newPasswordSchema` (`backend/src/lib/passwords.js`).
- Rate-limit counters are in the `rate_limits` table. Tests clear it in `before()`; new test files must do the same.

---

## 6. Where things are

| Need | File |
|---|---|
| Env variables and production checks | `backend/src/config/env.js`, `backend/.env.example`, `frontend/.env.example` |
| Sign-in, lockout, reset, verify, 2FA | `backend/src/routes/auth.js`, `backend/src/lib/totp.js` |
| Auth middleware, entitlement, queue keys | `backend/src/middleware/auth.js` |
| Plans and limits | `backend/src/lib/plans.js` |
| Stripe | `backend/src/services/billing.js`, `backend/src/routes/billing.js` |
| Organisation settings, keys, export, delete | `backend/src/routes/org.js` |
| Email templates | `backend/src/lib/mailer.js` |
| Dashboard routing and plan lock | `frontend/src/App.jsx` |
| Billing / 2FA / security settings UI | `frontend/src/pages/BillingPage.jsx`, `frontend/src/components/TwoFactor.jsx`, `frontend/src/pages/SettingsSecurity.jsx` |
| Content Security Policy | `frontend/vite.config.js` |
| Tests | `backend/test/*.test.js` (`saas.test.js` and `mfa.test.js` cover the hardening) |
