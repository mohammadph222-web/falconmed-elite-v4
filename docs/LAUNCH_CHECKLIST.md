# Launch checklist

What the code already does is in [SECURITY.md](SECURITY.md) and [BILLING.md](BILLING.md). These are the steps that need a person.

## Before the first paying customer

- [ ] **Legal review.** `/terms` and `/privacy` are a starting point that describes what the software does. Have them reviewed for your entity and jurisdiction (UAE PDPL, and DHA / DOH rules if you serve regulated facilities). Set `VITE_LEGAL_ENTITY`, `VITE_LEGAL_EMAIL`, `VITE_LEGAL_UPDATED`.
- [ ] **Stripe live mode.** Products, prices, restricted key, webhook and Customer Portal set up as in BILLING.md. Decide on VAT and set up Stripe Tax registrations if needed.
- [ ] **Email.** Verify your sending domain in Resend (SPF, DKIM, DMARC). Send yourself a reset email from production and check it lands in the inbox, not spam.
- [ ] **Secrets.** Fresh `JWT_SECRET` in production (Render can generate it). Nothing from development reused.
- [ ] **Separate demo from customers.** Either run the public demo on its own deployment and database, or set `DEMO_LOGIN=false` on the customer deployment.
- [ ] **Hosting tier.** Render's free tier sleeps after inactivity (≈50 s cold start) and Neon's free tier has storage limits; use paid tiers for customers.
- [ ] **Backups.** Neon point-in-time restore on; one restore rehearsed.
- [ ] **Monitoring.** Uptime check on `/api/health`; alerts on 5xx rate. Consider an error tracker (e.g. Sentry) for the API and dashboard.
- [ ] **Domains.** API and dashboard on your own domains over HTTPS; `APP_URL` and `CORS_ORIGINS` updated to match.

## Follow-ups (not blocking)

- [ ] Upgrade Vite 5 → current major (dev-server advisories in esbuild; the shipped static files are not affected).
- [ ] Two-factor authentication for organisation admins.
- [ ] Shared rate-limit store if the API runs on more than one instance.
