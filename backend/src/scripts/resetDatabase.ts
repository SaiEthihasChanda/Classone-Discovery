/**
 * Wipes the configured database and re-seeds the product catalog.
 *
 * Drops every collection — leads, email threads, activity log, settings and the
 * catalog — then re-inserts the catalog from `catalogData.ts`. Settings re-seed
 * themselves from the files the next time the backend reads them.
 *
 * DEVELOPMENT ONLY. Refuses to run against anything that is not a local
 * MongoDB, so it cannot be pointed at Atlas by accident.
 *
 * Run:  npm run db:reset
 */
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../db/connection.js';
import { seedProductCatalog } from './catalogData.js';

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

async function main(): Promise<void> {
  const host = new URL(env.MONGO_URI.replace(/^mongodb(\+srv)?:\/\//, 'http://')).hostname;
  if (!LOCAL_HOSTS.includes(host)) {
    console.error(`[db:reset] refusing to wipe a non-local database (${host}). Do it by hand.`);
    process.exit(1);
  }

  await connectDatabase();

  const db = mongoose.connection.db;
  if (!db) throw new Error('No database handle after connecting');

  const collections = await db.listCollections().toArray();
  for (const { name } of collections) {
    await db.dropCollection(name);
    console.log(`[db:reset] dropped ${name}`);
  }
  if (collections.length === 0) console.log('[db:reset] database was already empty');

  const count = await seedProductCatalog();
  console.log(`[db:reset] re-seeded ${count} catalog products`);
  console.log('[db:reset] settings will re-seed from the files on the next backend read');

  await disconnectDatabase();
}

main().catch(async (error) => {
  console.error('[db:reset] failed:', error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
