/**
 * Repository selection — the single place the app learns which database it is on.
 *
 * Everything else imports `repositories` from here and never names a backend.
 * Adding Firestore later means writing `repositories/firestore/*`, adding a
 * branch to this switch, and flipping `DB_PROVIDER` in `.env`. No call site changes.
 */
import { env } from '../config/env.js';
import { MongoActivityLogRepository } from './mongo/activityLog.repository.js';
import { MongoEmailThreadRepository } from './mongo/emailThread.repository.js';
import { MongoLeadRepository } from './mongo/lead.repository.js';
import { MongoProductRepository } from './mongo/productCatalog.repository.js';

export interface RepositoryBundle {
  leads: MongoLeadRepository;
  threads: MongoEmailThreadRepository;
  activity: MongoActivityLogRepository;
  products: MongoProductRepository;
}

function buildRepositories(): RepositoryBundle {
  switch (env.DB_PROVIDER) {
    case 'mongo':
      return {
        leads: new MongoLeadRepository(),
        threads: new MongoEmailThreadRepository(),
        activity: new MongoActivityLogRepository(),
        products: new MongoProductRepository(),
      };
    case 'firestore':
      // Planned migration target. Implement `repositories/firestore/*` against
      // the same `Repository` interface, then return the bundle here.
      throw new Error(
        'DB_PROVIDER=firestore is not implemented yet. Set DB_PROVIDER=mongo in .env.',
      );
    default: {
      const exhaustive: never = env.DB_PROVIDER;
      throw new Error(`Unknown DB_PROVIDER: ${String(exhaustive)}`);
    }
  }
}

export const repositories: RepositoryBundle = buildRepositories();

export * from './base.repository.js';
