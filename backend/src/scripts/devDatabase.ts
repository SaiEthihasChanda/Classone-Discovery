/**
 * Local development MongoDB.
 *
 * Runs a real mongod on a fixed port with a persistent data directory, so the
 * app can run before a MongoDB Atlas cluster exists — no Docker, no system-wide
 * MongoDB install, and data survives restarts.
 *
 * The binary is downloaded once on first run (~100 MB) and cached.
 *
 * This is a DEVELOPMENT convenience only. Production uses Atlas via MONGO_URI;
 * nothing else in the codebase depends on this script.
 *
 * Run:  npm run dev:db      (leave it running in its own terminal)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { MongoMemoryServer } from 'mongodb-memory-server';

const PORT = 27017;

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '../../../.mongo-data');

async function main(): Promise<void> {
  mkdirSync(dataDir, { recursive: true });

  console.log('Starting local MongoDB…');
  console.log(`  data directory: ${dataDir}`);
  console.log('  (first run downloads the mongod binary — this can take a minute)\n');

  const server = await MongoMemoryServer.create({
    instance: {
      port: PORT,
      // A real on-disk path, so this is persistent storage rather than a
      // throwaway in-memory instance.
      dbPath: dataDir,
      storageEngine: 'wiredTiger',
    },
  });

  console.log('MongoDB is running.');
  console.log(`  URI: ${server.getUri()}`);
  console.log(`\n  Your .env should contain:`);
  console.log(`    MONGO_URI=mongodb://127.0.0.1:${PORT}`);
  console.log('\nLeave this terminal open. Press Ctrl+C to stop.\n');

  const shutdown = async () => {
    console.log('\nStopping MongoDB…');
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  console.error('Could not start the local database:', error);
  console.error(
    '\nIf the port is already in use, another MongoDB is running — use that one instead.',
  );
  process.exit(1);
});
