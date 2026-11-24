/**
 * Writes the whole database to one gzipped file, to move it to another MongoDB (the server).
 * Needs no MongoDB tools installed: it uses the driver the backend already has, and Extended JSON,
 * so ObjectIds and dates come back exactly as they were. Indexes are written too.
 *
 *   npm --prefix backend run db:export -- ../classone-db.ndjson.gz
 *
 * One JSON object per line: {"index": collection, spec} or {"c": collection, "d": document}.
 */
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../db/connection.js';

const { EJSON } = mongoose.mongo.BSON;
const out = path.resolve(process.argv[2] ?? 'classone-db.ndjson.gz');

await connectDatabase();
const db = mongoose.connection.db!;
const gz = createGzip();
const done = new Promise<void>((resolve, reject) => gz.pipe(createWriteStream(out)).on('finish', resolve).on('error', reject));
const write = (line: unknown) => new Promise<void>((resolve) => (gz.write(EJSON.stringify(line, { relaxed: false }) + '\n') ? resolve() : gz.once('drain', resolve)));

const collections = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.')).sort();
for (const name of collections) {
  const coll = db.collection(name);
  for (const spec of await coll.indexes()) if (spec.name !== '_id_') await write({ index: name, spec });
  let n = 0;
  for await (const d of coll.find()) {
    await write({ c: name, d });
    n++;
  }
  console.log(`${name.padEnd(28)} ${n}`);
}
gz.end();
await done;
console.log(`\nWrote ${out}`);
await disconnectDatabase();
