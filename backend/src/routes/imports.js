import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, notFound, parse } from '../lib/http.js';
import { requireAuth, requireEntitlement, requireRole } from '../middleware/auth.js';
import { analyse, commitImport, deleteBatch, listBatches } from '../services/importer.js';

const router = Router();
router.use(requireAuth, requireRole('admin', 'manager'), requireEntitlement);

const body = z.object({
  csv: z.string().min(1, 'The file is empty').max(8 * 1024 * 1024, 'The file is larger than 8 MB'),
  fileName: z.string().max(200).default('upload.csv'),
  defaultBranchId: z.string().max(40).optional(),
});

/** POST /api/imports/validate — quality report only; nothing is written. */
router.post(
  '/validate',
  asyncHandler(async (req, res) => {
    const { csv, fileName, defaultBranchId } = parse(body, req.body);
    const { report } = await analyse(csv, { user: req.user, defaultBranchId, fileName });
    res.json({ success: true, data: report });
  }),
);

/** POST /api/imports — validate again on the server, then import the valid rows as one batch. */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { csv, fileName, defaultBranchId } = parse(body, req.body);
    const result = await commitImport(csv, { user: req.user, defaultBranchId, fileName });
    res.status(201).json({ success: true, data: result });
  }),
);

/** GET /api/imports — import history visible to the user. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await listBatches(req.user) });
  }),
);

/** DELETE /api/imports/:id — roll back an import and all of its tickets. */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const removed = await deleteBatch(req.user, id);
    if (!removed) throw notFound('Import not found');
    res.json({ success: true, data: removed });
  }),
);

export default router;
