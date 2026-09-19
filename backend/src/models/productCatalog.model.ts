/**
 * Mongoose schema for `product_catalog`.
 *
 * This is what grounds the AI: relevance scoring and product mapping compare a
 * researcher's work against these records, so "which product fits this lead"
 * has a real catalog behind it instead of the model inventing product names.
 */
import { Schema, model, type InferSchemaType } from 'mongoose';

const productSchema = new Schema(
  {
    // Stable slug referenced from `Lead.aiScoring.recommendedProductIds`.
    // A string, not an ObjectId reference — Firestore has no joins, so cross-
    // collection links are plain denormalised keys everywhere.
    productId: { type: String, required: true, unique: true, trim: true },

    name: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: [
        'potentiostat_portable',
        'potentiostat_benchtop',
        'multi_channel_workstation',
        'single_channel_workstation',
        'biosensor_kit',
        'spectroelectrochemistry',
        'application_kit',
        'oem_module',
        'battery_equipment',
        'thin_film_deposition',
        'electrode',
        'software_sdk',
        'accessory',
      ],
      required: true,
    },
    tags: { type: [String], default: [] },
    description: String,
    applicationAreas: { type: [String], default: [] },
    sdkSupport: { type: [String], default: [] },

    isActive: { type: Boolean, default: true },
    sourceUrl: String,
    lastSyncedAt: Date,
  },
  {
    timestamps: true,
    collection: 'product_catalog',
    minimize: false,
  },
);

productSchema.index({ category: 1 });
productSchema.index({ tags: 1 });
productSchema.index({ applicationAreas: 1 });

export type ProductDocument = InferSchemaType<typeof productSchema>;
export const ProductModel = model('Product', productSchema);
