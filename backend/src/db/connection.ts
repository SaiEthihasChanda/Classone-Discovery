import mongoose from 'mongoose';
import { env } from '../config/env.js';

/**
 * Connects to MongoDB.
 *
 * Called once at startup and awaited before the HTTP server binds, so the API
 * never accepts a request it cannot serve.
 */
export async function connectDatabase(): Promise<void> {
  mongoose.set('strictQuery', true);

  try {
    await mongoose.connect(env.MONGO_URI, {
      dbName: env.MONGO_DB_NAME,
      // Fail fast with a clear error instead of hanging for the 30s default when
      // the Atlas IP allowlist blocks this machine — by far the most common
      // first-run problem.
      serverSelectionTimeoutMS: 10_000,
    });
    console.log(`[db] connected to MongoDB (database: ${env.MONGO_DB_NAME})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `\n[db] Could not connect to MongoDB.\n` +
        `     ${message}\n\n` +
        `     Common causes:\n` +
        `       - This machine's IP is not on the Atlas Network Access allowlist\n` +
        `       - Wrong password in MONGO_URI (the <db_password> placeholder is still there)\n` +
        `       - The cluster is paused\n`,
    );
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

export type DatabaseState = 'connected' | 'connecting' | 'disconnected' | 'disconnecting';

/**
 * Backs the `/health` endpoint's database section.
 * Mongoose also reports 99 ("uninitialized"), which is reported as disconnected.
 */
export function databaseState(): DatabaseState {
  const states: Record<number, DatabaseState> = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };
  return states[mongoose.connection.readyState] ?? 'disconnected';
}
