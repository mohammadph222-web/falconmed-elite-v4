/**
 * What each plan includes. `null` means unlimited.
 * Prices live in Stripe (STRIPE_PRICE_* env vars); this file only sets limits.
 */
export const PLANS = {
  trial: { label: 'Free trial', branches: 3, users: 25 },
  starter: { label: 'Starter', branches: 2, users: 20 },
  pro: { label: 'Pro', branches: 15, users: 200 },
  enterprise: { label: 'Enterprise', branches: null, users: null },
  demo: { label: 'Demo', branches: null, users: null },
};

/** Stripe statuses that keep a paid organisation working. past_due is a grace period while Stripe retries. */
const PAID_OK = new Set(['active', 'trialing', 'past_due']);

/**
 * Can this organisation use the product right now?
 * Takes a row with plan, trial_ends_at and subscription_status (organizations or loadUser()).
 */
export function entitlement(org, now = Date.now()) {
  const plan = org.plan ?? org.org_plan;
  if (plan === 'demo' || plan === 'enterprise') return { ok: true, reason: null };
  if (plan === 'trial') {
    const ends = org.trial_ends_at ? new Date(org.trial_ends_at).getTime() : 0;
    return ends > now ? { ok: true, reason: null } : { ok: false, reason: 'trial_ended' };
  }
  return PAID_OK.has(org.subscription_status) ? { ok: true, reason: null } : { ok: false, reason: 'subscription_inactive' };
}

export const planLimits = (plan) => PLANS[plan] ?? PLANS.trial;
