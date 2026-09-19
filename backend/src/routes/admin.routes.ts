/**
 * Administrative actions that are deliberate, rare and destructive.
 *
 * Kept apart from the resource routers so nothing here can be reached by a
 * plausible-looking typo of a normal call: the wipe demands an explicit
 * confirmation phrase in the body, and it never touches configuration (settings,
 * the product catalog) or the OpenAlex cache — wiping the CRM is about starting
 * a lead pipeline again, not about forgetting how discovery is set up.
 */
import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncHandler } from '../middleware/errorHandler.js';
import { ActivityLogModel } from '../models/activityLog.model.js';
import { EmailThreadModel } from '../models/emailThread.model.js';
import { LeadModel } from '../models/lead.model.js';
import { logActivity } from '../services/activity/activityService.js';

export const adminRouter = Router();

const WIPE_PHRASE = 'WIPE';

const wipeSchema = z.object({
  confirm: z.literal(WIPE_PHRASE, {
    errorMap: () => ({ message: `Type ${WIPE_PHRASE} to confirm` }),
  }),
});

// GET /api/admin/crm-stats — what a wipe would remove, for the confirmation dialog.
adminRouter.get(
  '/crm-stats',
  asyncHandler(async (_req, res) => {
    const [leads, threads, activity] = await Promise.all([
      LeadModel.countDocuments(),
      EmailThreadModel.countDocuments(),
      ActivityLogModel.countDocuments(),
    ]);
    res.json({ leads, threads, activity });
  }),
);

/**
 * POST /api/admin/wipe-crm — deletes every lead, email thread and activity
 * entry. Settings, the product catalog and the OpenAlex cache are kept.
 */
adminRouter.post(
  '/wipe-crm',
  asyncHandler(async (req, res) => {
    const parsed = wipeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw ApiError.badRequest(`Refused: type ${WIPE_PHRASE} to confirm wiping the CRM`);
    }

    const [leads, threads, activity] = await Promise.all([
      LeadModel.deleteMany({}),
      EmailThreadModel.deleteMany({}),
      ActivityLogModel.deleteMany({}),
    ]);

    // The one entry that survives: the wipe itself, so the feed is not simply
    // empty with no explanation.
    await logActivity({
      type: 'system_error',
      severity: 'warning',
      message: `CRM wiped — ${leads.deletedCount} leads, ${threads.deletedCount} threads and ${activity.deletedCount} activity entries removed`,
      metadata: { wipe: true },
    });

    res.json({
      leads: leads.deletedCount,
      threads: threads.deletedCount,
      activity: activity.deletedCount,
    });
  }),
);
