/**
 * Sign-in check (Firebase ID token) and role-based access for every API route.
 *
 * Policy, applied by method and path so new routes are covered by default:
 *   - viewer: read only (GET)
 *   - sales:  read + write (draft/approve/send outreach, run pipeline stages, edit leads)
 *   - admin:  everything, incl. deletes, settings changes, /admin and /users
 *   - pending: signed in but not yet granted a role — sees nothing but /me
 *
 * AUTH_ENABLED=false (the local-dev default) attaches a synthetic admin so the
 * app and the smoke tests run without a sign-in.
 */
import type { NextFunction, Request, Response } from 'express';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { env } from '../config/env.js';
import { AppUserModel, type Role } from '../models/appUser.model.js';
import { ApiError } from './errorHandler.js';

export interface AuthUser {
  uid: string;
  email: string;
  name?: string;
  photoUrl?: string;
  role: Role;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

const DEV_USER: AuthUser = { uid: 'dev', email: 'dev@localhost', name: 'Local developer', role: 'admin' };
const INTERNAL_USER: AuthUser = { uid: 'internal', email: 'internal@localhost', name: 'Internal service', role: 'admin' };

function firebaseAuth() {
  if (getApps().length === 0) initializeApp({ projectId: env.FIREBASE_PROJECT_ID });
  return getAuth();
}

/** Upserts the signed-in person; the first sign-in of an ADMIN_EMAILS address makes them admin. */
async function resolveUser(decoded: { uid: string; email?: string; name?: string; picture?: string }): Promise<AuthUser> {
  const email = (decoded.email ?? '').toLowerCase();
  const existing = await AppUserModel.findOne({ uid: decoded.uid }).lean();
  const role: Role = existing?.role ?? (env.adminEmails.includes(email) ? 'admin' : 'pending');

  await AppUserModel.updateOne(
    { uid: decoded.uid },
    {
      $set: { email, name: decoded.name, photoUrl: decoded.picture, lastSeenAt: new Date() },
      $setOnInsert: { role },
    },
    { upsert: true },
  );
  return { uid: decoded.uid, email, name: decoded.name, photoUrl: decoded.picture, role };
}

/** Verifies the bearer token and attaches `req.user`. Does not check the role. */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (!env.authEnabled) {
      req.user = DEV_USER;
      return next();
    }

    const internal = req.header('x-internal-token');
    if (env.INTERNAL_API_TOKEN && internal && internal === env.INTERNAL_API_TOKEN) {
      req.user = INTERNAL_USER;
      return next();
    }

    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new ApiError(401, 'Sign in required');

    let decoded;
    try {
      decoded = await firebaseAuth().verifyIdToken(token);
    } catch {
      throw new ApiError(401, 'Your sign-in has expired — sign in again');
    }
    req.user = await resolveUser(decoded);
    next();
  } catch (error) {
    next(error);
  }
}

function isAdminOnly(req: Request): boolean {
  const path = req.path;
  if (path.startsWith('/admin') || path.startsWith('/users')) return true;
  if (req.method === 'DELETE') return true;
  if (path.startsWith('/settings') && req.method !== 'GET') return true;
  return false;
}

/** Applies the role policy above. Must run after `authenticate`. */
export function authorize(req: Request, _res: Response, next: NextFunction): void {
  const role = req.user?.role;
  if (!role) return next(new ApiError(401, 'Sign in required'));
  if (role === 'pending') return next(new ApiError(403, 'Your account is waiting for an admin to grant access'));
  if (isAdminOnly(req) && role !== 'admin') return next(new ApiError(403, 'Admins only'));
  if (req.method !== 'GET' && role === 'viewer') return next(new ApiError(403, 'Your role is read-only'));
  next();
}
