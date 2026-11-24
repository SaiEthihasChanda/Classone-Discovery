/**
 * People who can sign in, and their role. Keyed by Firebase uid; roles live
 * here (not in Firebase custom claims) so an admin can change them in the app
 * and the API needs no service-account key — verifying a sign-in token only
 * needs the Firebase project id.
 */
import { Schema, model } from 'mongoose';

export const ROLES = ['admin', 'sales', 'viewer', 'pending'] as const;
export type Role = (typeof ROLES)[number];

const appUserSchema = new Schema(
  {
    uid: { type: String, required: true, unique: true },
    email: { type: String, required: true, index: true },
    name: String,
    photoUrl: String,
    role: { type: String, enum: ROLES, default: 'pending', required: true },
    lastSeenAt: Date,
  },
  { timestamps: true, collection: 'users' },
);

export const AppUserModel = model('AppUser', appUserSchema);
