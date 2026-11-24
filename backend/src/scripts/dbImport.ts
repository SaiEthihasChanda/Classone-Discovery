/**
 * Loads a file written by db:export into the database in .env (MONGO_URI / MONGO_DB_NAME).
 * Refuses to touch a database that already has data unless --replace is given, which empties
 * each collection in the file before loading it.
 *
 *   npm --prefix backend run db:import -- /path/to/classone-db.ndjson.gz [--replace]
 */
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../db/connection.js';

const { EJSON } = mongoose.mongo.BSON;
const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
const replace = process.argv.includes('--replace');
if (!file) {
  console.error('Usage: npm --prefix backend run db:import -- <file.ndjson.gz> [--replace]');
  process.exit(1);
}

await connectDatabase();
const db = mongoose.connection.db!;
const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
if (!replace) {
  for (const name of existing) {
    if ((await db.collection(name).estimatedDocumentCount()) > 0) {
      console.error(`Database "${db.databaseName}" already has data (${name}). Re-run with --replace to overwrite it.`);
      await disconnectDatabase();
      process.exit(1);
    }
  }
}

const counts = new Map<string, number>();
const cleared = new Set<string>();
const batches = new Map<string, Record<string, unknown>[]>();
const flush = async (name: string) => {
  const docs = batches.get(name);
  if (docs?.length) await db.collection(name).insertMany(docs, { ordered: false });
  batches.set(name, []);
};
const clear = async (name: string) => {
  if (cleared.has(name)) return;
  cleared.add(name);
  if (replace && existing.has(name)) await db.collection(name).deleteMany({});
};

const lines = createInterface({ input: createReadStream(path.resolve(file)).pipe(createGunzip()), crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  const row = EJSON.parse(line, { relaxed: false }) as { index?: string; spec?: Record<string, unknown>; c?: string; d?: Record<string, unknown> };
  if (row.index && row.spec) {
    await clear(row.index);
    const { key, v: _v, ns: _ns, ...options } = row.spec as { key: Record<string, 1 | -1>; v?: number; ns?: string; name?: string };
    await db.collection(row.index).createIndex(key, options).catch((e) => console.warn(`  index ${row.index}.${String(options.name)}: ${e.message}`));
  } else if (row.c && row.d) {
    await clear(row.c);
    const batch = batches.get(row.c) ?? [];
    batch.push(row.d);
    batches.set(row.c, batch);
    counts.set(row.c, (counts.get(row.c) ?? 0) + 1);
    if (batch.length >= 500) await flush(row.c);
  }
}
for (const name of batches.keys()) await flush(name);

for (const [name, n] of [...counts].sort()) console.log(`${name.padEnd(28)} ${n}`);
console.log(`\nLoaded into "${db.databaseName}".`);
await disconnectDatabase();
