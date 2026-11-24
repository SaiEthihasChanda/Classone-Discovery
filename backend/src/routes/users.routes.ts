import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncHandler } from '../middleware/errorHandler.js';
import { AppUserModel, ROLES } from '../models/appUser.model.js';

/** Admin-only (enforced by `authorize` on the /users prefix): who can sign in, and their role. */
export const usersRouter = Router();

usersRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const users = await AppUserModel.find({}).sort({ role: 1, email: 1 }).lean();
    res.json({
      items: users.map((u) => ({ uid: u.uid, email: u.email, name: u.name, photoUrl: u.photoUrl, role: u.role, lastSeenAt: u.lastSeenAt })),
    });
  }),
);

usersRouter.patch(
  '/:uid',
  asyncHandler(async (req, res) => {
    const { role } = z.object({ role: z.enum(ROLES) }).parse(req.body);
    // An admin demoting themselves could leave the app with no admin at all.
    if (req.params.uid === req.user?.uid) throw new ApiError(400, "You can't change your own role");
    const updated = await AppUserModel.findOneAndUpdate({ uid: req.params.uid }, { $set: { role } }, { new: true }).lean();
    if (!updated) throw ApiError.notFound('User');
    res.json({ uid: updated.uid, email: updated.email, name: updated.name, role: updated.role });
  }),
);
