import { Router } from 'express';
import { z } from 'zod';
import { repositories, where } from '../repositories/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { approveAndSendOutreach, markReplied, rejectDraft } from '../services/email/outreachService.js';

export const threadsRouter = Router();

const listQuerySchema = z.object({
  status: z.enum(['draft', 'open', 'replied', 'closed']).optional(),
});

/**
 * GET /api/threads — the Outreach page's list. Defaults to pending drafts
 * (what the page exists to show); pass ?status= for any other view.
 *
 * Each item carries the lead's name/institution for display — fetched here
 * (plain reads, not a query-level join) rather than making the page issue one
 * request per row.
 */
threadsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { status } = listQuerySchema.parse(req.query);
    const items = await repositories.threads.find({
      filter: [where.eq('status', status ?? 'draft')],
      options: { sort: { updatedAt: -1 }, limit: 200 },
    });

    const leads = await Promise.all(items.map((t) => repositories.leads.findById(t.leadId)));
    const enriched = items.map((thread, i) => ({
      ...thread,
      leadName: leads[i]?.person.name,
      leadInstitution: leads[i]?.institution.name,
    }));

    res.json({ items: enriched });
  }),
);

// POST /api/threads/:id/approve-send — sends the pending draft. The only path that actually sends email.
threadsRouter.post(
  '/:id/approve-send',
  asyncHandler(async (req, res) => {
    res.json(await approveAndSendOutreach(req.params.id!));
  }),
);

// POST /api/threads/:id/reject-draft — discards the pending draft without sending it.
threadsRouter.post(
  '/:id/reject-draft',
  asyncHandler(async (req, res) => {
    res.json(await rejectDraft(req.params.id!));
  }),
);

// POST /api/threads/:id/mark-replied — manual reply detection; closes the thread.
threadsRouter.post(
  '/:id/mark-replied',
  asyncHandler(async (req, res) => {
    res.json(await markReplied(req.params.id!));
  }),
);
