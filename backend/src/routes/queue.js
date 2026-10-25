import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, forbidden, parse } from '../lib/http.js';
import { requireAuth, requireQueueKeyOrStaff, requireRole } from '../middleware/auth.js';
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

/** POST /api/queue/tickets — patient arrival from the queue machine (X-Queue-Key) or the simulator. */
router.post(
  '/tickets',
  requireQueueKeyOrStaff,
  asyncHandler(async (req, res) => {
    const body = parse(ticketSchema, req.body);
    if (req.user?.role === 'manager' && body.branchId !== req.user.branch_id) {
      throw forbidden('Managers can only register tickets for their own branch');
    }
    if (!req.viaQueueKey) body.source = 'simulator';
    const ticket = await queue.createTicket(body);
    res.status(201).json({ success: true, data: ticket });
  }),
);

router.use(requireAuth);

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
    res.json({ success: true, data: await queue.liveBoard(target) });
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
