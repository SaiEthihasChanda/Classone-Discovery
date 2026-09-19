import { ProductModel } from '../../models/productCatalog.model.js';
import type { Product, ProductCreateInput } from '../../types/domain.js';
import { MongoRepository } from './mongo.repository.js';
import { where } from '../base.repository.js';

export class MongoProductRepository extends MongoRepository<Product, ProductCreateInput> {
  constructor() {
    super(ProductModel);
  }

  async findByProductId(productId: string): Promise<Product | null> {
    return this.findOne([where.eq('productId', productId)]);
  }

  async findActive(): Promise<Product[]> {
    return this.find({
      filter: [where.eq('isActive', true)],
      options: { sort: { category: 1, name: 1 }, limit: 500 },
    });
  }

  /**
   * Inserts or updates by `productId`.
   *
   * The seed script is re-runnable, so it must not create duplicates on a second
   * run. Firestore's `set(..., { merge: true })` on a known document id is the
   * direct equivalent of this upsert.
   */
  /**
   * Retires every product whose id is not in `keepIds` — used after a seed so
   * withdrawn or placeholder products stop being offered to the scorer, while
   * leads that reference them keep resolving.
   */
  async deactivateAllExcept(keepIds: string[]): Promise<number> {
    const result = await ProductModel.updateMany(
      { productId: { $nin: keepIds }, isActive: true },
      { $set: { isActive: false } },
    ).exec();
    return result.modifiedCount;
  }

  async upsertByProductId(data: ProductCreateInput): Promise<Product> {
    const doc = await ProductModel.findOneAndUpdate(
      { productId: data.productId },
      { $set: data },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    )
      .lean()
      .exec();
    return this.toDomain(doc as Record<string, any>)!;
  }
}
