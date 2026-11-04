import { Router } from 'express';
import { asyncHandler, forbidden } from '../lib/http.js';
import { assertInOrg, parseRange, resolveScope } from '../lib/scope.js';
import { requireAuth, requireEntitlement } from '../middleware/auth.js';
import * as metrics from '../services/metrics.js';

const router = Router();
router.use(requireAuth, requireEntitlement);

/**
 * Every metric endpoint accepts ?from=YYYY-MM-DD&to=YYYY-MM-DD and optional
 * ?branchId= / ?pharmacistId=. The scope is always narrowed to what the
 * signed-in user is allowed to see (see lib/scope.js).
 */
const handler = (fn) =>
  asyncHandler(async (req, res) => {
    const scope = resolveScope(req.user, req.query);
    await assertInOrg(req.user, scope);
    const range = parseRange(req.query);
    const data = await fn(scope, range, req);
    res.json({ success: true, scope, data });
  });

router.get('/summary', handler((s, r) => metrics.summary(s, r)));
router.get('/hourly', handler((s, r) => metrics.hourly(s, r)));
router.get('/daily', handler((s, r) => metrics.daily(s, r)));
router.get('/mix', handler((s, r) => metrics.mix(s, r)));

router.get(
  '/staff',
  handler((s, r, req) => {
    if (req.user.role === 'pharmacist') throw forbidden('Staff comparison is available to managers and admins');
    return metrics.staff(s, r);
  }),
);

router.get(
  '/branches',
  handler((s, r, req) => {
    if (req.user.role !== 'admin') throw forbidden('Branch comparison is available to admins');
    return metrics.branches(s, r);
  }),
);

export default router;
