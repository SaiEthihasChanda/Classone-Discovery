/**
 * 24-hour cache of OpenAlex responses.
 *
 * OpenAlex charges per request, and discovery re-issues identical requests
 * constantly: the same topic groups against the same institutes, a second run
 * after tweaking a setting, the smoke test, a name that was just looked up.
 * The underlying data changes on a weekly cadence, so serving yesterday's
 * response is indistinguishable from a fresh one — and free.
 *
 * Mongo's TTL index does the expiry; nothing in application code sweeps it.
 */
import { Schema, model } from 'mongoose';

const CACHE_TTL_SECONDS = 24 * 60 * 60;

const openAlexCacheSchema = new Schema(
  {
    // sha256 of the request URL minus credentials, so the same query with a
    // different api_key or mailto still hits.
    key: { type: String, required: true, unique: true },
    url: { type: String, required: true },
    body: { type: Schema.Types.Mixed, required: true },
    creditsSaved: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now, expires: CACHE_TTL_SECONDS },
  },
  { collection: 'openalex_cache', minimize: false },
);

export const OpenAlexCacheModel = model('OpenAlexCache', openAlexCacheSchema);
