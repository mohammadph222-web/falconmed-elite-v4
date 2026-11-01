/**
 * Billing — organisation admins choose and manage a plan.
 *
 *   GET  /api/billing            plan, status, limits and usage
 *   POST /api/billing/checkout   { plan: 'starter' | 'pro' } → Stripe Checkout URL
 *   POST /api/billing/portal     → Stripe Customer Portal URL
 *   POST /api/billing/webhook    Stripe events (signed; raw body, mounted separately)
 */
import express, { Router } from 'express';
import { z } from 'zod';
import { query } from '../config/db.js';
import { audit } from '../lib/audit.js';
import { asyncHandler, conflict, forbidden, parse } from '../lib/http.js';
import { entitlement, PLANS, planLimits } from '../lib/plans.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { billingEnabled, createCheckout, createPortal, priceForPlan, processWebhook } from '../services/billing.js';

/** The webhook needs the exact bytes Stripe signed, so it is mounted before the JSON parser. */
export const webhookRouter = Router();
webhookRouter.post(
  '/',
  express.raw({ type: 'application/json', limit: '1mb' }),
  asyncHandler(async (req, res) => {
    const processed = await processWebhook(req.body, req.headers['stripe-signature']);
    res.json({ received: true, duplicate: !processed });
  }),
);

const router = Router();
router.use(requireAuth, requireRole('admin'));

const loadOrg = async (orgId) => (await query('SELECT * FROM falconmed_v4.organizations WHERE id = $1', [orgId])).rows[0];

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const org = await loadOrg(req.user.org_id);
    const { rows } = await query(
      `SELECT (SELECT COUNT(*)::int FROM falconmed_v4.branches WHERE org_id = $1 AND is_active) AS branches,
              (SELECT COUNT(*)::int FROM falconmed_v4.users WHERE org_id = $1 AND is_active) AS users`,
      [org.id],
    );
    const prices = priceForPlan();
    const ent = entitlement(org);
    res.json({
      success: true,
      data: {
        plan: org.plan,
        planLabel: planLimits(org.plan).label,
        status: org.subscription_status,
        trialEndsAt: org.trial_ends_at,
        currentPeriodEnd: org.current_period_end,
        cancelAtPeriodEnd: org.cancel_at_period_end,
        entitled: ent.ok,
        entitlementReason: ent.reason,
        hasCustomer: Boolean(org.stripe_customer_id),
        billingEnabled: billingEnabled(),
        limits: { branches: planLimits(org.plan).branches, users: planLimits(org.plan).users },
        usage: rows[0],
        plans: ['starter', 'pro', 'enterprise'].map((id) => ({
          id,
          label: PLANS[id].label,
          branches: PLANS[id].branches,
          users: PLANS[id].users,
          purchasable: Boolean(prices[id]) && billingEnabled(),
        })),
      },
    });
  }),
);

router.post(
  '/checkout',
  asyncHandler(async (req, res) => {
    const { plan } = parse(z.object({ plan: z.enum(['starter', 'pro']) }), req.body);
    const org = await loadOrg(req.user.org_id);
    if (org.plan === 'demo') throw forbidden('The demo organisation cannot subscribe. Create your own organisation to start a trial.');
    if (!req.user.email_verified_at) throw forbidden('Confirm your email address before subscribing. Check your inbox for the link.');
    if (org.stripe_subscription_id && ['active', 'trialing', 'past_due'].includes(org.subscription_status)) {
      throw conflict('You already have a subscription. Use "Manage subscription" to change plan.');
    }
    const url = await createCheckout(org, req.user, plan);
    await audit(req, 'billing.checkout_started', { meta: { plan } });
    res.json({ success: true, data: { url } });
  }),
);

router.post(
  '/portal',
  asyncHandler(async (req, res) => {
    const org = await loadOrg(req.user.org_id);
    res.json({ success: true, data: { url: await createPortal(org) } });
  }),
);

export default router;
