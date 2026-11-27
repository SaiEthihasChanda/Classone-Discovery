/**
 * Tests for website enquiries → Conversations (services/enquiries/enquiryWatcher.ts), with a fake
 * Firestore source and the stub AI.
 */
import assert from 'node:assert/strict';

type Check = (name: string, fn: () => Promise<void> | void) => Promise<void>;

export async function runEnquiryTests(check: Check): Promise<void> {
  const { enquiryTick, readEnquiry, setEnquirySource } = await import('../services/enquiries/enquiryWatcher.js');
  const { setTriageFn } = await import('../services/email/inboundTriage.js');
  const { InboundEmailModel } = await import('../models/inboundEmail.model.js');
  const { EmailThreadModel } = await import('../models/emailThread.model.js');
  const { LeadModel } = await import('../models/lead.model.js');
  const { setState } = await import('../models/systemState.model.js');

  console.log('\nWebsite enquiries:\n');
  const now = new Date();
  const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
  const site: Array<{ id: string; submittedAt: Date; fields: Record<string, unknown> }> = [];
  setEnquirySource({ recent: async (n) => [...site].sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime()).slice(0, n) });
  setTriageFn(async (mail) => ({
    intent: 'other' as never,
    summary: `about ${mail.subject}`,
    urgency: 'normal',
    productIds: [],
    contact: { name: undefined as never, institution: 'NIT Enquiry' },
    shouldReply: true,
    replyBody: 'Thank you for your enquiry.\n\nTeam Class One Systems',
    model: 'stub',
  }));
  const emails = ['enq.new@uni.test', 'enq.old@uni.test'];

  try {
    await check('a form is read whatever its labels are called', () => {
      const r = readEnquiry({ id: 'x', submittedAt: now, fields: { 'Full Name': 'Dr. Meera Iyer', 'Email Address': ' Meera.Iyer@Uni.TEST ', 'Your requirement': 'Need a quote', selections: ['EmStat4S', 'PalmSens4'] } });
      assert.equal(r.email, 'meera.iyer@uni.test');
      assert.equal(r.name, 'Dr. Meera Iyer');
      assert.equal(r.subject, 'Website enquiry: EmStat4S, PalmSens4');
      assert.match(r.body, /Your requirement: Need a quote/);
      assert.match(r.body, /Interested in: EmStat4S, PalmSens4/);
    });

    await check('first run: recent enquiries become leads with a drafted reply; older ones are only recorded', async () => {
      await setState('websiteEnquiriesBaseline', false);
      site.push({ id: 'enq-new', submittedAt: ago(1), fields: { Name: 'Dr. New Enquirer', Email: emails[0], Message: 'Please send a quotation', selections: ['EmStat4S'] } });
      site.push({ id: 'enq-old', submittedAt: ago(40), fields: { Name: 'Old Enquirer', Email: emails[1], Message: 'Old' } });
      site.push({ id: 'enq-noemail', submittedAt: ago(1), fields: { Name: 'Phone Only', Phone: '98400 00000' } });
      const r = await enquiryTick(now);
      assert.deepEqual(r, { handled: 1, noEmail: 1, failed: 0 });
      const lead = (await LeadModel.findOne({ 'person.email': emails[0] }).lean()) as any;
      assert.equal(lead.source.type, 'website_enquiry');
      assert.equal(lead.status, 'pending_review');
      assert.ok(lead.tags.includes('website-enquiry'));
      const thread = (await EmailThreadModel.findOne({ contactEmail: emails[0] }).lean()) as any;
      assert.equal(thread.status, 'draft');
      assert.match(thread.draftBody, /Thank you for your enquiry/);
      assert.match(thread.messages[0].bodyText, /Please send a quotation/);
      assert.equal(await LeadModel.exists({ 'person.email': emails[1] }), null, 'the 40-day-old one is not acted on');
      assert.equal(((await InboundEmailModel.findOne({ gmailId: 'enquiry:enq-noemail' }).lean()) as any).status, 'ignored');
    });

    await check('each enquiry is handled once', async () => {
      assert.deepEqual(await enquiryTick(now), { handled: 0, noEmail: 0, failed: 0 });
    });

    await check('after the first run, every new enquiry is handled whatever its age', async () => {
      site.push({ id: 'enq-late', submittedAt: ago(20), fields: { Email: 'enq.late@uni.test', Message: 'Late sync' } });
      emails.push('enq.late@uni.test');
      assert.equal((await enquiryTick(now)).handled, 1);
    });
  } finally {
    setEnquirySource(null);
    setTriageFn(null);
    await EmailThreadModel.deleteMany({ contactEmail: { $in: emails } });
    await LeadModel.deleteMany({ 'person.email': { $in: emails } });
    await InboundEmailModel.deleteMany({ gmailId: /^enquiry:enq-/ });
    const { ContactModel } = await import('../models/contact.model.js');
    await ContactModel.deleteMany({ email: { $in: emails } });
  }
}
