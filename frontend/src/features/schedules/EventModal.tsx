/** Add or edit a calendar event: what, when, with whom (a lead), where, and which executive goes. */
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/common';
import { Modal } from '../../components/ui';
import type { EventInput, EventType, Lead, ScheduleEvent } from '../../types';
import { StatusPill } from './SchedulesPage';
import { TYPE_META, fmtDayTime, mapLink, toLocalInput } from './scheduleUtils';

export function EventModal({
  event,
  day,
  people,
  onClose,
  onSaved,
}: {
  event?: ScheduleEvent;
  day?: Date;
  people: Array<{ email: string; name: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { can } = useAuth();
  const startDefault = (() => {
    const d = new Date(day ?? new Date());
    d.setHours(day && day.toDateString() !== new Date().toDateString() ? 10 : Math.min(18, new Date().getHours() + 1), 0, 0, 0);
    return d;
  })();
  const [form, setForm] = useState<EventInput & { startLocal: string; endLocal: string }>(() => ({
    title: event?.title ?? '',
    type: event?.type ?? 'visit',
    mode: event?.mode ?? 'in_person',
    address: event?.address ?? '',
    meetingLink: event?.meetingLink ?? '',
    assignee: event?.assignee ?? '',
    notes: event?.notes ?? '',
    leadId: event?.leadId,
    contactName: event?.contactName ?? '',
    contactEmail: event?.contactEmail ?? '',
    institution: event?.institution ?? '',
    startLocal: toLocalInput(event ? new Date(event.start) : startDefault),
    endLocal: toLocalInput(event ? new Date(event.end) : new Date(startDefault.getTime() + 60 * 60_000)),
  }));
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<Lead[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));
  const editable = can('sales');

  // Lead search as you type.
  useEffect(() => {
    if (search.trim().length < 2) return setFound([]);
    const t = setTimeout(() => {
      void api
        .listLeads({ search: search.trim(), limit: 6, status: 'all' })
        .then((r) => setFound(r.items))
        .catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const save = async (extra: EventInput = {}) => {
    setBusy(true);
    setError(null);
    try {
      const { startLocal, endLocal, ...rest } = form;
      const body: EventInput = {
        ...rest,
        title: rest.title?.trim() || (rest.contactName ? `${TYPE_META[rest.type as EventType].label} — ${rest.contactName}` : ''),
        start: new Date(startLocal).toISOString(),
        end: new Date(endLocal).toISOString(),
        assignee: rest.assignee || null,
        ...extra,
      };
      if (!body.title) throw new Error('Give it a title, or pick who it is with.');
      if (event) await api.updateEvent(event.id, body);
      else await api.createEvent(body);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!event || !window.confirm('Delete this event? It is removed for everyone. (Cancel it instead to keep it on record.)')) return;
    setBusy(true);
    try {
      await api.deleteEvent(event.id);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete');
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <div className="event-modal">
        <div className="event-modal-head">
          <h2>{event ? 'Event' : 'New event'}</h2>
          {event && <StatusPill status={event.displayStatus} />}
        </div>
        {error && <ErrorBanner message={error} />}

        <div className="event-types" role="radiogroup" aria-label="Type">
          {(Object.keys(TYPE_META) as EventType[]).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={form.type === t} className={`chip${form.type === t ? ' active' : ''}`} style={{ ['--c' as string]: TYPE_META[t].color }} disabled={!editable} onClick={() => set({ type: t, mode: t === 'call' ? 'online' : form.mode })}>
              <i className="dot" /> {TYPE_META[t].label}
            </button>
          ))}
        </div>

        <label className="field">
          Title
          <input value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder={form.contactName ? `${TYPE_META[form.type as EventType].label} — ${form.contactName}` : 'e.g. Visit to IIT Madras chemistry lab'} disabled={!editable} />
        </label>

        <div className="event-row">
          <label className="field">
            Starts
            <input type="datetime-local" value={form.startLocal} disabled={!editable} onChange={(e) => {
              const len = new Date(form.endLocal).getTime() - new Date(form.startLocal).getTime();
              const start = new Date(e.target.value);
              set({ startLocal: e.target.value, endLocal: Number.isNaN(start.getTime()) ? form.endLocal : toLocalInput(new Date(start.getTime() + Math.max(15 * 60_000, len))) });
            }} />
          </label>
          <label className="field">
            Ends
            <input type="datetime-local" value={form.endLocal} min={form.startLocal} onChange={(e) => set({ endLocal: e.target.value })} disabled={!editable} />
          </label>
        </div>

        {form.type !== 'blocked' && (
          <>
            <div className="field">
              With
              {form.leadId || form.contactName ? (
                <div className="event-who">
                  <div>
                    <strong>{form.contactName || form.contactEmail}</strong>
                    <span className="muted small">{[form.institution, form.contactEmail].filter(Boolean).join(' · ')}</span>
                  </div>
                  {editable && (
                    <button className="btn btn-sm btn-ghost" onClick={() => set({ leadId: undefined, contactName: '', contactEmail: '', institution: '' })}>
                      Change
                    </button>
                  )}
                </div>
              ) : (
                <div className="event-lead-search">
                  <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search the CRM by name, email or institute…" disabled={!editable} />
                  {found.length > 0 && (
                    <div className="event-lead-results">
                      {found.map((l) => (
                        <button key={l.id} onClick={() => (set({ leadId: l.id, contactName: l.person.name, contactEmail: l.person.email ?? '', institution: l.institution?.name ?? '' }), setSearch(''), setFound([]))}>
                          <strong>{l.person.name}</strong>
                          <span className="muted small">{[l.institution?.name, l.person.email].filter(Boolean).join(' · ')}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {search.trim().length >= 2 && !found.length && (
                    <button className="btn btn-sm btn-ghost" onClick={() => (set({ contactName: search.trim() }), setSearch(''))}>
                      Use “{search.trim()}” (not in the CRM)
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="event-row">
              <label className="field">
                Where
                <select value={form.mode} onChange={(e) => set({ mode: e.target.value as 'in_person' | 'online' })} disabled={!editable}>
                  <option value="in_person">In person</option>
                  <option value="online">Online</option>
                </select>
              </label>
              {form.mode === 'online' ? (
                <label className="field" style={{ flex: 2 }}>
                  Meeting link
                  <input value={form.meetingLink} onChange={(e) => set({ meetingLink: e.target.value })} placeholder="https://meet.google.com/…" disabled={!editable} />
                </label>
              ) : (
                <label className="field" style={{ flex: 2 }}>
                  Address
                  <input value={form.address} onChange={(e) => set({ address: e.target.value })} placeholder="Department, building, campus, city" disabled={!editable} />
                </label>
              )}
            </div>
          </>
        )}

        <label className="field">
          Who goes
          <select value={form.assignee ?? ''} onChange={(e) => set({ assignee: e.target.value })} disabled={!editable}>
            <option value="">Nobody yet</option>
            {people.map((p) => (
              <option key={p.email} value={p.email}>
                {p.name}
              </option>
            ))}
          </select>
          <span className="muted small">They are emailed the details with a calendar file, and see it under My visits.</span>
        </label>

        <label className="field">
          Notes
          <textarea value={form.notes} onChange={(e) => set({ notes: e.target.value })} rows={3} placeholder="What to bring, who else will be there, what they asked about…" disabled={!editable} />
        </label>

        {event && (event.onTheWay || event.checkIn || event.checkOut) && (
          <div className="event-track">
            {([
              ['On the way', event.onTheWay],
              ['Checked in', event.checkIn],
              ['Checked out', event.checkOut],
            ] as const).map(([label, p]) =>
              p ? (
                <div key={label}>
                  <strong>{label}</strong> {fmtDayTime(p.at)}
                  {p.lat != null && p.lng != null && (
                    <>
                      {' · '}
                      <a href={mapLink(p.lat, p.lng)} target="_blank" rel="noreferrer">
                        map{p.accuracy ? ` (±${p.accuracy} m)` : ''}
                      </a>
                    </>
                  )}
                </div>
              ) : null,
            )}
            {event.outcome && <p className="small" style={{ margin: '6px 0 0' }}>Outcome: {event.outcome}</p>}
          </div>
        )}
        {event?.source === 'booking' && <p className="muted small">Booked by {event.booking?.name ?? 'the customer'} on the booking page{event.booking?.phone ? ` · ${event.booking.phone}` : ''}.</p>}

        <div className="modal-foot">
          <div className="row" style={{ gap: 8 }}>
            {event && can('admin') && (
              <button className="btn btn-danger" onClick={() => void remove()} disabled={busy}>
                Delete
              </button>
            )}
            {event && editable && event.status !== 'cancelled' && (
              <button className="btn btn-ghost" onClick={() => void save({ status: 'cancelled' })} disabled={busy}>
                Cancel event
              </button>
            )}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={onClose}>
              Close
            </button>
            {editable && (
              <button className="btn btn-primary" onClick={() => void save(event?.status === 'cancelled' ? { status: 'scheduled' } : {})} disabled={busy}>
                {busy ? 'Saving…' : event ? (event.status === 'cancelled' ? 'Restore' : 'Save') : 'Add to calendar'}
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
