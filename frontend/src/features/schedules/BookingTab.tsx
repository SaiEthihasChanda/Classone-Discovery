/** Demo booking settings (admins): the hours offered, slot length, who runs demos, and the public link. */
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { ErrorBanner, Loading } from '../../components/common';
import { Segmented } from '../../components/ui';
import type { BookingSettings } from '../../types';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function BookingTab() {
  const [s, setS] = useState<BookingSettings | null>(null);
  const [slots, setSlots] = useState(0);
  const [people, setPeople] = useState<Array<{ email: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/book`;

  const load = () =>
    api
      .bookingSettings()
      .then((r) => (setS(r.settings), setSlots(r.slots)))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load booking settings'));
  useEffect(() => {
    void load();
    void api.schedulePeople().then((r) => setPeople(r.people)).catch(() => {});
  }, []);

  const save = async (patch: Partial<BookingSettings>) => {
    if (!s) return;
    setError(null);
    try {
      setS(await api.setBookingSettings(patch));
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    }
  };

  if (!s) return error ? <ErrorBanner message={error} /> : <Loading />;
  return (
    <div className="booking-tab">
      {error && <ErrorBanner message={error} />}
      <section className="card card-pad">
        <div className="booking-head">
          <div>
            <h3 className="section-title">Public booking page</h3>
            <p className="muted small" style={{ margin: 0 }}>
              Customers pick a free time; it lands on the calendar as a demo linked to their lead, they get a confirmation from the sales mailbox, and whoever runs demos is told.
            </p>
          </div>
          <Segmented label="Booking" items={[{ key: 'off', label: 'Closed' }, { key: 'on', label: 'Open' }]} value={s.enabled ? 'on' : 'off'} onChange={(v) => void save({ enabled: v === 'on' })} />
        </div>
        <div className="booking-link">
          <code>{link}</code>
          <button className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(link).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}>
            {copied ? 'Copied ✓' : 'Copy link'}
          </button>
          <a className="btn btn-sm btn-ghost" href="/book" target="_blank" rel="noreferrer">
            Preview
          </a>
        </div>
        <p className="muted small" style={{ margin: '6px 0 0' }}>
          {s.enabled ? `${slots} free slot${slots === 1 ? '' : 's'} offered right now.` : 'Closed: the page says booking is not open.'} People outside the team can only reach it once the app is deployed at its public address.
        </p>
      </section>

      <section className="card card-pad booking-form">
        <label className="field">
          Page title
          <input defaultValue={s.title} onBlur={(e) => e.target.value !== s.title && void save({ title: e.target.value })} />
        </label>
        <label className="field">
          Text on the page
          <textarea rows={2} defaultValue={s.intro} onBlur={(e) => e.target.value !== s.intro && void save({ intro: e.target.value })} />
        </label>
        <div className="field">
          Days offered
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {DAYS.map((d, i) => (
              <button key={d} className={`chip${s.days.includes(i) ? ' active' : ''}`} onClick={() => void save({ days: s.days.includes(i) ? s.days.filter((x) => x !== i) : [...s.days, i].sort() })}>
                {d}
              </button>
            ))}
          </div>
        </div>
        <div className="event-row">
          <label className="field">
            From (IST)
            <input type="time" defaultValue={s.startTime} onBlur={(e) => e.target.value !== s.startTime && void save({ startTime: e.target.value })} />
          </label>
          <label className="field">
            Until
            <input type="time" defaultValue={s.endTime} onBlur={(e) => e.target.value !== s.endTime && void save({ endTime: e.target.value })} />
          </label>
          <label className="field">
            Each demo
            <select value={s.durationMinutes} onChange={(e) => void save({ durationMinutes: Number(e.target.value) })}>
              {[15, 30, 45, 60, 90].map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="event-row">
          <label className="field">
            Gap around other events
            <select value={s.bufferMinutes} onChange={(e) => void save({ bufferMinutes: Number(e.target.value) })}>
              {[0, 10, 15, 30, 60].map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Notice needed
            <select value={s.noticeHours} onChange={(e) => void save({ noticeHours: Number(e.target.value) })}>
              {[2, 6, 12, 18, 24, 48].map((h) => (
                <option key={h} value={h}>
                  {h} hours
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Offer up to
            <select value={s.horizonDays} onChange={(e) => void save({ horizonDays: Number(e.target.value) })}>
              {[7, 14, 21, 30, 60].map((d) => (
                <option key={d} value={d}>
                  {d} days ahead
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="event-row">
          <label className="field">
            Demos are
            <select value={s.mode} onChange={(e) => void save({ mode: e.target.value as 'online' | 'in_person' })}>
              <option value="online">Online</option>
              <option value="in_person">In person</option>
            </select>
          </label>
          <label className="field" style={{ flex: 2 }}>
            Run by (their calendar decides what is free)
            <select value={s.assignee ?? ''} onChange={(e) => void save({ assignee: e.target.value })}>
              <option value="">Nobody set — the team is emailed</option>
              {people.map((p) => (
                <option key={p.email} value={p.email}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {saved && <p className="small" style={{ color: 'var(--success)', margin: 0 }}>Saved ✓</p>}
      </section>
    </div>
  );
}
