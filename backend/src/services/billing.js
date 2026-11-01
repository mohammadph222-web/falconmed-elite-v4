/**
 * Stripe billing. Each organisation is one Stripe Customer; its plan comes
 * from the price on its subscription. The webhook is the only thing that
 * changes an organisation's subscription state, and it always re-reads the
 * subscription from Stripe instead of trusting the event payload, so events
 * arriving late or out of order cannot leave stale state behind.
 */
import Stripe from 'stripe';
import { query } from '../config/db.js';
import { env } from '../config/env.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';
import { sendEmail } from '../lib/mailer.js';

let client = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 20_000 }) : null;

/** Tests swap in a fake client. */
export const setStripeClient = (c) => {
  client = c;
};

export function stripe() {
  if (!client) throw new HttpError(503, 'Billing is not configured on this server yet.', 'BILLING_UNAVAILABLE');
  return client;
}

export const billingEnabled = () => Boolean(client);

/** Self-service plans and their Stripe prices. Enterprise is arranged with sales and set by hand. */
export const priceForPlan = () => ({ starter: env.STRIPE_PRICE_STARTER, pro: env.STRIPE_PRICE_PRO });
const planForPrice = (priceId) => Object.entries(priceForPlan()).find(([, p]) => p && p === priceId)?.[0] ?? null;

// Tags Checkout Sessions from this integration in the Stripe Dashboard.
const INTEGRATION_ID = 'falconmed_subscription_qkzpwrne';

/** The organisation's Stripe Customer, created the first time it is needed. */
async function ensureCustomer(org, admin) {
  if (org.stripe_customer_id) return org.stripe_customer_id;
  const customer = await stripe().customers.create(
    { email: admin.email, name: org.name, metadata: { org_id: org.id } },
    { idempotencyKey: `customer-${org.id}` },
  );
  // Another request may have won the race; keep whichever was stored first.
  const { rows } = await query(
    `UPDATE falconmed_v4.organizations SET stripe_customer_id = COALESCE(stripe_customer_id, $2)
      WHERE id = $1 RETURNING stripe_customer_id`,
    [org.id, customer.id],
  );
  return rows[0].stripe_customer_id;
}

/** A Stripe Checkout page for subscribing to `plan`. Unused trial days carry over. */
export async function createCheckout(org, admin, plan) {
  const price = priceForPlan()[plan];
  if (!price) throw new HttpError(503, `The ${plan} plan is not available for online purchase yet.`, 'BILLING_UNAVAILABLE');
  const customer = await ensureCustomer(org, admin);

  const subscriptionData = { metadata: { org_id: org.id } };
  // Stripe needs a trial end at least 48 hours away; with less left, billing starts now.
  const trialEnd = org.plan === 'trial' && org.trial_ends_at ? Math.floor(new Date(org.trial_ends_at).getTime() / 1000) : 0;
  if (trialEnd > Date.now() / 1000 + 49 * 3600) subscriptionData.trial_end = trialEnd;

  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer,
    client_reference_id: org.id,
    line_items: [{ price, quantity: 1 }],
    subscription_data: subscriptionData,
    allow_promotion_codes: true,
    billing_address_collection: 'required',
    customer_update: { address: 'auto', name: 'auto' },
    success_url: `${env.APP_URL}/billing?checkout=success`,
    cancel_url: `${env.APP_URL}/billing?checkout=cancelled`,
    integration_identifier: INTEGRATION_ID,
  });
  return session.url;
}

/** Stripe's Customer Portal: change plan, update card, download invoices, cancel. */
export async function createPortal(org) {
  if (!org.stripe_customer_id) throw new HttpError(409, 'There is no subscription to manage yet. Choose a plan first.', 'NO_SUBSCRIPTION');
  const session = await stripe().billingPortal.sessions.create({
    customer: org.stripe_customer_id,
    return_url: `${env.APP_URL}/billing`,
  });
  return session.url;
}

/** Cancel straight away (used when an organisation deletes itself). */
export async function cancelSubscriptionNow(subscriptionId) {
  try {
    await stripe().subscriptions.cancel(subscriptionId, { prorate: false });
  } catch (err) {
    // Already cancelled: nothing left to stop.
    if (err?.code === 'resource_missing' || /canceled/.test(err?.message ?? '')) return;
    throw err;
  }
}

async function orgForCustomer(customerId) {
  if (!customerId) return null;
  const id = typeof customerId === 'string' ? customerId : customerId.id;
  const { rows } = await query('SELECT * FROM falconmed_v4.organizations WHERE stripe_customer_id = $1', [id]);
  return rows[0] ?? null;
}

/** Copy a subscription's current state from Stripe onto its organisation. */
export async function syncSubscription(subscriptionId) {
  const sub = await stripe().subscriptions.retrieve(subscriptionId);
  const org = await orgForCustomer(sub.customer);
  if (!org) {
    console.warn(`stripe: subscription ${sub.id} belongs to an unknown customer`);
    return null;
  }
  // An organisation has one subscription. A stale event about an older one must not overwrite the current one.
  const current = org.stripe_subscription_id;
  const isLive = !['canceled', 'incomplete_expired'].includes(sub.status);
  if (current && current !== sub.id && !isLive) return org;

  const items = sub.items?.data ?? [];
  const plan = items.map((i) => planForPrice(i.price?.id)).find(Boolean);
  const periodEnd = Math.max(0, ...items.map((i) => i.current_period_end ?? 0));

  const { rows } = await query(
    `UPDATE falconmed_v4.organizations
        SET stripe_subscription_id = $2, subscription_status = $3,
            plan = CASE WHEN plan IN ('demo', 'enterprise') THEN plan ELSE COALESCE($4, plan) END,
            current_period_end = $5, cancel_at_period_end = $6
      WHERE id = $1 RETURNING *`,
    [org.id, sub.id, sub.status, isLive ? plan : null, periodEnd ? new Date(periodEnd * 1000) : null, Boolean(sub.cancel_at_period_end || sub.cancel_at)],
  );
  return rows[0];
}

async function emailAdmins(orgId, { subject, lines }) {
  const { rows } = await query(
    `SELECT email, full_name FROM falconmed_v4.users WHERE org_id = $1 AND role = 'admin' AND is_active`,
    [orgId],
  );
  for (const a of rows) {
    await sendEmail({ to: a.email, subject, greeting: `Hello ${a.full_name},`, lines, action: { label: 'Open billing', url: `${env.APP_URL}/billing` } });
  }
}

/** Handle one verified webhook event. Unhandled event types are acknowledged and ignored. */
export async function handleEvent(event) {
  const obj = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (obj.mode !== 'subscription' || !obj.subscription) return;
      const org = await orgForCustomer(obj.customer);
      if (!org) return console.warn(`stripe: checkout ${obj.id} for an unknown customer`);
      const synced = await syncSubscription(typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id);
      await audit(null, 'billing.subscribed', { orgId: org.id, meta: { plan: synced?.plan, status: synced?.subscription_status } });
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed': {
      const synced = await syncSubscription(obj.id);
      if (synced) await audit(null, `billing.${event.type.split('.').pop()}`, { orgId: synced.id, meta: { plan: synced.plan, status: synced.subscription_status } });
      return;
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const org = await orgForCustomer(obj.customer);
      if (!org) return;
      if (org.stripe_subscription_id) await syncSubscription(org.stripe_subscription_id);
      if (event.type === 'invoice.payment_failed') {
        await audit(null, 'billing.payment_failed', { orgId: org.id, target: obj.id });
        await emailAdmins(org.id, {
          subject: 'Payment failed for FalconMed Elite',
          lines: [
            'We could not take the latest payment for your subscription. Stripe will retry automatically.',
            'Please update your payment method to avoid interruption.',
          ],
        });
      }
      return;
    }
    // Risk events: recorded for review. Money is at risk, so they are logged loudly.
    case 'charge.dispute.created':
    case 'charge.refunded':
    case 'radar.early_fraud_warning.created': {
      const charge = event.type === 'charge.refunded' ? obj : null;
      const customer = charge?.customer ?? (typeof obj.charge === 'object' ? obj.charge?.customer : null);
      let org = await orgForCustomer(customer);
      if (!org && typeof obj.charge === 'string') {
        const ch = await stripe().charges.retrieve(obj.charge);
        org = await orgForCustomer(ch.customer);
      }
      console.warn(`stripe: ${event.type} ${obj.id} (org ${org?.id ?? 'unknown'}) — review in the Stripe Dashboard`);
      await audit(null, `billing.${event.type.replace(/^charge\.|^radar\./, '')}`, { orgId: org?.id ?? null, target: obj.id });
      return;
    }
    default:
  }
}

/** Process each event once. Returns false when the event was already handled. */
export async function processWebhook(rawBody, signature) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(503, 'Billing is not configured on this server yet.', 'BILLING_UNAVAILABLE');
  let event;
  try {
    event = stripe().webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'Invalid Stripe signature', 'BAD_SIGNATURE');
  }
  const { rows } = await query('SELECT 1 FROM falconmed_v4.stripe_events WHERE id = $1', [event.id]);
  if (rows.length) return false;
  await handleEvent(event);
  await query('INSERT INTO falconmed_v4.stripe_events (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING', [event.id, event.type]);
  return true;
}
