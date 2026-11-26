/**
 * Turns a campaign's blocks into an email: table-based HTML with inline styles
 * (what mail apps reliably render), a plain-text version, and the images as
 * inline attachments referenced by cid: — so recipients see the poster without
 * the app having to be reachable from the internet.
 *
 * Personalisation: {first_name} {last_name} {name} {title} {institute}
 * {department}, with an optional fallback — {first_name|there}.
 */
import { env } from '../../config/env.js';
import type { CampaignBlock } from '../../models/campaign.model.js';
import type { Product } from '../../types/domain.js';

export interface Recipient {
  name?: string;
  title?: string;
  institute?: string;
  department?: string;
}

export interface Asset {
  id: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  attachments: Array<{ filename: string; content: Buffer; contentType: string; cid: string }>;
}

const NAVY = '#16265c';
const INK = '#1a2033';
const MUTED = '#6b7280';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function nameParts(full?: string): { first?: string; last?: string } {
  const parts = (full ?? '').replace(/^(dr|prof|mr|ms|mrs)\.?\s+/i, '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0], last: parts.length > 1 ? parts.at(-1) : undefined };
}

/** Fills {fields}; a field with no value uses its fallback ({first_name|there}) or disappears. */
export function personalise(text: string, r: Recipient): string {
  const { first, last } = nameParts(r.name);
  const values: Record<string, string | undefined> = {
    first_name: first,
    last_name: last,
    name: r.name,
    title: r.title,
    institute: r.institute,
    department: r.department,
  };
  return text.replace(/\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}/gi, (whole, key: string, fallback?: string) => {
    const k = key.toLowerCase();
    if (!(k in values)) return whole;
    return values[k]?.trim() || (fallback ?? '').trim();
  });
}

/** Plain text → HTML: paragraphs, line breaks, **bold**, and bare links made clickable. */
function richText(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => {
      const html = esc(para)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, `<a href="$1" style="color:${NAVY};">$1</a>`)
        .replace(/\n/g, '<br>');
      return `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${INK};">${html}</p>`;
    })
    .join('');
}

/** Centres or right-aligns a table inside its cell (align="" alone is not honoured everywhere). */
const alignMargin = (a: 'left' | 'center' | 'right') => (a === 'center' ? 'margin:0 auto;' : a === 'right' ? 'margin:0 0 0 auto;' : 'margin:0;');

const row = (inner: string, pad = '0 32px') => `<tr><td style="padding:${pad};">${inner}</td></tr>`;

export function renderCampaign(
  input: { subject: string; preheader?: string; blocks: CampaignBlock[] },
  recipient: Recipient,
  ctx: { assets: Map<string, Asset>; products: Map<string, Product>; mode: 'email' | 'preview' },
): RenderedEmail {
  const p = (s: string) => personalise(s, recipient);
  const attachments: RenderedEmail['attachments'] = [];
  const htmlRows: string[] = [];
  const textParts: string[] = [];

  for (const b of input.blocks) {
    switch (b.type) {
      case 'heading': {
        const size = b.size === 'md' ? 19 : 24;
        htmlRows.push(row(`<h1 style="margin:0 0 12px;font-size:${size}px;line-height:1.3;color:${NAVY};font-family:Georgia,Cambria,serif;text-align:${b.align ?? 'left'};">${esc(p(b.text))}</h1>`, '8px 32px 0'));
        textParts.push(p(b.text).toUpperCase());
        break;
      }
      case 'text':
        htmlRows.push(row(richText(p(b.text))));
        textParts.push(p(b.text).replace(/\*\*(.+?)\*\*/g, '$1'));
        break;
      case 'image': {
        const asset = ctx.assets.get(b.assetId);
        if (!asset) break;
        const cid = `img-${asset.id}@classone`;
        const src = ctx.mode === 'preview' ? `data:${asset.contentType};base64,${asset.data.toString('base64')}` : `cid:${cid}`;
        if (ctx.mode === 'email' && !attachments.some((a) => a.cid === cid)) attachments.push({ filename: asset.filename, content: asset.data, contentType: asset.contentType, cid });
        // Width of the 536 px content column; alignment by a one-cell table (what mail apps honour).
        const px = { full: 536, large: 400, medium: 300, small: 180 }[b.width ?? 'full'];
        const img = `<img src="${src}" alt="${esc(b.alt ?? '')}" width="${px}" style="display:block;width:100%;max-width:${px}px;height:auto;border:0;border-radius:8px;">`;
        const inner = b.link ? `<a href="${esc(b.link)}">${img}</a>` : img;
        htmlRows.push(row(`<table role="presentation" align="${b.align ?? 'center'}" width="${px}" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:${px}px;${alignMargin(b.align ?? 'center')}"><tr><td>${inner}</td></tr></table>`, '4px 32px 16px'));
        if (b.alt || b.link) textParts.push([b.alt && `[Image: ${b.alt}]`, b.link].filter(Boolean).join(' '));
        break;
      }
      case 'button': {
        const full = b.align === 'full';
        const outline = b.style === 'outline';
        const cell = outline ? `border:2px solid ${NAVY};border-radius:8px;background:#ffffff;` : `border-radius:8px;background:${NAVY};`;
        const link = `<a href="${esc(b.url)}" style="display:${full ? 'block' : 'inline-block'};padding:12px 24px;font-size:15px;font-weight:600;color:${outline ? NAVY : '#ffffff'};text-decoration:none;border-radius:8px;text-align:center;">${esc(p(b.label))}</a>`;
        const align: 'left' | 'center' | 'right' = b.align === 'full' || !b.align ? (full ? 'center' : 'left') : b.align;
        htmlRows.push(
          row(
            `<table role="presentation" align="${align}" ${full ? 'width="100%" ' : ''}cellspacing="0" cellpadding="0" border="0" style="${full ? 'width:100%;' : alignMargin(align)}"><tr><td align="center" style="${cell}">${link}</td></tr></table>`,
            '4px 32px 18px',
          ),
        );
        textParts.push(`${p(b.label)}: ${b.url}`);
        break;
      }
      case 'product': {
        const prod = ctx.products.get(b.productId);
        if (!prod) break;
        const blurb = p(b.blurb || prod.description || `For ${prod.applicationAreas.slice(0, 3).join(', ')}.`);
        const link = b.url || prod.sourceUrl;
        htmlRows.push(
          row(
            `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #e8ebf0;border-radius:10px;"><tr><td style="padding:16px 18px;">
<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${MUTED};margin-bottom:4px;">${esc(prod.category.replace(/_/g, ' '))}</div>
<div style="font-size:17px;font-weight:700;color:${NAVY};margin-bottom:6px;">${esc(prod.name)}</div>
<div style="font-size:14px;line-height:1.55;color:${INK};">${esc(blurb)}</div>
${link ? `<div style="margin-top:10px;"><a href="${esc(link)}" style="font-size:14px;font-weight:600;color:${NAVY};">Learn more &rarr;</a></div>` : ''}
</td></tr></table>`,
            '4px 32px 16px',
          ),
        );
        textParts.push(`${prod.name} — ${blurb}${link ? `\n${link}` : ''}`);
        break;
      }
      case 'divider':
        htmlRows.push(row('<div style="border-top:1px solid #e8ebf0;margin:8px 0 18px;"></div>'));
        textParts.push('—');
        break;
      case 'spacer':
        htmlRows.push(`<tr><td style="height:${b.size === 'lg' ? 40 : b.size === 'sm' ? 12 : 24}px;line-height:0;font-size:0;">&nbsp;</td></tr>`);
        break;
    }
  }

  const footer = `Class One Systems · classonesystems.in<br>Not interested in emails like this? Reply with "unsubscribe" and we won't send you any more.`;
  const subject = p(input.subject);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f5f9;font-family:Segoe UI,Arial,Helvetica,sans-serif;">
${input.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(p(input.preheader))}</div>` : ''}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3f5f9;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;">
<tr><td style="height:6px;background:${NAVY};line-height:0;font-size:0;">&nbsp;</td></tr>
<tr><td style="height:24px;line-height:0;font-size:0;">&nbsp;</td></tr>
${htmlRows.join('\n')}
<tr><td style="height:12px;line-height:0;font-size:0;">&nbsp;</td></tr>
</table>
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;"><tr><td style="padding:16px 32px;font-size:12px;line-height:1.6;color:${MUTED};text-align:center;">${footer}</td></tr></table>
</td></tr></table></body></html>`;

  const text = [...textParts, '', '—', `Class One Systems · classonesystems.in`, `Not interested in emails like this? Reply with "unsubscribe" and we won't send you any more.`].join('\n\n');
  return { subject, html, text, attachments };
}

/** The List-Unsubscribe header: a reply to the sales inbox, which the AI triage already handles. */
export const listUnsubscribeHeader = () => `<mailto:${env.EMAIL_FROM_ADDRESS}?subject=unsubscribe>`;
