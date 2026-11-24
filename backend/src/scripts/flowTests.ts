/**
 * Prospects conveyor tests (services/pipeline/flowEngine.ts) — run from the
 * smoke test. The stage functions are stubbed (they write what the real ones
 * would), so this checks the engine's own rules: who it picks up in each mode,
 * where each outcome sends a person, retries, recovery, the Leads gate, and
 * schedules.
 */
import assert from 'node:assert/strict';

type Check = (name: string, fn: () => Promise<void> | void) => Promise<void>;
type Request = (path: string, init?: RequestInit) => Promise<{ status: number; body: any }>;

export async function runFlowTests(check: Check, request: Request): Promise<void> {
  const flow = await import('../services/pipeline/flowEngine.js');
  const runs = await import('../services/pipeline/pipelineRuns.js');
  const { FacultyMemberModel } = await import('../models/facultyMember.model.js');
  const { LeadModel } = await import('../models/lead.model.js');
  const { PipelineScheduleModel } = await import('../models/pipeline.model.js');

  console.log('\nProspects conveyor:\n');

  const lead = await LeadModel.findOne({}).lean();
  assert.ok(lead, 'the smoke DB has at least one lead to promote into');
  const leadId = String(lead._id);

  let n = 0;
  const member = async (extra: Record<string, unknown> = {}) => {
    n += 1;
    const doc = await FacultyMemberModel.create({
      person: { name: `Flow Person ${n}`, normalizedNameKey: `flow person ${n}` },
      role: { category: 'professor' },
      department: { domain: 'chemistry' },
      institution: { name: 'Test Institute', normalizedNameKey: 'test institute' },
      flow: { stage: 'verify', state: 'idle' },
      ...extra,
    });
    return String(doc._id);
  };
  const get = async (id: string) => (await FacultyMemberModel.findById(id).lean()) as any;

  // Stubs: verify marks the affiliation (unknown for names containing "Unknown"),
  // score writes a fixed score per person, promote follows the threshold, fill does nothing.
  const scores = new Map<string, number>();
  const failScoring = new Set<string>();
  const stubs = {
    verifyRoster: (async (o: { ids: string[] }) => {
      const m = await get(o.ids[0]!);
      await FacultyMemberModel.updateOne({ _id: o.ids[0] }, { $set: { 'institution.affiliation': { status: /Unknown/.test(m.person.name) ? 'unknown' : 'current', source: 'orcid', verifiedAt: new Date() } } });
    }) as never,
    // Like the real one: scores a batch, reporting per-person failures instead of throwing.
    scoreRoster: (async (o: { ids: string[] }) => {
      const failures: Record<string, string> = {};
      for (const id of o.ids) {
        if (failScoring.has(id)) failures[id] = 'Unexpected response shape';
        else await FacultyMemberModel.updateOne({ _id: id }, { $set: { 'relevance.score': scores.get(id) ?? 80 } });
      }
      return { failures };
    }) as never,
    promoteRoster: (async (o: { ids: string[]; threshold: number }) => {
      const m = await get(o.ids[0]!);
      if ((m.relevance?.score ?? 0) >= o.threshold) await FacultyMemberModel.updateOne({ _id: o.ids[0] }, { $set: { status: 'promoted', leadId } });
    }) as never,
    fillRoster: (async () => {}) as never,
  };
  flow.setFlowStageFns(stubs);

  try {
    await check('Manual mode: nothing moves until a person asks, one step at a time; the lead stays out of Leads until filled', async () => {
      await flow.updatePipelineSettings({ mode: 'manual', threshold: 60 }); // the threshold the assertions below use
      const id = await member();
      await flow.runFlowOnce();
      assert.equal((await get(id)).flow.stage, 'verify', 'idle people wait in Manual');

      await flow.memberAction(id, 'next');
      await flow.runFlowOnce();
      let m = await get(id);
      assert.deepEqual([m.flow.stage, m.flow.state], ['score', 'idle'], 'one step, then it waits again');

      assert.equal(await flow.queueStage('score'), 1, 'Run all waiting queues the column');
      await flow.runFlowOnce();
      assert.equal((await get(id)).flow.stage, 'promote');

      await flow.memberAction(id, 'next');
      await flow.runFlowOnce();
      m = await get(id);
      assert.deepEqual([m.status, m.flow.stage], ['promoted', 'fill']);
      assert.equal((await LeadModel.findById(leadId).lean())!.inPipeline, true);
      const hidden = await request('/leads?limit=200');
      assert.ok(!hidden.body.items.some((l: any) => l.id === leadId), 'a lead mid-pipeline is not in Leads');

      await flow.memberAction(id, 'next');
      await flow.runFlowOnce();
      assert.equal((await get(id)).flow.stage, 'done');
      assert.equal((await LeadModel.findById(leadId).lean())!.inPipeline, undefined);
      const shown = await request('/leads?limit=200');
      assert.ok(shown.body.items.some((l: any) => l.id === leadId), 'filled → in Leads');
    });

    await check('Manual mode: below threshold waits in Scored with a note; Run next step promotes anyway', async () => {
      const id = await member({ flow: { stage: 'promote', state: 'queued' }, 'relevance.score': 20 } as never);
      await FacultyMemberModel.updateOne({ _id: id }, { $set: { 'relevance.score': 20 } });
      await flow.runFlowOnce();
      let m = await get(id);
      assert.deepEqual([m.status, m.flow.stage, m.flow.state], ['eligible', 'promote', 'idle']);
      assert.match(m.flow.note, /below 60/);
      await flow.memberAction(id, 'next');
      await flow.runFlowOnce();
      m = await get(id);
      assert.equal(m.status, 'promoted', 'forced through');
    });

    await check('Auto mode: each person flows straight through on their own; low scores are excluded; unknown institute → review', async () => {
      const good = await member();
      const low = await member();
      const unknown = await member({ person: { name: 'Unknown Person', normalizedNameKey: 'unknown person' } });
      scores.set(low, 25);
      await flow.updatePipelineSettings({ mode: 'auto' });
      await flow.runFlowOnce();
      const [g, l, u] = await Promise.all([get(good), get(low), get(unknown)]);
      assert.equal(g.flow.stage, 'done', 'one pass carries a person through every stage');
      assert.equal(l.status, 'excluded');
      assert.match(l.exclusionReason, /\(auto\)/);
      assert.deepEqual([u.flow.stage, u.flow.state], ['verify', 'review']);
    });

    await check('a failing step retries later, then fails — and others keep flowing', async () => {
      const bad = await member();
      const ok = await member();
      failScoring.add(bad);
      await flow.runFlowOnce();
      let b = await get(bad);
      assert.deepEqual([b.flow.stage, b.flow.state, b.flow.attempts], ['score', 'queued', 1]);
      assert.ok(new Date(b.flow.nextAttemptAt) > new Date(), 'retry is scheduled for later');
      assert.equal((await get(ok)).flow.stage, 'done', 'the next person was not held up');
      await flow.runFlowOnce();
      assert.equal((await get(bad)).flow.attempts, 1, 'not retried before its time');
      await FacultyMemberModel.updateOne({ _id: bad }, { $set: { 'flow.attempts': 3, 'flow.nextAttemptAt': new Date(Date.now() - 1000) } });
      await flow.runFlowOnce();
      b = await get(bad);
      assert.equal(b.flow.state, 'failed');
      assert.match(b.flow.lastError, /Unexpected response/);
      failScoring.delete(bad);
      await flow.memberAction(bad, 'retry');
      await flow.runFlowOnce();
      assert.equal((await get(bad)).flow.stage, 'done', 'Retry runs it again');
    });

    await check('a busy AI provider pauses the stage instead of failing people; the next success clears it', async () => {
      await flow.updatePipelineSettings({ mode: 'manual' });
      const id = await member({ flow: { stage: 'score', state: 'queued' } });
      flow.setFlowStageFns({
        ...stubs,
        // What the real scoreRoster does on a provider error: catch it per member and log it.
        scoreRoster: (async (_o: unknown, ctx: { log: (m: string, l?: string) => void }) => {
          ctx.log('Flow Person: scoring failed — Gemini 503 Service Unavailable: {\n  "error": {}', 'warn');
        }) as never,
      });
      await flow.runFlowOnce();
      const m = await get(id);
      assert.deepEqual([m.flow.stage, m.flow.state], ['score', 'queued']);
      assert.ok(!m.flow.attempts, 'no attempt counted against the person');
      assert.equal(m.flow.lastError, 'Gemini 503 Service Unavailable', 'the real reason, first line only');
      assert.ok(flow.activePauses().score, 'the score stage is paused');
      flow.setFlowStageFns(stubs);
      await FacultyMemberModel.updateOne({ _id: id }, { $set: { 'flow.nextAttemptAt': new Date(Date.now() - 1000) } });
      await flow.runFlowOnce();
      assert.equal((await get(id)).flow.stage, 'promote');
      assert.equal(flow.activePauses().score, undefined, 'cleared by a success');
    });

    await check('scoring takes several people per call; a busy reply for some re-queues them without pausing the stage', async () => {
      await flow.updatePipelineSettings({ mode: 'manual' });
      const ids = [await member({ flow: { stage: 'score', state: 'queued' } }), await member({ flow: { stage: 'score', state: 'queued' } }), await member({ flow: { stage: 'score', state: 'queued' } })];
      const calls: string[][] = [];
      flow.setFlowStageFns({
        ...stubs,
        scoreRoster: (async (o: { ids: string[] }) => {
          calls.push(o.ids);
          for (const id of o.ids.slice(1)) await FacultyMemberModel.updateOne({ _id: id }, { $set: { 'relevance.score': 70 } });
          return { failures: { [o.ids[0]!]: 'Gemini 429 Too Many Requests (gemini-flash-latest): quota' } };
        }) as never,
      });
      await flow.runFlowOnce();
      flow.setFlowStageFns(stubs);
      assert.equal(calls.length, 1, 'one call');
      assert.deepEqual([...calls[0]!].sort(), [...ids].sort(), 'for all three');
      const [first, ...rest] = await Promise.all(calls[0]!.map(get));
      for (const m of rest) assert.equal(m.flow.stage, 'promote');
      assert.deepEqual([first.flow.stage, first.flow.state], ['score', 'queued']);
      assert.ok(!first.flow.attempts, 'no attempt counted');
      assert.ok(new Date(first.flow.nextAttemptAt) > new Date(), 'retried shortly');
      assert.equal(flow.activePauses().score, undefined, 'others got through, so no stage pause');
      await FacultyMemberModel.updateOne({ _id: first._id }, { $set: { 'flow.nextAttemptAt': new Date(Date.now() - 1000) } });
      await flow.runFlowOnce();
      assert.equal((await get(String(first._id))).flow.stage, 'promote');
    });

    await check('Gemini: falls back to the next model on quota, batches people, and splits a batch it cannot read', async () => {
      const { GeminiProvider, resetGeminiCooldowns } = await import('../services/ai/geminiProvider.js');
      const realFetch = globalThis.fetch;
      const hits: Array<{ model: string; people: number }> = [];
      const one = (id?: string) => ({ ...(id ? { person_id: id } : {}), relevance_score: 55, relevance_reasoning: 'r', product_relevance: 50, institutional_strength: 50, recency: 50, engagement_potential: 50, summary: 's', topics: [], recommended_product_ids: [], recommended_product_notes: '' });
      let mode: 'quota' | 'partial' | 'garbage' = 'quota';
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        const model = /models\/([^:]+):/.exec(url)![1]!;
        const prompt = JSON.parse(String(init.body)).contents[0].parts[0].text as string;
        const people = (prompt.match(/=== Researcher p\d+ ===/g) ?? []).length;
        hits.push({ model, people });
        const reply = (body: unknown) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] }), { status: 200 });
        if (mode === 'quota' && model === 'primary') return new Response('{"error":"RESOURCE_EXHAUSTED"}', { status: 429, statusText: 'Too Many Requests' });
        if (!people) return reply(one());
        if (mode === 'garbage') return reply({ nope: true });
        return reply({ results: Array.from({ length: mode === 'partial' ? people - 1 : people }, (_, i) => one(`p${i + 1}`)) });
      }) as typeof fetch;
      try {
        resetGeminiCooldowns();
        const p = new GeminiProvider('test-key', 'primary', ['backup']);
        const input = (name: string) => ({ candidate: { name, topics: [], publications: [], grants: [], evidenceText: 'electrochemistry' } as never, catalog: [] });

        const single = await p.enrich(input('A'));
        assert.equal(single.model, 'backup', 'scored by the fallback after a 429');
        hits.length = 0;
        await p.enrich(input('B'));
        assert.deepEqual(hits.map((h) => h.model), ['backup'], 'the out-of-quota model is skipped for a while');

        hits.length = 0;
        const batch = await p.enrichBatch([input('C'), input('D'), input('E')]);
        assert.equal(hits[0]!.people, 3, 'three people in one call');
        assert.ok(batch.every((r) => !(r instanceof Error) && r.relevanceScore === 55));

        mode = 'partial';
        hits.length = 0;
        const partial = await p.enrichBatch([input('F'), input('G'), input('H')]);
        assert.equal(hits.length, 2, 'the one left out of the answer gets its own call');
        assert.ok(partial.every((r) => !(r instanceof Error)));

        mode = 'garbage';
        hits.length = 0;
        const split = await p.enrichBatch([input('I'), input('J')]);
        assert.deepEqual(hits.map((h) => h.people), [2, 0, 0], 'an unreadable batch is scored one at a time');
        assert.ok(split.every((r) => !(r instanceof Error)));
      } finally {
        globalThis.fetch = realFetch;
        resetGeminiCooldowns();
      }
    });

    await check('the person who started a run gets one "run finished" email, only once nobody of it is still moving', async () => {
      const { RosterRunModel } = await import('../models/rosterRun.model.js');
      const { notifyFinishedRuns } = await import('../services/pipeline/runNotifier.js');
      await flow.updatePipelineSettings({ mode: 'auto' });
      const sent: Array<{ to: string; subject: string; text: string; html?: string }> = [];
      const transport = { name: 'ethereal' as const, send: async (m: { to: string; subject: string; text: string; html?: string }) => (sent.push(m), { providerMessageId: 'x' }) };
      const runId = `notify-test-${Date.now()}`;
      await RosterRunModel.create({ _id: runId, kind: 'roster_build', status: 'completed', startedAt: new Date(Date.now() - 600_000), options: { flow: true, label: 'Notify test', institutionIds: [], notifyEmail: 'someone@example.com' } });
      const lead1 = await member({ status: 'promoted', relevance: { score: 88 }, flow: { stage: 'done', state: 'idle', runId } });
      const between = await member({ flow: { stage: 'promote', state: 'idle', runId } });
      await member({ status: 'excluded', flow: { stage: 'promote', state: 'idle', runId } });

      assert.equal(await notifyFinishedRuns(new Date(), transport as never), 0, 'idle between steps in Auto still counts as moving');
      await FacultyMemberModel.updateOne({ _id: between }, { $set: { 'flow.stage': 'done' } });
      assert.equal(await notifyFinishedRuns(new Date(), transport as never), 1);
      assert.equal(await notifyFinishedRuns(new Date(), transport as never), 0, 'never twice');
      const [mail] = sent;
      assert.equal(mail!.to, 'someone@example.com');
      assert.match(mail!.subject, /Notify test — 2 new leads/);
      assert.match(mail!.text, /People found: 3/);
      assert.match(mail!.text, /Excluded \(score below \d+\): 1/);
      assert.match(mail!.text, new RegExp(`/prospects\\?view=history&run=${runId}`));
      assert.match(mail!.text, /\/leads\?status=pending_review/);
      assert.match(mail!.text, /- Flow Person \d+, Test Institute — score 88/, 'top leads listed with scores');
      assert.ok(lead1);

      // A send that fails is retried later, and the error kept on the run.
      const runId2 = `notify-test-fail-${Date.now()}`;
      await RosterRunModel.create({ _id: runId2, kind: 'roster_build', status: 'failed', error: 'boom', startedAt: new Date(), options: { flow: true, notifyEmail: 'someone@example.com' } });
      const failing = { name: 'ethereal' as const, send: async () => Promise.reject(new Error('SMTP down')) };
      assert.equal(await notifyFinishedRuns(new Date(), failing as never), 0);
      let r = (await RosterRunModel.findById(runId2).lean()) as any;
      assert.equal(r.notification.error, 'SMTP down');
      assert.equal(r.notification.sentAt, undefined, 'unclaimed for a retry');
      assert.equal(await notifyFinishedRuns(new Date(), transport as never), 1, 'sent on the next tick');
      assert.match(sent[1]!.text, /stopped with an error: boom/);
      r = (await RosterRunModel.findById(runId2).lean()) as any;
      assert.equal(r.notification.error, undefined);
      await RosterRunModel.deleteMany({ _id: { $in: [runId, runId2] } });
    });

    await check('interrupted steps are re-queued on restart; members without a flow are placed from what is known', async () => {
      await flow.updatePipelineSettings({ mode: 'manual' });
      const stuck = await member({ flow: { stage: 'score', state: 'processing' } });
      assert.ok((await flow.recoverInterrupted()) >= 1);
      assert.equal((await get(stuck)).flow.state, 'queued');
      const promoted = await member({ status: 'promoted', flow: undefined });
      const scored = await member({ flow: undefined, relevance: { score: 50 } });
      const fresh = await member({ flow: undefined });
      await FacultyMemberModel.updateMany({ _id: { $in: [promoted, scored, fresh] } }, { $unset: { flow: '' } });
      await flow.migrateFlow();
      assert.equal((await get(promoted)).flow.stage, 'done');
      assert.equal((await get(scored)).flow.stage, 'promote');
      assert.equal((await get(fresh)).flow.stage, 'verify');
    });

    await check('board columns come from the flow and partition the active roster; /pipeline/state counts them', async () => {
      const cols = ['found', 'verified', 'scored', 'filling', 'crm'];
      const totals = await Promise.all(cols.map(async (s) => (await request(`/roster?stage=${s}`)).body.total as number));
      const active = await FacultyMemberModel.countDocuments({ status: { $in: ['eligible', 'promoted'] } });
      assert.equal(totals.reduce((a, b) => a + b, 0), active, `columns ${totals.join('+')} = ${active}`);
      const state = await request('/pipeline/state');
      assert.equal(state.status, 200);
      assert.equal(state.body.settings.mode, 'manual');
      assert.equal(state.body.stages.verify.review, 1, 'the unknown-institute person needs review');
      const view = await request('/pipeline/stages/verify');
      assert.equal(view.body.review.length, 1);
      const act = await request(`/pipeline/members/${view.body.review[0].id}/action`, { method: 'POST', body: JSON.stringify({ action: 'next' }) });
      assert.equal(act.status, 200);
      const bad = await request('/pipeline/stages/nope');
      assert.equal(bad.status, 400);
    });

    await check('schedules: next weekday occurrence in India time; a missed run fires once, marked late', async () => {
      // Mon 23 Nov 2026 10:00 IST = 04:30 UTC. Next "Mon/Wed 09:00 IST" is Wed 25 Nov 03:30 UTC.
      const after = new Date('2026-11-23T04:30:00Z');
      assert.equal(runs.nextRecurring([1, 3], '09:00', after)!.toISOString(), '2026-11-25T03:30:00.000Z');
      assert.equal(runs.nextRecurring([1], '11:00', after)!.toISOString(), '2026-11-23T05:30:00.000Z', 'later today counts');

      const config = { institutionIds: ['I162827531'] };
      const missed = await PipelineScheduleModel.create({ name: 'weekly', config, type: 'recurring', weekdays: [1], time: '09:00', nextRunAt: new Date(Date.now() - 3 * 86_400_000) });
      const once = await PipelineScheduleModel.create({ name: 'once', config, type: 'once', runAt: new Date(Date.now() - 1000), nextRunAt: new Date(Date.now() - 1000) });
      const started: unknown[] = [];
      const fake = (async (c: unknown, meta: unknown) => {
        started.push(meta);
        return { id: `run-${started.length}` };
      }) as never;
      assert.equal(await runs.fireDueSchedules(new Date(), fake), 2);
      assert.equal(await runs.fireDueSchedules(new Date(), fake), 0, 'each fires once, not once per missed occurrence');
      const m = (await PipelineScheduleModel.findById(missed._id).lean())!;
      assert.equal(m.lastRunLate, true);
      assert.ok(m.nextRunAt! > new Date(), 'recurring moves to its next occurrence');
      const o = (await PipelineScheduleModel.findById(once._id).lean())!;
      assert.equal(o.enabled, false, 'a one-off disables itself');
      assert.equal(o.lastRunLate, false);

      const created = await request('/pipeline/schedules', { method: 'POST', body: JSON.stringify({ name: 'x', config, type: 'recurring', weekdays: [2], time: '08:30' }) });
      assert.equal(created.status, 201);
      const badSchedule = await request('/pipeline/schedules', { method: 'POST', body: JSON.stringify({ name: 'x', config, type: 'recurring' }) });
      assert.equal(badSchedule.status, 400);
      await PipelineScheduleModel.deleteMany({});
    });
  } finally {
    flow.setFlowStageFns(null);
    await flow.updatePipelineSettings({ mode: 'manual' });
  }
}
