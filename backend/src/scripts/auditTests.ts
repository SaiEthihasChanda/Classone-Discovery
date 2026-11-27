/** Tests for the team activity log: who did what (middleware/requestContext.ts, services/activity). */
import assert from 'node:assert/strict';

type Check = (name: string, fn: () => Promise<void> | void) => Promise<void>;

export async function runAuditTests(check: Check, base = 'http://localhost:4999/api'): Promise<void> {
  const { describeRequest, requestContext } = await import('../middleware/requestContext.js');
  const { logActivity } = await import('../services/activity/activityService.js');
  const { ActivityLogModel } = await import('../models/activityLog.model.js');
  const { repositories } = await import('../repositories/index.js');
  const { normalizeNameKey } = await import('../utils/normalize.js');

  console.log('\nTeam activity log:\n');
  const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const lead = await repositories.leads.create({
    status: 'pending_review',
    source: { type: 'manual', discoveredAt: new Date() },
    person: { name: 'Audit Agarwal', normalizedNameKey: normalizeNameKey('Audit Agarwal'), email: 'audit.agarwal@uni.test' },
    institution: { name: 'IIT Audit' },
    research: { topics: [], recentPublications: [], recentGrants: [], instruments: [] },
    aiScoring: { recommendedProductIds: [] },
    review: {},
    followUpStatusSummary: 'not_started',
    tags: ['test'],
  });
  const since = new Date();

  try {
    await check('each kind of change reads as a plain sentence; previews and "mark read" are not recorded', () => {
      assert.equal(describeRequest('DELETE', `/leads/${lead.id}`)!.message, 'Deleted a lead');
      assert.equal(describeRequest('POST', '/campaigns/abc123/pause')!.message, 'Paused a campaign');
      assert.equal(describeRequest('PUT', '/conversations/settings', { followUpMode: 'auto' })!.message, 'Set follow-ups to Auto');
      assert.equal(describeRequest('PUT', '/conversations/people/a%40b.in/do-not-contact', { value: true })!.message, 'Marked do-not-contact: a@b.in');
      assert.equal(describeRequest('POST', '/campaigns/preview'), null);
      assert.equal(describeRequest('POST', '/conversations/threads/abc/read'), null);
      assert.match(describeRequest('POST', '/something/new')!.message, /^Did \/something\/new$/);
    });

    await check('activity logged during a signed-in request records who did it', async () => {
      const user = { uid: 'u1', email: 'seller@classone.test', name: 'Seller Sen', role: 'sales' as const };
      const entry = await requestContext.run({ user }, () => logActivity({ type: 'email_sent', message: 'Audit test send' }));
      assert.equal(entry!.actor, 'seller@classone.test');
      assert.equal(entry!.actorName, 'Seller Sen');
      const system = await logActivity({ type: 'email_sent', message: 'Audit test system' });
      assert.equal(system!.actor, undefined, 'background work has no person');
    });

    await check('a change made through the API lands in the log with the person and the lead it touched', async () => {
      const res = await call(`/leads/${lead.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'Associate Professor' }) });
      assert.equal(res.status, 200);
      let e: any = null;
      for (let i = 0; i < 20 && !e; i++) {
        await new Promise((r) => setTimeout(r, 50));
        e = await ActivityLogModel.findOne({ type: 'user_action', relatedLeadId: lead.id, createdAt: { $gte: since } }).lean();
      }
      assert.ok(e, 'recorded');
      assert.equal(e.message, 'Edited a lead — Audit Agarwal, IIT Audit');
      assert.ok(e.actor, 'with the person');
    });

    await check('a failed request records nothing', async () => {
      const before = await ActivityLogModel.countDocuments({ type: 'user_action', createdAt: { $gte: since } });
      const res = await call('/leads/000000000000000000000000', { method: 'PATCH', body: JSON.stringify({ title: 'x' }) });
      assert.ok(res.status >= 400);
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(await ActivityLogModel.countDocuments({ type: 'user_action', createdAt: { $gte: since } }), before);
    });

    await check('the log can be searched by text and by person', async () => {
      const res = await call(`/admin/activity?text=${encodeURIComponent('Audit Agarwal')}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { items: Array<{ message: string; actor?: string }>; actors: Array<{ actor: string }> };
      assert.ok(body.items.some((i) => i.message.includes('Audit Agarwal')));
      const who = body.items.find((i) => i.actor)!.actor!;
      assert.ok(body.actors.some((a) => a.actor === who));
      const mine = (await (await call(`/admin/activity?actor=${encodeURIComponent('seller@classone.test')}`)).json()) as { items: Array<{ message: string }> };
      assert.ok(mine.items.every((i) => !i.message.includes('Audit Agarwal')));
      assert.ok(mine.items.some((i) => i.message === 'Audit test send'));
    });
  } finally {
    await repositories.leads.deleteById(lead.id);
    await ActivityLogModel.deleteMany({ createdAt: { $gte: since }, $or: [{ message: /Audit/ }, { relatedLeadId: lead.id }] });
  }
}
