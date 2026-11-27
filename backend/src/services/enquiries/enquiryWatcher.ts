/**
 * Website enquiries → Conversations.
 *
 * The enquiry form on classonesystems.in saves each submission to the website's Firestore
 * (`enquiries`, fields keyed by the form's own labels, plus `selections` and `submittedAt`). Every
 * few minutes this reads the newest ones and hands each to the inbox's own handling
 * (inboxPoller.processMail) as if it were an email from the person: the AI reads it, the person is
 * matched to a lead or contact — or becomes a new lead to review, tagged `website-enquiry` — and a
 * reply is drafted in Conversations → Needs you. Nothing is sent without approval.
 *
 * Each enquiry is recorded in the inbox ledger as `enquiry:<id>`, so it is handled once. A form with
 * no email address is recorded and listed, but cannot become a conversation.
 */
import fs from 'node:fs';
import { env } from '../../config/env.js';
import { InboundEmailModel } from '../../models/inboundEmail.model.js';
import { getState, setState } from '../../models/systemState.model.js';
import { processMail, type RawMail } from '../email/inboxPoller.js';

export interface WebsiteEnquiry {
  id: string;
  submittedAt: Date;
  fields: Record<string, unknown>;
}

export interface EnquirySource {
  /** The newest enquiries, newest first. */
  recent(limit: number): Promise<WebsiteEnquiry[]>;
}

let source: EnquirySource | null = null;

/** Test seam. */
export function setEnquirySource(s: EnquirySource | null): void {
  source = s;
}

async function liveSource(): Promise<EnquirySource> {
  if (source) return source;
  const { websiteFirestore } = await import('../catalog/catalogWatcher.js');
  const db = await websiteFirestore();
  source = {
    async recent(limit) {
      const snap = await db.collection('enquiries').orderBy('submittedAt', 'desc').limit(limit).get();
      return snap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        const at = data.submittedAt as { toDate?: () => Date } | undefined;
        const { submittedAt: _s, ...fields } = data;
        return { id: d.id, submittedAt: at?.toDate ? at.toDate() : new Date(), fields };
      });
    },
  };
  return source;
}

// --- Reading a form ------------------------------------------------------------------------------------

const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/i;
const pick = (fields: Record<string, unknown>, rx: RegExp) => {
  const key = Object.keys(fields).find((k) => rx.test(k) && typeof fields[k] === 'string' && (fields[k] as string).trim());
  return key ? (fields[key] as string).trim() : undefined;
};

/** The parts of a form the CRM needs, whatever the website's labels are called. */
export function readEnquiry(e: WebsiteEnquiry): { email?: string; name?: string; subject: string; body: string } {
  const f = e.fields;
  const strings = Object.entries(f).filter(([, v]) => typeof v === 'string') as Array<[string, string]>;
  const emailField = pick(f, /e-?mail/i);
  const email = (emailField && EMAIL.exec(emailField)?.[0]) ?? strings.map(([, v]) => EMAIL.exec(v)?.[0]).find(Boolean);
  const name = pick(f, /^(full\s*)?name$|your name|contact person|name of/i) ?? pick(f, /name/i);
  const selections = Array.isArray(f.selections) ? (f.selections as unknown[]).map(String).filter(Boolean) : [];
  const lines = strings.filter(([, v]) => v.trim()).map(([k, v]) => `${k}: ${v.trim()}`);
  if (selections.length) lines.push(`Interested in: ${selections.join(', ')}`);
  return {
    email: email?.toLowerCase(),
    name,
    subject: `Website enquiry${selections.length ? `: ${selections.slice(0, 3).join(', ')}` : ''}`,
    body: `Sent through the enquiry form on classonesystems.in.\n\n${lines.join('\n')}`,
  };
}

// --- Watching ------------------------------------------------------------------------------------------

const BASELINE_KEY = 'websiteEnquiriesBaseline';
/** On the very first run, enquiries newer than this are handled; older ones are only recorded. */
const FIRST_RUN_DAYS = 7;

export interface EnquiryTickResult {
  handled: number;
  noEmail: number;
  failed: number;
}

export async function enquiryTick(now = new Date()): Promise<EnquiryTickResult> {
  const src = await liveSource();
  const items = await src.recent(50);
  const ids = items.map((e) => `enquiry:${e.id}`);
  const done = new Set(
    ((await InboundEmailModel.find({ gmailId: { $in: ids }, $or: [{ status: { $ne: 'failed' } }, { attempts: { $gte: 5 } }] }, { gmailId: 1 }).lean()) as Array<{ gmailId: string }>).map((d) => d.gmailId),
  );
  const firstRun = !(await getState<boolean>(BASELINE_KEY));
  const out: EnquiryTickResult = { handled: 0, noEmail: 0, failed: 0 };

  // Oldest first, so a person's enquiries land in the order they were sent.
  for (const e of [...items].reverse()) {
    const key = `enquiry:${e.id}`;
    if (done.has(key)) continue;
    const r = readEnquiry(e);
    const base = { gmailId: key, from: r.email ?? 'unknown', fromName: r.name, subject: r.subject, receivedAt: e.submittedAt, direction: 'inbound' };
    if (firstRun && now.getTime() - e.submittedAt.getTime() > FIRST_RUN_DAYS * 86_400_000) {
      await InboundEmailModel.updateOne({ gmailId: key }, { $set: { ...base, status: 'ignored', action: 'Website enquiry from before the CRM read them' } }, { upsert: true });
      continue;
    }
    if (!r.email) {
      out.noEmail += 1;
      await InboundEmailModel.updateOne({ gmailId: key }, { $set: { ...base, status: 'ignored', action: 'Website enquiry with no email address — see the website admin' } }, { upsert: true });
      continue;
    }
    const mail: RawMail = { gmailId: key, from: r.email, fromName: r.name, subject: r.subject, bodyText: r.body, receivedAt: e.submittedAt, unread: true };
    try {
      await processMail(mail, { channel: 'website' });
      out.handled += 1;
    } catch (error) {
      out.failed += 1;
      const message = error instanceof Error ? error.message.split('\n')[0]! : String(error);
      console.error(`[enquiries] could not handle ${key}:`, message);
      await InboundEmailModel.updateOne({ gmailId: key }, { $set: { ...base, status: 'failed', error: message }, $inc: { attempts: 1 } }, { upsert: true });
    }
  }
  if (firstRun) await setState(BASELINE_KEY, true);
  return out;
}

let timer: NodeJS.Timeout | null = null;
let busy = false;

export function startEnquiryWatcher(): void {
  if (env.ENQUIRY_POLL_SECONDS === 0) return;
  if (!fs.existsSync(env.WEBSITE_FIREBASE_KEY_PATH)) {
    console.log(`[enquiries] not reading website enquiries: no service-account key at ${env.WEBSITE_FIREBASE_KEY_PATH}`);
    return;
  }
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await enquiryTick();
      if (r.handled || r.noEmail || r.failed) console.log(`[enquiries] ${r.handled} website enquir${r.handled === 1 ? 'y' : 'ies'} handled${r.noEmail ? `, ${r.noEmail} without an email` : ''}${r.failed ? `, ${r.failed} failed (will retry)` : ''}`);
    } catch (error) {
      console.error('[enquiries] read failed:', error instanceof Error ? error.message : error);
    } finally {
      busy = false;
    }
  };
  void tick();
  timer = setInterval(() => void tick(), env.ENQUIRY_POLL_SECONDS * 1000);
  console.log(`[enquiries] reading website enquiries every ${env.ENQUIRY_POLL_SECONDS}s`);
}

export function stopEnquiryWatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
