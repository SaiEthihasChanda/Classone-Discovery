/** Small key/value facts the server must remember across restarts (e.g. the last day a digest went out). */
import { Schema, model } from 'mongoose';

const systemStateSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    value: Schema.Types.Mixed,
  },
  { collection: 'system_state', timestamps: true, versionKey: false },
);

export const SystemStateModel = model('SystemState', systemStateSchema);

export async function getState<T>(key: string): Promise<T | undefined> {
  const d = (await SystemStateModel.findOne({ key }).lean()) as { value?: T } | null;
  return d?.value;
}

export async function setState(key: string, value: unknown): Promise<void> {
  await SystemStateModel.updateOne({ key }, { $set: { value } }, { upsert: true });
}
