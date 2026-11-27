/** Tests for campaign open/click tracking (services/campaigns/tracking.ts). */
import assert from 'node:assert/strict';

type Check = (name: string, fn: () => Promise<void> | void) => Promise<void>;

export async function runTrackingTests(check: Check): Promise<void> {
  const t = await import('../services/campaigns/tracking.js');
  const { CampaignRecipientModel } = await import('../models/campaign.model.js');

  console.log('\nCampaign tracking:\n');
  const sentAt = new Date(Date.now() - 60_000);
  const r = await CampaignRecipientModel.create({ campaignId: 'track-test', email: 'track@uni.test', status: 'sent', sentAt });
  const rid = String(r._id);

  try {
    await check('links go through the click route, an open image is added, mailto links are left alone', () => {
      const html = '<html><body><a href="https://classonesystems.in/product/x?a=1&amp;b=2">See</a> <a href="mailto:sales@x.in">Mail</a></body></html>';
      const out = t.addTracking(html, rid, 'https://app.test/api');
      assert.match(out, new RegExp(`href="https://app.test/api/public/t/c/${rid}\\?u=https%3A%2F%2Fclassonesystems.in%2Fproduct%2Fx%3Fa%3D1%26b%3D2&amp;s=`));
      assert.match(out, /href="mailto:sales@x.in"/);
      assert.match(out, new RegExp(`<img src="https://app.test/api/public/t/o/${rid}\\.[\\w-]+\\.gif"[^>]*/></body>`));
    });

    await check('an open is counted once per person, with the first time kept', async () => {
      const token = t.openToken(rid);
      assert.equal(t.readOpenToken(`${token}.gif`), rid);
      assert.equal(t.readOpenToken(`${rid}.forged`), null);
      await t.recordOpen(rid, new Date(Date.now() - 1000));
      await t.recordOpen(rid);
      const doc = (await CampaignRecipientModel.findById(rid).lean()) as any;
      assert.equal(doc.opens, 2);
      assert.ok(doc.openedAt <= new Date());
    });

    await check('a click is recorded and redirects — but only to a link that was signed into that email', async () => {
      const url = 'https://classonesystems.in/product/emstat4s';
      assert.equal(await t.recordClick(rid, url, t.clickSig(rid, url)), url);
      assert.equal(await t.recordClick(rid, 'https://evil.example', t.clickSig(rid, url)), null, 'no open redirect');
      const doc = (await CampaignRecipientModel.findById(rid).lean()) as any;
      assert.equal(doc.clicks, 1);
      assert.equal(doc.clickLog[0].url, url);
    });

    await check('events in the first seconds after sending (mail scanners) are ignored', async () => {
      const fresh = await CampaignRecipientModel.create({ campaignId: 'track-test', email: 'scan@uni.test', status: 'sent', sentAt: new Date() });
      const id = String(fresh._id);
      await t.recordOpen(id);
      await t.recordClick(id, 'https://classonesystems.in', t.clickSig(id, 'https://classonesystems.in'));
      const doc = (await CampaignRecipientModel.findById(id).lean()) as any;
      assert.equal(doc.opens, undefined);
      assert.equal(doc.clicks, undefined);
    });

    await check('campaign engagement: people who opened, clicked, and the most-clicked links', async () => {
      const e = (await t.engagementByCampaign(['track-test'])).get('track-test')!;
      assert.equal(e.opened, 1);
      assert.equal(e.clicked, 1);
      assert.deepEqual(e.topLinks, [{ url: 'https://classonesystems.in/product/emstat4s', clicks: 1 }]);
    });
  } finally {
    await CampaignRecipientModel.deleteMany({ campaignId: 'track-test' });
  }
}
