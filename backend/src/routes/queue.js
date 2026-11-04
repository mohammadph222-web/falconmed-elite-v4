import { Router } from 'express';
import { z } from 'zod';
import { query } from '../config/db.js';
import { asyncHandler, forbidden, parse } from '../lib/http.js';
import { assertInOrg } from '../lib/scope.js';
import { requireAuth, requireEntitlement, requireQueueKeyOrStaff, requireRole } from '../middleware/auth.js';
import * as queue from '../services/queue.js';

const router = Router();

const ticketSchema = z.object({
  branchId: z.string().min(1).max(40),
  serviceType: z.enum(['prescription', 'refill', 'consultation', 'otc', 'insurance']).default('prescription'),
  source: z.enum(['kiosk', 'mobile', 'walk_in', 'simulator']).default('kiosk'),
  identified: z.boolean().default(true),
  patientRef: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Za-z0-9-]+$/, 'patientRef must be a de-identified code, not a name')
    .optional(),
});

/**
 * A queue key only reaches its own organisation's branches, or the one
 * branch it was created for. The legacy shared key reaches demo organisations only.
 */
async function assertKeyReaches(key, branchId) {
  if (key.branchId && key.branchId !== branchId) throw forbidden('This queue key is for a different branch');
  const { rows } = key.legacy
    ? await query(
        `SELECT 1 FROM falconmed_v4.branches b JOIN falconmed_v4.organizations o ON o.id = b.org_id
          WHERE b.id = $1 AND o.plan = 'demo'`,
        [branchId],
      )
    : await query('SELECT 1 FROM falconmed_v4.branches WHERE id = $1 AND org_id = $2', [branchId, key.orgId]);
  if (!rows.length) throw forbidden('That branch is not part of this queue key\'s organisation');
}

/** POST /api/queue/tickets — patient arrival from the queue machine (X-Queue-Key) or the simulator. */
router.post(
  '/tickets',
  requireQueueKeyOrStaff,
  asyncHandler(async (req, res) => {
    const body = parse(ticketSchema, req.body);
    if (req.user?.role === 'manager' && body.branchId !== req.user.branch_id) {
      throw forbidden('Managers can only register tickets for their own branch');
    }
    if (req.user) await assertInOrg(req.user, { branchId: body.branchId });
    if (req.queueKey) await assertKeyReaches(req.queueKey, body.branchId);
    else body.source = 'simulator';
    const ticket = await queue.createTicket(body);
    res.status(201).json({ success: true, data: ticket });
  }),
);

router.use(requireAuth, requireEntitlement);

/** GET /api/queue/live?branchId= — open tickets, last-hour pulse and alerts. */
router.get(
  '/live',
  asyncHandler(async (req, res) => {
    const { branchId } = parse(z.object({ branchId: z.string().max(40).optional() }), req.query);
    let target = branchId ?? null;
    if (req.user.role !== 'admin') {
      if (branchId && branchId !== req.user.branch_id) throw forbidden();
      target = req.user.branch_id;
    }
    await assertInOrg(req.user, { branchId: target });
    res.json({ success: true, data: await queue.liveBoard({ orgId: req.user.org_id, branchId: target }) });
  }),
);

/** GET /api/queue/current — the ticket at my counter. */
router.get(
  '/current',
  requireRole('pharmacist'),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await queue.currentTicket(req.user.id) });
  }),
);

/** POST /api/queue/call-next — call the longest-waiting patient to my counter. */
router.post(
  '/call-next',
  requireRole('pharmacist'),
  asyncHandler(async (req, res) => {
    const ticket = await queue.callNext(req.user);
    res.json({ success: true, data: ticket, message: ticket ? undefined : 'No patients waiting' });
  }),
);

/** POST /api/queue/tickets/:id/complete — { outcome: 'served' | 'no_show' } */
router.post(
  '/tickets/:id/complete',
  requireRole('pharmacist'),
  asyncHandler(async (req, res) => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const { outcome } = parse(z.object({ outcome: z.enum(['served', 'no_show']).default('served') }), req.body);
    res.json({ success: true, data: await queue.completeTicket(req.user, id, outcome) });
  }),
);

export default router;
