/**
 * Pipeline trigger — starts finding people at chosen institutes, now or on a
 * schedule. Each person found joins the conveyor straight away (Found →
 * Verified → Scored → Filling info → In Leads); in Auto they flow through on
 * their own, in Manual they wait in Found for a person.
 *
 * Steps: Where → Options → When → Review. "By name" looks up known
 * researchers at once and skips the When step.
 */
import { useEffect, useState } from 'react';
import { api, type BatchNameResult, type RosterPipelinePayload } from '../../api/client';
import { InstitutePicker } from '../../components/pickers';
import { ErrorBanner, shortInstitute } from '../../components/common';
import { Modal, Segmented, WizardSteps } from '../../components/ui';
import type { FlowRunConfig, PipelineSchedule, RosterConfig } from '../../types';
import { describeSchedule, WEEKDAYS } from './flow';

type When = 'now' | 'once' | 'recurring';

/** "YYYY-MM-DDTHH:MM" in local time, for a datetime-local input. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function inAnHour(): string {
  const d = new Date(Date.now() + 3600_000);
  d.setMinutes(0, 0, 0);
  return toLocalInput(d);
}

export function PipelineTrigger({
  config,
  mode: pipelineMode,
  editing,
  onClose,
  onStarted,
}: {
  config: RosterConfig;
  mode: 'auto' | 'manual';
  /** Editing an existing schedule: opens on its settings, saves back to it. */
  editing?: PipelineSchedule;
  onClose: () => void;
  onStarted: () => void;
}) {
  const initial = editing?.config;
  const [step, setStep] = useState(0);
  const [by, setBy] = useState<'institutes' | 'names'>('institutes');
  const [institutes, setInstitutes] = useState<string[]>(initial?.institutionIds ?? []);
  const [names, setNames] = useState('');
  const [nameInstitute, setNameInstitute] = useState('');

  // Options
  const [areas, setAreas] = useState<string[]>(initial?.focus?.items ?? []);
  const [threshold, setThreshold] = useState(initial?.threshold ?? config.defaultThreshold ?? 60);
  const [advanced, setAdvanced] = useState(false);
  const [sources, setSources] = useState<string[]>(initial?.sources ?? ['openalex', 'orcid', 'faculty_pages']);
  const [minWorks, setMinWorks] = useState(initial?.minWorks ?? 5);
  const [includeInferred, setIncludeInferred] = useState(initial?.includeInferredRoles ?? true);
  const [useScraper, setUseScraper] = useState(initial?.useScraper ?? true);
  const [useGemini, setUseGemini] = useState(initial?.useGeminiBackfill ?? true);

  // When
  const [when, setWhen] = useState<When>(editing ? editing.type : 'now');
  const [runAt, setRunAt] = useState(editing?.runAt ? toLocalInput(new Date(editing.runAt)) : inAnHour());
  const [weekdays, setWeekdays] = useState<number[]>(editing?.weekdays ?? [1]);
  const [time, setTime] = useState(editing?.time ?? '09:00');
  const [name, setName] = useState(editing?.name ?? '');

  // Review / result
  const [estimate, setEstimate] = useState<Awaited<ReturnType<typeof api.rosterPipelineEstimate>> | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [nameResult, setNameResult] = useState<BatchNameResult | null>(null);

  const runConfig: FlowRunConfig = {
    institutionIds: institutes,
    sources,
    minWorks,
    includeInferredRoles: includeInferred,
    threshold,
    useScraper,
    useGeminiBackfill: useGemini,
    ...(areas.length ? { focus: { items: areas, as: 'applicationAreas' as const, mode: 'only' as const } } : {}),
  };

  const instName = (id: string) => shortInstitute(config.institutions.find((i) => i.id === id)?.name ?? id);
  const nameList = names
    .split('\n')
    .map((n) => n.trim())
    .filter(Boolean);
  const steps = by === 'names' ? ['Where', 'Review'] : ['Where', 'Options', 'When', 'Review'];
  const reviewStep = steps.length - 1;
  const whereOk = by === 'institutes' ? institutes.length > 0 : nameList.length > 0 && nameList.length <= 50;
  const whenOk = when === 'now' || (when === 'once' ? new Date(runAt).getTime() > Date.now() : weekdays.length > 0 && /^\d\d:\d\d$/.test(time));
  const autoName = `${institutes.slice(0, 2).map(instName).join(', ')}${institutes.length > 2 ? ` +${institutes.length - 2}` : ''}`;

  // Cost estimate on reaching Review (institutes only).
  useEffect(() => {
    if (step !== reviewStep || by !== 'institutes') return;
    const payload: RosterPipelinePayload = { ...runConfig, stages: ['build', 'verify', 'score', 'promote', 'fill'] };
    setEstimating(true);
    api
      .rosterPipelineEstimate(payload)
      .then(setEstimate)
      .catch(() => setEstimate(null))
      .finally(() => setEstimating(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (by === 'names') {
        setNameResult(await api.discoverByNames(nameList, nameInstitute || undefined));
        setDone('Looked up.');
      } else if (when === 'now') {
        await api.startFlowRun({ ...runConfig, label: autoName });
        setDone(pipelineMode === 'auto' ? 'Started. People appear in Found as they are discovered and move through the stages on their own.' : 'Started. People appear in Found as they are discovered — Manual mode, so each step waits for you.');
      } else {
        const schedule = {
          name: name.trim() || autoName,
          config: { ...runConfig, label: name.trim() || autoName },
          type: when,
          ...(when === 'once' ? { runAt: new Date(runAt).toISOString() } : { weekdays: [...weekdays].sort(), time }),
        } as const;
        if (editing) await api.updatePipelineSchedule(editing.id, { ...schedule, enabled: true });
        else await api.createPipelineSchedule(schedule);
        setDone(`Scheduled: ${describeSchedule(schedule)}.`);
      }
      onStarted();
      setStep(steps.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start');
    } finally {
      setBusy(false);
    }
  }

  const credits = estimate ? estimate.scoreCredits + estimate.promoteScanCredits.max : 0;
  const finished = step >= steps.length;

  return (
    <Modal onClose={onClose}>
      <h2>{editing ? 'Edit scheduled run' : 'Pipeline trigger'}</h2>
      <p className="muted" style={{ margin: '0 0 22px' }}>
        Find professors and scientists, then move each one through verify → score → Leads as soon as they are found.
      </p>
      {!finished && <WizardSteps steps={steps} current={step} />}
      {error && <ErrorBanner message={error} />}

      {step === 0 && (
        <div style={{ display: 'grid', gap: 18 }}>
          {!editing && (
            <div className="choice-grid">
              <button className={`choice${by === 'institutes' ? ' active' : ''}`} onClick={() => setBy('institutes')}>
                <strong>By institute</strong>
                <span>Everyone in the relevant departments at chosen IITs, NITs and IIITs.</span>
              </button>
              <button className={`choice${by === 'names' ? ' active' : ''}`} onClick={() => setBy('names')}>
                <strong>By name</strong>
                <span>Look up specific researchers you already know about.</span>
              </button>
            </div>
          )}
          {by === 'institutes' ? (
            <div>
              <label>Institutes</label>
              <InstitutePicker options={config.institutions} selected={institutes} onChange={setInstitutes} />
              {institutes.length > 0 && <p className="muted small" style={{ margin: '8px 0 0' }}>{institutes.map(instName).join(', ')}</p>}
            </div>
          ) : (
            <>
              <div>
                <label>Names, one per line (up to 50)</label>
                <textarea rows={7} value={names} onChange={(e) => setNames(e.target.value)} placeholder={'Arnab Dutta\nSagar Mitra'} />
              </div>
              <div>
                <label>Institute (optional, improves matching)</label>
                <select value={nameInstitute} onChange={(e) => setNameInstitute(e.target.value)}>
                  <option value="">Any institute</option>
                  {config.institutions.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
        </div>
      )}

      {step === 1 && by === 'institutes' && (
        <div style={{ display: 'grid', gap: 20 }}>
          <div>
            <label>Focus on application areas (optional)</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {config.applicationAreas.map((a) => (
                <button key={a.label} className={`btn btn-sm${areas.includes(a.label) ? ' btn-primary' : ''}`} onClick={() => setAreas(areas.includes(a.label) ? areas.filter((x) => x !== a.label) : [...areas, a.label])}>
                  {a.label}
                </button>
              ))}
            </div>
            <p className="muted small" style={{ margin: '6px 0 0' }}>{areas.length === 0 ? 'None chosen — all of Class One’s areas count.' : 'Only these areas count towards the score.'}</p>
          </div>
          <div style={{ maxWidth: 280 }}>
            <label>Minimum score to move into Leads</label>
            <input type="number" min={0} max={100} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
            <p className="muted small" style={{ margin: '6px 0 0' }}>{pipelineMode === 'auto' ? 'In Auto, people below this are excluded (you can restore them).' : 'In Manual, people below this wait in Scored.'}</p>
          </div>
          <div>
            <button className="btn btn-ghost btn-sm" onClick={() => setAdvanced(!advanced)}>
              {advanced ? 'Hide advanced options' : 'Advanced options'}
            </button>
            {advanced && (
              <div className="card card-pad" style={{ marginTop: 10, display: 'grid', gap: 12, boxShadow: 'none' }}>
                <div>
                  <label>Sources</label>
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                    {(['openalex', 'orcid', 'faculty_pages', 'vidwan'] as const).map((s) => (
                      <label key={s} className="checkbox-row" style={{ margin: 0 }}>
                        <input type="checkbox" checked={sources.includes(s)} onChange={(e) => setSources(e.target.checked ? [...sources, s] : sources.filter((x) => x !== s))} />
                        {{ openalex: 'OpenAlex', orcid: 'ORCID', faculty_pages: 'Faculty pages', vidwan: 'Vidwan' }[s]}
                      </label>
                    ))}
                  </div>
                </div>
                <label className="checkbox-row" style={{ margin: 0 }}>
                  <input type="checkbox" checked={includeInferred} onChange={(e) => setIncludeInferred(e.target.checked)} />
                  Include people whose role is inferred from their publication record
                </label>
                <div style={{ maxWidth: 220 }}>
                  <label>Minimum publications</label>
                  <input type="number" min={1} max={100} value={minWorks} onChange={(e) => setMinWorks(Number(e.target.value))} />
                </div>
                <label className="checkbox-row" style={{ margin: 0 }}>
                  <input type="checkbox" checked={useScraper} onChange={(e) => setUseScraper(e.target.checked)} />
                  Fill info: read institute pages and open-access papers
                </label>
                <label className="checkbox-row" style={{ margin: 0 }}>
                  <input type="checkbox" checked={useGemini} onChange={(e) => setUseGemini(e.target.checked)} />
                  Fill info: web-search what's still missing with Gemini (within the daily cap)
                </label>
              </div>
            )}
          </div>
        </div>
      )}

      {step === 2 && by === 'institutes' && (
        <div style={{ display: 'grid', gap: 18 }}>
          <Segmented
            items={[
              { key: 'now', label: 'Now' },
              { key: 'once', label: 'Once, later' },
              { key: 'recurring', label: 'Repeat' },
            ]}
            value={when}
            onChange={(k) => setWhen(k as When)}
          />
          {when === 'once' && (
            <div style={{ maxWidth: 280 }}>
              <label>Date and time</label>
              <input type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} />
            </div>
          )}
          {when === 'recurring' && (
            <>
              <div>
                <label>On</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {WEEKDAYS.map((d, i) => (
                    <button key={d} className={`btn btn-sm${weekdays.includes(i) ? ' btn-primary' : ''}`} onClick={() => setWeekdays(weekdays.includes(i) ? weekdays.filter((x) => x !== i) : [...weekdays, i])}>
                      {d}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ maxWidth: 200 }}>
                <label>At (India time)</label>
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </div>
            </>
          )}
          {when !== 'now' && (
            <>
              <div style={{ maxWidth: 360 }}>
                <label>Name (optional)</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder={autoName} />
              </div>
              <p className="muted small" style={{ margin: 0 }}>Runs only while the server is on. A run missed while it was off starts once when it's back, marked "started late".</p>
            </>
          )}
        </div>
      )}

      {step === reviewStep && !finished && (
        <div style={{ display: 'grid', gap: 16 }}>
          {by === 'names' ? (
            <p style={{ margin: 0 }}>
              Look up <strong>{nameList.length}</strong> name{nameList.length === 1 ? '' : 's'}
              {nameInstitute && <> at {instName(nameInstitute)}</>}, score them, and add matches to <strong>Leads → To review</strong>.
            </p>
          ) : (
            <>
              <div>
                <strong>
                  {institutes.length} institute{institutes.length === 1 ? '' : 's'}
                </strong>
                <span className="muted"> · {autoName}</span>
              </div>
              <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 6 }}>
                <li>Find professors and scientists in the relevant departments</li>
                <li>Check each is still at the institute</li>
                <li>Score how well their work fits the catalog{areas.length ? ` (${areas.join(', ')})` : ''}</li>
                <li>Move people scoring {threshold}+ into Leads{pipelineMode === 'auto' ? ', exclude the rest' : ''}</li>
                <li>Find missing email, title and phone{useGemini ? ' (Gemini web search within the daily cap)' : ''}</li>
              </ol>
              <div className="card card-pad" style={{ boxShadow: 'none', background: 'var(--surface-alt)', border: 'none', display: 'grid', gap: 6 }}>
                <div>
                  <strong>When: </strong>
                  {when === 'now' ? 'Now' : describeSchedule({ type: when, runAt: new Date(runAt).toISOString(), weekdays, time })}
                </div>
                <div>
                  <strong>Mode: </strong>
                  {pipelineMode === 'auto' ? 'Auto — each person moves on as soon as they are found.' : 'Manual — people wait in Found until you run each step.'}
                </div>
                <div>
                  <strong>Cost: </strong>
                  {estimating ? 'working it out…' : estimate ? (credits === 0 ? 'free for people already known; new people cost about 1 OpenAlex credit each to score.' : `about ${credits.toLocaleString()} OpenAlex credits for people already known, plus about 1 per new person.`) : 'about 1 OpenAlex credit per person scored.'}
                  <span className="muted"> Scoring pauses at the daily cap and resumes the next day.</span>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {finished && (
        <div style={{ display: 'grid', gap: 10 }}>
          <p style={{ margin: 0 }}>{done}</p>
          {nameResult && (
            <p style={{ margin: 0 }}>
              <strong>{nameResult.created} added</strong> to Leads · {nameResult.duplicates} already there · {nameResult.notFound} not found
              {nameResult.errors > 0 && ` · ${nameResult.errors} failed`}
            </p>
          )}
        </div>
      )}

      <div className="modal-foot">
        <button className="btn btn-ghost" onClick={step === 0 || finished ? onClose : () => setStep(step - 1)}>
          {step === 0 ? 'Cancel' : finished ? 'Close' : 'Back'}
        </button>
        {!finished && step < reviewStep && (
          <button className="btn btn-primary" disabled={step === 0 ? !whereOk : step === 2 ? !whenOk : false} onClick={() => setStep(step + 1)}>
            Continue
          </button>
        )}
        {!finished && step === reviewStep && (
          <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Working…' : by === 'names' ? 'Look them up' : when === 'now' ? 'Start now' : editing ? 'Save schedule' : 'Schedule'}
          </button>
        )}
      </div>
    </Modal>
  );
}
