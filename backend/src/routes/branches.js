import { Router } from 'express';
import { query } from '../config/db.js';
import { asyncHandler } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

/** GET /api/branches — branches the user may see, with their pharmacists. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const params = [req.user.org_id];
    let filter = 'b.is_active AND b.org_id = $1';
    if (req.user.role !== 'admin') {
      params.push(req.user.branch_id);
      filter += ' AND b.id = $2';
    }
    const { rows } = await query(
      `SELECT b.id, b.name, b.city, b.counters,
              COALESCE(json_agg(json_build_object('id', u.id, 'name', u.full_name, 'counterNo', u.counter_no)
                       ORDER BY u.counter_no) FILTER (WHERE u.id IS NOT NULL), '[]') AS pharmacists
         FROM falconmed_v4.branches b
    LEFT JOIN falconmed_v4.users u ON u.branch_id = b.id AND u.role = 'pharmacist' AND u.is_active
        WHERE ${filter}
     GROUP BY b.id
     ORDER BY b.name`,
      params,
    );
    res.json({ success: true, data: rows });
  }),
);

export default router;
