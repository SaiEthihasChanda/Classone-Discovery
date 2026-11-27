/**
 * One campaign: built in three steps — Design (blocks on the left, the email as
 * it will arrive on the right), Audience (filters with a live count), Review &
 * send (subject, test email, pace, send now or schedule). Saves as you go.
 * Once sending, it becomes a report: progress, who got it, who replied.
 */
import { CampaignResults } from './CampaignResults';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { ErrorBanner, Loading, formatDate, relativeTime } from '../../components/common';
import { MultiSelect } from '../../components/pickers';
import { Modal, Segmented } from '../../components/ui';
import type { AudiencePreview, Campaign, CampaignAudience, CampaignBlock, CampaignRecipient } from '../../types';
import { STATUS_LABEL } from './CampaignsPage';

type Step = 0 | 1 | 2;
type Options = Awaited<ReturnType<typeof api.campaignAudienceOptions>>;

const newId = () => Math.random().toString(36).slice(2, 10);

const BLOCK_TYPES: Array<{ type: CampaignBlock['type']; label: string; icon: string; make: () => CampaignBlock }> = [
  { type: 'heading', label: 'Heading', icon: 'H', make: () => ({ id: newId(), type: 'heading', text: 'A clear headline' }) },
  { type: 'text', label: 'Text', icon: '¶', make: () => ({ id: newId(), type: 'text', text: '' }) },
  { type: 'image', label: 'Image / poster', icon: '▣', make: () => ({ id: newId(), type: 'image', assetId: '' }) },
  { type: 'button', label: 'Button', icon: '▭', make: () => ({ id: newId(), type: 'button', label: 'Book a demo', url: 'https://classonesystems.in' }) },
  { type: 'product', label: 'Product', icon: '◆', make: () => ({ id: newId(), type: 'product', productId: '' }) },
  { type: 'divider', label: 'Divider', icon: '—', make: () => ({ id: newId(), type: 'divider' }) },
  { type: 'spacer', label: 'Space', icon: '↕', make: () => ({ id: newId(), type: 'spacer', size: 'md' }) },
];

const FIELDS = ['{first_name}', '{last_name}', '{title|Dr.}', '{institute}', '{department}'];

export function CampaignBuilder({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const [c, setC] = useState<Campaign | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty'>('saved');
  const [step, setStep] = useState<Step>(0);
  const [options, setOptions] = useState<Options | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Edits not yet saved — merged, so two quick edits to different fields both reach the server. */
  const pending = useRef<Partial<Campaign>>({});
  const [editingPaused, setEditingPaused] = useState(false);

  const load = () =>
    api
      .campaign(id)
      .then((d) => (setC(d), setError(null)))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load'));
  useEffect(() => {
    void load();
    void api.campaignAudienceOptions().then(setOptions).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const editable = c?.status === 'draft' || c?.status === 'paused' || c?.status === 'scheduled';

  /** Local change now, saved to the server shortly after typing stops. */
  const change = (patch: Partial<Campaign>) => {
    setC((cur) => (cur ? { ...cur, ...patch } : cur));
    pending.current = { ...pending.current, ...patch };
    setSaveState('dirty');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const toSave = pending.current;
      pending.current = {};
      setSaveState('saving');
      try {
        await api.updateCampaign(id, toSave as never);
        setSaveState(Object.keys(pending.current).length ? 'dirty' : 'saved');
      } catch (e) {
        pending.current = { ...toSave, ...pending.current };
        setError(e instanceof Error ? e.message : 'Could not save');
        setSaveState('dirty');
      }
    }, 700);
  };
  const changeBlocks = (blocks: CampaignBlock[]) => change({ blocks });

  if (error && !c) return <ErrorBanner message={error} />;
  if (!c) return <Loading />;

  // Sending, scheduled, sent or cancelled: the report. Paused: the report too, until "Edit".
  const reporting = !editable || c.status === 'scheduled' || (c.status === 'paused' && !editingPaused);

  return (
    <div className="builder">
      <div className="builder-head">
        <button className="btn btn-sm btn-ghost" onClick={onClose}>
          ← Campaigns
        </button>
        <input className="builder-name" value={c.name} onChange={(e) => change({ name: e.target.value })} aria-label="Campaign name" />
        <span className={`cstatus ${c.status}`}>{STATUS_LABEL[c.status]}</span>
        <span className="muted small">{saveState === 'saved' ? 'All changes saved' : saveState === 'saving' ? 'Saving…' : 'Editing…'}</span>
      </div>
      {error && <ErrorBanner message={error} />}

      {reporting ? (
        <CampaignReport campaign={c} onChanged={load} onOpen={onOpen} onEdit={() => (setEditingPaused(true), setStep(0))} />
      ) : (
        <>
          <div className="builder-steps" role="tablist">
            {(['Design', 'Audience', 'Review & send'] as const).map((label, i) => (
              <button key={label} role="tab" aria-selected={step === i} className={`builder-step${step === i ? ' active' : i < step ? ' done' : ''}`} onClick={() => setStep(i as Step)}>
                <span className="dot">{i < step ? '✓' : i + 1}</span>
                {label}
              </button>
            ))}
          </div>
          {step === 0 && <DesignStep c={c} options={options} onBlocks={changeBlocks} onChange={change} />}
          {step === 1 && <AudienceStep c={c} options={options} onAudience={(audience) => change({ audience })} />}
          {step === 2 && <ReviewStep c={c} onChange={change} onStarted={load} flush={saveState !== 'saved'} />}
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 16 }}>
            <button className="btn" disabled={step === 0} onClick={() => setStep((step - 1) as Step)}>
              Back
            </button>
            {step < 2 && (
              <button className="btn btn-primary" onClick={() => setStep((step + 1) as Step)}>
                Next: {step === 0 ? 'Audience' : 'Review & send'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// --- Design ----------------------------------------------------------------------------------------

function DesignStep({ c, options, onBlocks, onChange }: { c: Campaign; options: Options | null; onBlocks: (b: CampaignBlock[]) => void; onChange: (p: Partial<Campaign>) => void }) {
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [html, setHtml] = useState('');
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  // Live preview, a moment after edits stop.
  useEffect(() => {
    const t = setTimeout(() => {
      api
        .campaignPreview({ subject: c.subject, preheader: c.preheader, blocks: c.blocks.filter((b) => b.type !== 'image' || b.assetId) })
        .then((p) => setHtml(p.html))
        .catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [c.blocks, c.subject, c.preheader]);

  const update = (i: number, b: CampaignBlock) => onBlocks(c.blocks.map((x, j) => (j === i ? b : x)));
  const remove = (i: number) => onBlocks(c.blocks.filter((_, j) => j !== i));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= c.blocks.length || from === to) return;
    const next = [...c.blocks];
    const [b] = next.splice(from, 1);
    next.splice(to, 0, b!);
    onBlocks(next);
  };

  return (
    <div className="design">
      <div className="design-blocks">
        <label className="field">
          <span>Subject line</span>
          <input value={c.subject} onChange={(e) => onChange({ subject: e.target.value })} placeholder="e.g. {first_name}, see the new EmStat4 range" />
        </label>
        <p className="muted small" style={{ margin: '4px 0 12px' }}>
          Personal fields, filled per person: {FIELDS.map((f) => <code key={f} className="field-chip">{f}</code>)} — text after | is used when the value is missing.
        </p>

        {c.blocks.map((b, i) => (
          <div
            key={b.id}
            className={`block-card${dragFrom === i ? ' dragging' : ''}`}
            draggable
            onDragStart={() => setDragFrom(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => (dragFrom !== null && move(dragFrom, i), setDragFrom(null))}
            onDragEnd={() => setDragFrom(null)}
          >
            <div className="block-head">
              <span className="drag-handle" title="Drag to reorder">⋮⋮</span>
              <strong>{BLOCK_TYPES.find((t) => t.type === b.type)?.label}</strong>
              <span style={{ flex: 1 }} />
              <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => move(i, i - 1)}>↑</button>
              <button className="icon-btn" title="Move down" disabled={i === c.blocks.length - 1} onClick={() => move(i, i + 1)}>↓</button>
              <button className="icon-btn" title="Remove" onClick={() => remove(i)}>✕</button>
            </div>
            <BlockFields block={b} options={options} thumb={b.type === 'image' ? thumbs[b.assetId] : undefined} onThumb={(assetId, url) => setThumbs((t) => ({ ...t, [assetId]: url }))} onChange={(nb) => update(i, nb)} />
          </div>
        ))}

        <div className="block-palette">
          <span className="muted small">Add a block</span>
          {BLOCK_TYPES.map((t) => (
            <button key={t.type} className="palette-btn" onClick={() => onBlocks([...c.blocks, t.make()])}>
              <span className="palette-icon">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="design-preview">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <span className="muted small">How it arrives — shown for a sample recipient</span>
          <Segmented items={[{ key: 'desktop', label: 'Desktop' }, { key: 'mobile', label: 'Phone' }]} value={device} onChange={setDevice} />
        </div>
        <div className={`preview-frame ${device}`}>
          <div className="preview-mailhead">
            <strong>{c.subject || 'No subject yet'}</strong>
            <span className="muted small">Class One Systems &lt;sales&gt;</span>
          </div>
          <iframe title="Email preview" srcDoc={html} sandbox="" />
        </div>
      </div>
    </div>
  );
}

/** Left / centre / right (and, for buttons, full width) as a small icon toggle. */
function AlignPicker<A extends 'left' | 'center' | 'right' | 'full'>({ value, onChange, full }: { value: A; onChange: (a: A) => void; full?: boolean }) {
  const opts: Array<{ key: 'left' | 'center' | 'right' | 'full'; title: string; bars: number[][] }> = [
    { key: 'left', title: 'Left', bars: [[2, 12], [2, 8], [2, 12]] },
    { key: 'center', title: 'Centre', bars: [[4, 12], [6, 8], [4, 12]] },
    { key: 'right', title: 'Right', bars: [[6, 12], [10, 8], [6, 12]] },
    ...(full ? [{ key: 'full' as const, title: 'Full width', bars: [[2, 16], [2, 16], [2, 16]] }] : []),
  ];
  return (
    <span className="align-picker" role="radiogroup">
      {opts.map((o) => (
        <button key={o.key} type="button" role="radio" aria-checked={value === o.key} title={o.title} className={value === o.key ? 'active' : ''} onClick={() => onChange(o.key as A)}>
          <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden="true">
            {o.bars.map(([x, w], i) => (
              <rect key={i} x={x} y={1 + i * 5} width={w} height="2" rx="1" fill="currentColor" />
            ))}
          </svg>
        </button>
      ))}
    </span>
  );
}

/** Shrinks an image to at most 1200 px wide in the browser before upload (keeps emails light). */
async function shrinkImage(file: File): Promise<{ data: string; contentType: string; width: number; height: number; previewUrl: string }> {
  const url = URL.createObjectURL(file);
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('That file is not an image this browser can read.'));
    i.src = url;
  });
  const scale = Math.min(1, 1200 / img.naturalWidth);
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
  URL.revokeObjectURL(url);
  // PNG keeps sharp posters with text crisp when small enough; photos become JPEG.
  let contentType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  let dataUrl = canvas.toDataURL(contentType, 0.86);
  if (contentType === 'image/png' && dataUrl.length > 1_300_000) {
    contentType = 'image/jpeg';
    dataUrl = canvas.toDataURL(contentType, 0.86);
  }
  return { data: dataUrl.split(',')[1]!, contentType, width: w, height: h, previewUrl: dataUrl };
}

function BlockFields({ block: b, options, thumb, onThumb, onChange }: { block: CampaignBlock; options: Options | null; thumb?: string; onThumb: (id: string, url: string) => void; onChange: (b: CampaignBlock) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [brief, setBrief] = useState('');
  const [showBrief, setShowBrief] = useState(false);

  switch (b.type) {
    case 'heading':
      return (
        <div className="row" style={{ gap: 8 }}>
          <input style={{ flex: 1 }} value={b.text} onChange={(e) => onChange({ ...b, text: e.target.value })} />
          <select style={{ width: 'auto' }} value={b.size ?? 'lg'} onChange={(e) => onChange({ ...b, size: e.target.value as 'lg' | 'md' })}>
            <option value="lg">Large</option>
            <option value="md">Medium</option>
          </select>
          <AlignPicker value={b.align ?? 'left'} onChange={(align) => onChange({ ...b, align })} />
        </div>
      );
    case 'text':
      return (
        <>
          <textarea rows={Math.max(4, b.text.split('\n').length + 1)} value={b.text} onChange={(e) => onChange({ ...b, text: e.target.value })} placeholder="Your message. A blank line starts a new paragraph; **bold**; links become clickable." />
          {err && <div className="composer-error" style={{ marginTop: 6 }}>{err}</div>}
          {showBrief ? (
            <div className="row" style={{ gap: 6, marginTop: 6 }}>
              <input style={{ flex: 1 }} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="What should it say? e.g. invite battery researchers to a free EIS webinar on 12 Dec" autoFocus />
              <button
                className="btn btn-sm ai-btn"
                disabled={busy || brief.trim().length < 3}
                onClick={async () => {
                  setBusy(true);
                  setErr(null);
                  try {
                    const r = await api.campaignAiText(brief);
                    onChange({ ...b, text: r.text });
                    setShowBrief(false);
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : 'Could not write it');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? 'Writing…' : 'Write'}
              </button>
            </div>
          ) : (
            <button className="btn btn-sm ai-btn" style={{ marginTop: 6 }} onClick={() => setShowBrief(true)}>
              ✦ Write with AI
            </button>
          )}
        </>
      );
    case 'image':
      return (
        <div className="image-block">
          {b.assetId ? (
            thumb ? <img src={thumb} alt="" className="image-thumb" /> : <div className="image-thumb placeholder">Image uploaded — see the preview</div>
          ) : (
            <label className="upload-drop">
              {busy ? 'Uploading…' : 'Choose an image or poster (PNG/JPEG)'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                hidden
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setBusy(true);
                  setErr(null);
                  try {
                    const small = await shrinkImage(file);
                    const r = await api.uploadCampaignAsset({ filename: file.name, contentType: small.contentType, data: small.data, width: small.width, height: small.height });
                    onThumb(r.id, small.previewUrl);
                    onChange({ ...b, assetId: r.id, alt: b.alt || file.name.replace(/\.[^.]+$/, '') });
                  } catch (er) {
                    setErr(er instanceof Error ? er.message : 'Upload failed');
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            </label>
          )}
          {err && <div className="composer-error">{err}</div>}
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className="muted small">Size</span>
            <select style={{ width: 'auto' }} value={b.width ?? 'full'} onChange={(e) => onChange({ ...b, width: e.target.value as 'full' | 'large' | 'medium' | 'small' })}>
              <option value="full">Full width</option>
              <option value="large">Large</option>
              <option value="medium">Medium</option>
              <option value="small">Small</option>
            </select>
            {(b.width ?? 'full') !== 'full' && (
              <>
                <span className="muted small">Position</span>
                <AlignPicker value={b.align ?? 'center'} onChange={(align) => onChange({ ...b, align })} />
              </>
            )}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <input style={{ flex: 1 }} value={b.alt ?? ''} onChange={(e) => onChange({ ...b, alt: e.target.value })} placeholder="Describe the image (shown if images are off)" />
            <input style={{ flex: 1 }} value={b.link ?? ''} onChange={(e) => onChange({ ...b, link: e.target.value })} placeholder="Link when clicked (optional)" />
          </div>
          {b.assetId && (
            <button className="link-btn small" onClick={() => onChange({ ...b, assetId: '' })}>
              Replace image
            </button>
          )}
        </div>
      );
    case 'button':
      return (
        <div style={{ display: 'grid', gap: 8 }}>
          <div className="row" style={{ gap: 8 }}>
            <input style={{ flex: 1 }} value={b.label} onChange={(e) => onChange({ ...b, label: e.target.value })} placeholder="Button text" />
            <input style={{ flex: 2 }} value={b.url} onChange={(e) => onChange({ ...b, url: e.target.value })} placeholder="https://…" />
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className="muted small">Position</span>
            <AlignPicker value={b.align ?? 'left'} full onChange={(align) => onChange({ ...b, align })} />
            <span className="muted small" style={{ marginLeft: 8 }}>Style</span>
            <select style={{ width: 'auto' }} value={b.style ?? 'solid'} onChange={(e) => onChange({ ...b, style: e.target.value as 'solid' | 'outline' })}>
              <option value="solid">Filled</option>
              <option value="outline">Outline</option>
            </select>
          </div>
        </div>
      );
    case 'product':
      return (
        <div style={{ display: 'grid', gap: 8 }}>
          <select value={b.productId} onChange={(e) => onChange({ ...b, productId: e.target.value })}>
            <option value="">Choose a product…</option>
            {options?.products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input value={b.blurb ?? ''} onChange={(e) => onChange({ ...b, blurb: e.target.value })} placeholder="Short description (optional — the catalog's is used otherwise)" />
          <input value={b.url ?? ''} onChange={(e) => onChange({ ...b, url: e.target.value })} placeholder="Link (optional)" />
        </div>
      );
    case 'spacer':
      return (
        <select value={b.size ?? 'md'} onChange={(e) => onChange({ ...b, size: e.target.value as 'sm' | 'md' | 'lg' })}>
          <option value="sm">Small</option>
          <option value="md">Medium</option>
          <option value="lg">Large</option>
        </select>
      );
    case 'divider':
      return <span className="muted small">A thin line between sections.</span>;
  }
}

// --- Audience --------------------------------------------------------------------------------------

function AudienceStep({ c, options, onAudience }: { c: Campaign; options: Options | null; onAudience: (a: CampaignAudience) => void }) {
  const a = c.audience;
  const [preview, setPreview] = useState<AudiencePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      api
        .campaignAudiencePreview(a, c.id)
        .then((p) => (setPreview(p), setError(null)))
        .catch((e) => setError(e instanceof Error ? e.message : 'Could not count'));
    }, 350);
    return () => clearTimeout(t);
  }, [a, c.id]);
  const set = (patch: Partial<CampaignAudience>) => onAudience({ ...a, ...patch });
  const statuses = a.statuses?.length ? a.statuses : ['approved', 'customer'];
  const toggleStatus = (s: 'pending_review' | 'approved' | 'customer') => {
    const next = statuses.includes(s) ? statuses.filter((x) => x !== s) : [...statuses, s];
    set({ statuses: next.length ? (next as CampaignAudience['statuses']) : ['approved'] });
  };

  return (
    <div className="audience">
      <div className="card card-pad audience-filters">
        <h3 style={{ marginTop: 0 }}>Who gets it</h3>
        {a.leadIds?.length ? (
          <div className="aud-picked">
            <span>
              The AI picked <strong>{a.leadIds.length}</strong> {a.leadIds.length === 1 ? 'person' : 'people'} this product fits. The filters below narrow that list.
            </span>
            <button className="btn btn-ghost btn-sm" onClick={() => set({ leadIds: undefined })}>
              Use filters instead
            </button>
          </div>
        ) : null}
        <div className="aud-row">
          <span className="aud-label">Lead status</span>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {(
              [
                ['approved', 'Approved'],
                ['customer', 'Customers'],
                ['pending_review', 'Still to review'],
              ] as const
            ).map(([k, l]) => (
              <button key={k} className={`chip${statuses.includes(k) ? ' active' : ''}`} onClick={() => toggleStatus(k)}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <div className="aud-row">
          <span className="aud-label">Relevance score</span>
          <div className="row" style={{ gap: 10 }}>
            <input type="range" min={0} max={100} step={5} value={a.minScore ?? 0} onChange={(e) => set({ minScore: Number(e.target.value) || undefined })} />
            <span className="small">{a.minScore ? `${a.minScore} and above` : 'Any'}</span>
          </div>
        </div>
        <div className="aud-row">
          <span className="aud-label">Narrow by</span>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <MultiSelect label="Institutes" searchable options={(options?.institutes ?? []).map((v) => ({ value: v, label: v }))} selected={a.institutes ?? []} onChange={(v) => set({ institutes: v })} />
            <MultiSelect label="Application areas" searchable options={(options?.applicationAreas ?? []).map((v) => ({ value: v, label: v }))} selected={a.applicationAreas ?? []} onChange={(v) => set({ applicationAreas: v })} />
            <MultiSelect label="Products that fit" searchable options={(options?.products ?? []).map((p) => ({ value: p.id, label: p.name }))} selected={a.productIds ?? []} onChange={(v) => set({ productIds: v })} />
            <MultiSelect label="Tags" searchable options={(options?.tags ?? []).map((v) => ({ value: v, label: v }))} selected={a.tags ?? []} onChange={(v) => set({ tags: v })} />
          </div>
        </div>
        <div className="aud-row">
          <span className="aud-label">Name / email / institute</span>
          <input value={a.search ?? ''} onChange={(e) => set({ search: e.target.value || undefined })} placeholder="Contains…" />
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>Always left out: leads with no email, anyone who asked not to be contacted, rejected leads, and people this campaign already reached.</p>
      </div>

      <div className="card card-pad audience-result">
        {error && <ErrorBanner message={error} />}
        <div className="aud-count">
          <strong>{preview ? preview.count.toLocaleString() : '…'}</strong>
          <span>{preview?.count === 1 ? 'person' : 'people'} will get this</span>
        </div>
        {preview && preview.alreadySent > 0 && <p className="muted small">{preview.alreadySent} already received it.</p>}
        <div className="aud-sample">
          {preview?.sample.map((s) => (
            <div key={s.id} className="aud-person">
              <strong>{s.name}</strong>
              <span className="muted small">{[s.institute, s.email].filter(Boolean).join(' · ')}</span>
            </div>
          ))}
          {preview && preview.count > preview.sample.length && <span className="muted small">…and {(preview.count - preview.sample.length).toLocaleString()} more</span>}
        </div>
      </div>
    </div>
  );
}

// --- Review & send ---------------------------------------------------------------------------------

function ReviewStep({ c, onChange, onStarted, flush }: { c: Campaign; onChange: (p: Partial<Campaign>) => void; onStarted: () => void; flush: boolean }) {
  const [count, setCount] = useState<number | null>(null);
  const [testTo, setTestTo] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    void api.campaignAudiencePreview(c.audience, c.id).then((p) => setCount(p.count)).catch(() => {});
  }, [c.audience, c.id]);

  const problems = useMemo(() => {
    const out: string[] = [];
    if (!c.subject.trim()) out.push('Add a subject line (Design step).');
    if (!c.blocks.length) out.push('Add some content (Design step).');
    if (c.blocks.some((b) => b.type === 'image' && !b.assetId)) out.push('An image block has no image yet.');
    if (c.blocks.some((b) => b.type === 'product' && !b.productId)) out.push('A product block has no product chosen.');
    if (count === 0) out.push('Nobody matches the audience.');
    return out;
  }, [c, count]);

  const minutes = count ? Math.ceil((count * c.paceSeconds) / 60) : 0;
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="review">
      <div className="card card-pad" style={{ display: 'grid', gap: 14 }}>
        <label className="field">
          <span>Subject line</span>
          <input value={c.subject} onChange={(e) => onChange({ subject: e.target.value })} />
        </label>
        <label className="field">
          <span>Preview text (the grey line after the subject in most inboxes)</span>
          <input value={c.preheader ?? ''} onChange={(e) => onChange({ preheader: e.target.value })} placeholder="Optional" />
        </label>
        <label className="field">
          <span>Pace</span>
          <select value={c.paceSeconds} onChange={(e) => onChange({ paceSeconds: Number(e.target.value) })}>
            <option value={20}>1 email every 20 seconds</option>
            <option value={30}>1 email every 30 seconds</option>
            <option value={60}>1 email a minute</option>
            <option value={120}>1 email every 2 minutes</option>
          </select>
        </label>
        <p className="muted small" style={{ margin: 0 }}>
          Sent from the sales mailbox, one at a time, so they arrive as normal emails (not bulk mail). Each person can reply — replies appear in Conversations — or answer
          "unsubscribe" to stop.
        </p>
      </div>

      <div className="card card-pad" style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
        <h3 style={{ margin: 0 }}>Send</h3>
        {problems.map((p) => (
          <div key={p} className="composer-error" style={{ margin: 0 }}>
            {p}
          </div>
        ))}
        {error && <ErrorBanner message={error} />}
        {note && <div className="composer-note">{note}</div>}
        <div className="row" style={{ gap: 8 }}>
          <input style={{ flex: 1 }} value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="Test address (blank = yours)" />
          <button className="btn btn-sm" disabled={busy || flush || !c.subject.trim()} onClick={() => act(async () => setNote(`Test sent to ${(await api.sendCampaignTest(c.id, testTo.trim() || undefined)).to}.`))}>
            Send a test
          </button>
        </div>
        <Segmented items={[{ key: 'now', label: 'Send now' }, { key: 'later', label: 'Schedule' }]} value={when} onChange={setWhen} />
        {when === 'later' && <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />}
        <button className="btn btn-primary" disabled={busy || flush || problems.length > 0 || (when === 'later' && !at)} onClick={() => setConfirm(true)}>
          {when === 'now' ? `Send to ${count?.toLocaleString() ?? '…'} people` : 'Schedule'}
        </button>
        {count ? <span className="muted small">Takes about {minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 6) / 10} h`} at this pace; anything past the daily limit goes the next day.</span> : null}
      </div>

      {confirm && (
        <Modal onClose={() => setConfirm(false)}>
          <h2 style={{ marginTop: 0 }}>{when === 'now' ? 'Send this campaign?' : 'Schedule this campaign?'}</h2>
          <p>
            <strong>{c.subject}</strong> goes to <strong>{count?.toLocaleString()} people</strong>
            {when === 'later' ? ` starting ${new Date(at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}` : ' starting now'}, one every {c.paceSeconds} seconds. You can pause it at any time; emails already sent can't be recalled.
          </p>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await api.startCampaign(c.id, when === 'later' ? new Date(at).toISOString() : undefined);
                  setConfirm(false);
                  onStarted();
                })
              }
            >
              {when === 'now' ? 'Send' : 'Schedule'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// --- Report (sending / sent) -----------------------------------------------------------------------

function CampaignReport({ campaign: c, onChanged, onOpen, onEdit }: { campaign: Campaign; onChanged: () => void; onOpen: (id: string) => void; onEdit: () => void }) {
  const { can } = useAuth();
  const [rows, setRows] = useState<CampaignRecipient[] | null>(null);
  const [html, setHtml] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    void api.campaignRecipients(c.id).then((r) => setRows(r.items));
    if (tick === 0) void api.campaignPreview({ subject: c.subject, preheader: c.preheader, blocks: c.blocks }).then((p) => setHtml(p.html));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id, tick]);
  useEffect(() => {
    if (c.status !== 'sending') return;
    const t = setInterval(() => (setTick((n) => n + 1), onChanged()), 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.status]);

  const by = (s: CampaignRecipient['status']) => rows?.filter((r) => r.status === s).length ?? 0;
  const total = rows?.length ?? 0;
  const done = total - by('queued');
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
      setTick((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="report">
      <div className="card card-pad" style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
        {error && <ErrorBanner message={error} />}
        <div className="report-stats">
          <div>
            <strong>{by('sent')}</strong>
            <span>sent</span>
          </div>
          <div>
            <strong>{by('queued')}</strong>
            <span>waiting</span>
          </div>
          <div>
            <strong>{by('failed') + by('skipped')}</strong>
            <span>not sent</span>
          </div>
        </div>
        <div className="progress">
          <span style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} />
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          {c.status === 'scheduled' && c.sendAt ? `Starts ${formatDate(c.sendAt)}.` : c.status === 'sending' ? `Sending one every ${c.paceSeconds} s.` : c.finishedAt ? `Finished ${relativeTime(c.finishedAt)}.` : ''}
        </p>
        {can('sales') && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {(c.status === 'sending' || c.status === 'scheduled') && (
              <button className="btn" disabled={busy} onClick={() => act(() => api.pauseCampaign(c.id))}>
                Pause
              </button>
            )}
            {c.status === 'paused' && (
              <>
                <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api.startCampaign(c.id))}>
                  Resume
                </button>
                <button className="btn" onClick={onEdit}>
                  Edit
                </button>
              </>
            )}
            {(c.status === 'sending' || c.status === 'paused' || c.status === 'scheduled') && (
              <button className="btn btn-danger" disabled={busy} onClick={() => window.confirm('Stop this campaign for good? Nobody else will get it.') && void act(() => api.cancelCampaign(c.id))}>
                Cancel
              </button>
            )}
            <button className="btn" disabled={busy} onClick={() => act(async () => onOpen((await api.duplicateCampaign(c.id)).id))}>
              Duplicate
            </button>
          </div>
        )}
        <div className="recipient-list">
          {rows?.map((r) => (
            <div key={r.id} className="recipient-row">
              <span className={`rdot ${r.status}`} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <strong>{r.name ?? r.email}</strong>
                <span className="muted small"> · {r.email}</span>
                {r.error && <div className="muted small">{r.error}</div>}
              </span>
              <span className="muted small">{r.sentAt ? relativeTime(r.sentAt) : r.status}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="design-preview">
        <div className="preview-frame desktop">
          <div className="preview-mailhead">
            <strong>{c.subject}</strong>
          </div>
          <iframe title="Email preview" srcDoc={html} sandbox="" />
        </div>
      </div>
      <CampaignResults campaignId={c.id} tick={tick} />
    </div>
  );
}
