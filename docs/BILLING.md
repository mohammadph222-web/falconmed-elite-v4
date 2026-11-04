# Billing (Stripe)

FalconMed Elite sells self-service subscriptions through **Stripe Checkout** and lets customers manage them in the **Stripe Customer Portal**. Each organisation is one Stripe Customer. The webhook is the only thing that changes an organisation's subscription state.

## How access works

| Organisation | Can use the product when |
|---|---|
| `trial` | `trial_ends_at` is in the future (14 days from sign-up) |
| `starter`, `pro` | Stripe subscription status is `active`, `trialing` or `past_due` (grace while Stripe retries) |
| `enterprise`, `demo` | Always (set by hand) |

When access ends, metrics, the live queue, the counter, imports and kiosk keys answer **402**. Settings, Billing, My account and the CSV export stay open, so an organisation can always pay or leave with its data.

Plan limits on **active** branches and team members live in `backend/src/lib/plans.js`:

| Plan | Branches | Team members |
|---|---|---|
| Free trial | 3 | 25 |
| Starter | 2 | 20 |
| Pro | 15 | 200 |
| Enterprise | unlimited | unlimited |

Change these numbers to match your pricing. Prices themselves live only in Stripe.

## One-time setup

Do this in a **Stripe sandbox** first, then repeat in live mode.

1. **Products and prices.** Create one Product per plan (*FalconMed Starter*, *FalconMed Pro*), each with a recurring Price (e.g. monthly in AED). Do not put both plans on one product. Copy the price IDs into `STRIPE_PRICE_STARTER` and `STRIPE_PRICE_PRO`.
2. **API key.** Create a **restricted key** (`rk_…`) with these permissions and set it as `STRIPE_SECRET_KEY`:
   - Customers: write · Checkout Sessions: write · Customer portal: write · Subscriptions: write · Charges: read
3. **Webhook.** Add an endpoint `https://<your-api>/api/billing/webhook` and subscribe to exactly these events, then set its signing secret as `STRIPE_WEBHOOK_SECRET`:
   - `checkout.session.completed`, `checkout.session.async_payment_succeeded`
   - `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`
   - `invoice.paid`, `invoice.payment_failed`
   - `charge.dispute.created`, `charge.refunded`, `radar.early_fraud_warning.created`
4. **Customer Portal.** In *Settings → Billing → Customer portal*, allow: update payment method, view invoices, cancel at period end, and switch between the Starter and Pro prices.
5. **Emails and dunning.** In *Settings → Billing → Subscriptions and emails*, turn on Smart Retries and failed-payment emails. FalconMed also emails the organisation's admins when a payment fails.
6. **Tax.** If you must charge VAT (UAE 5 %) or sell abroad, set up Stripe Tax and add your tax registrations **before** enabling automatic tax. Without an active registration Stripe calculates no tax and reports no error. Automatic tax is deliberately not enabled in the code yet.

## Local testing

```bash
stripe listen --forward-to localhost:5000/api/billing/webhook   # prints a whsec_… for STRIPE_WEBHOOK_SECRET
stripe trigger customer.subscription.updated
```

Use test card `4242 4242 4242 4242`. The automated tests (`backend/test/saas.test.js`) use a fake Stripe client and real signed webhook payloads, so they never call Stripe.

## Behaviour worth knowing

- **Trial days carry over.** Subscribing during the trial sets the subscription's `trial_end` to the organisation's trial end, so the first charge comes when the free trial would have ended (only if more than 48 hours remain, a Stripe rule).
- **Email must be confirmed** before an admin can open Checkout.
- **Idempotent webhook.** Each event ID is processed once (`stripe_events`), and every handler re-reads the subscription from Stripe, so retries and out-of-order delivery are safe.
- **Disputes, refunds and early fraud warnings** are written to the organisation's security log and to the server log for you to review in the Stripe Dashboard. Nothing is revoked automatically.
- **Deleting an organisation** cancels its subscription immediately, before any data is removed.
