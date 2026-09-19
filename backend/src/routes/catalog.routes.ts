import { Router } from 'express';
import { z } from 'zod';
import { repositories, where, type Filter } from '../repositories/index.js';
import { ApiError, asyncHandler } from '../middleware/errorHandler.js';
import { slugify } from '../utils/normalize.js';

export const catalogRouter = Router();

const productSchema = z.object({
  productId: z.string().trim().optional(),
  name: z.string().trim().min(1),
  category: z.enum([
    'potentiostat_portable',
    'potentiostat_benchtop',
    'multi_channel_workstation',
    'single_channel_workstation',
    'biosensor_kit',
    'spectroelectrochemistry',
    'software_sdk',
    'accessory',
  ]),
  tags: z.array(z.string()).default([]),
  description: z.string().trim().optional(),
  applicationAreas: z.array(z.string()).default([]),
  sdkSupport: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
  sourceUrl: z.string().url().optional().or(z.literal('')),
});

// GET /api/catalog
catalogRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { category, activeOnly } = req.query;

    const filter: Filter = [];
    if (typeof category === 'string' && category) filter.push(where.eq('category', category));
    if (activeOnly === 'true') filter.push(where.eq('isActive', true));

    const items = await repositories.products.find({
      filter,
      options: { sort: { category: 1, name: 1 }, limit: 500 },
    });
    res.json({ items, total: items.length });
  }),
);

// POST /api/catalog — upsert by productId so re-seeding never duplicates.
catalogRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = productSchema.parse(req.body);
    const product = await repositories.products.upsertByProductId({
      ...body,
      productId: body.productId || slugify(body.name),
      lastSyncedAt: new Date(),
    });
    res.status(201).json(product);
  }),
);

// DELETE /api/catalog/:id
catalogRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const deleted = await repositories.products.deleteById(req.params.id!);
    if (!deleted) throw ApiError.notFound('Product');
    res.status(204).send();
  }),
);
