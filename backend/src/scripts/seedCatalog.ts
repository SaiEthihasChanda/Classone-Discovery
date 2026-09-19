/**
 * Seeds `product_catalog` with Class One Systems' product line.
 *
 * The product data itself lives in `catalogData.ts` so the live smoke test can
 * populate a throwaway database from the same source of truth.
 *
 * Re-runnable: upserts by `productId`, so running it twice updates rather than
 * duplicating.
 *
 * Run:  npm run seed:catalog
 */
import { connectDatabase, disconnectDatabase } from '../db/connection.js';
import { repositories } from '../repositories/index.js';
import { CATALOG, seedProductCatalog } from './catalogData.js';

async function main(): Promise<void> {
  await connectDatabase();

  // Counted before seeding so the summary can distinguish new from updated.
  const before = await repositories.products.count();
  const synced = await seedProductCatalog();
  const after = await repositories.products.count();

  console.log(
    `[seed] catalog synced — ${synced} products (${after - before} new, ${synced - (after - before)} updated)`,
  );

  await disconnectDatabase();
}

main().catch((error) => {
  console.error('[seed] failed:', error);
  process.exit(1);
});

export { CATALOG };
