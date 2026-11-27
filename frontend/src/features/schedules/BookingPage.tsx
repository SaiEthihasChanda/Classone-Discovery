/**
 * The public demo-booking page (/book): no sign-in. Pick a day, pick a time, leave your details.
 * Times are shown in India time.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { PublicBooking } from '../../types';

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
const dayOf = (iso: string) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);

export function BookingPage() {
  const [data, setData] = useState<PublicBooking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', email: '', institution: '', phone: '', message: '', website: '' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ start: string } | null>(null);

  const load = () =>
    api
      .publicBooking()
      .then((d) => {
        setData(d);
        const first = d.slots[0];
        setDay((cur) => cur ?? (first ? dayOf(first.start) : null));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the booking page'));
  useEffect(() => {
    document.title = 'Book a demo — Class One Systems';
    void load();
  }, []);

  const days = useMemo(() => {
    const m = new Map<string, PublicBooking['slots']>();
    for (const s of data?.slots ?? []) m.set(dayOf(s.start), [...(m.get(dayOf(s.start)) ?? []), s]);
    return [...m.entries()];
  }, [data]);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!slot) return;
    setBusy(true);
    setError(null);
    try {
      await api.book({ start: slot, ...form });
      setDone({ start: slot });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not book that time');
      setSlot(null);
      void load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="book-page">
      <div className="book-card">
        <img className="book-logo" src="/classone-logo.png" alt="Class One Systems" />
        {!data ? (
          error ? <p className="book-error">{error}</p> : <div className="skeleton"><i className="sk sk-line" /><i className="sk sk-line" style={{ width: '70%' }} /></div>
        ) : done ? (
          <div className="book-done">
            <div className="book-tick" aria-hidden>
              ✓
            </div>
            <h1>You're booked</h1>
            <p>
              {dayLabel(done.start)} at {timeLabel(done.start)} (India time). A confirmation is on its way to <strong>{form.email}</strong>
              {data.mode === 'online' ? ', and we will send the meeting link before the demo.' : '.'}
            </p>
          </div>
        ) : !data.open ? (
          <>
            <h1>{data.title}</h1>
            <p className="muted">Online booking is not open right now. Please email us and we will find a time.</p>
          </>
        ) : (
          <>
            <h1>{data.title}</h1>
            <p className="muted">{data.intro}</p>
            <p className="muted small">
              {data.durationMinutes} minutes · {data.mode === 'online' ? 'online' : 'in person'} · times in India time (IST)
            </p>
            {error && <p className="book-error">{error}</p>}
            {!days.length ? (
              <p>No free times in the coming weeks — please email us.</p>
            ) : (
              <>
                <div className="book-days" role="tablist" aria-label="Day">
                  {days.map(([d, list]) => (
                    <button key={d} role="tab" aria-selected={day === d} className={day === d ? 'active' : ''} onClick={() => (setDay(d), setSlot(null))}>
                      <span>{dayLabel(list[0]!.start)}</span>
                      <small>{list.length} free</small>
                    </button>
                  ))}
                </div>
                <div className="book-slots" role="radiogroup" aria-label="Time">
                  {(days.find(([d]) => d === day)?.[1] ?? []).map((s) => (
                    <button key={s.start} role="radio" aria-checked={slot === s.start} className={slot === s.start ? 'active' : ''} onClick={() => setSlot(s.start)}>
                      {timeLabel(s.start)}
                    </button>
                  ))}
                </div>
              </>
            )}
            {slot && (
              <form className="book-form" onSubmit={(e) => void submit(e)}>
                <h2>
                  {dayLabel(slot)} at {timeLabel(slot)}
                </h2>
                <input required placeholder="Your name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" />
                <input required type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" />
                <input placeholder="Institute or company" value={form.institution} onChange={(e) => setForm({ ...form, institution: e.target.value })} autoComplete="organization" />
                <input placeholder="Phone (optional)" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} autoComplete="tel" />
                <textarea rows={3} placeholder="What would you like to see? (optional)" value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
                {/* Hidden from people; bots fill it in. */}
                <input className="book-hp" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
                <button className="btn btn-primary" disabled={busy}>
                  {busy ? 'Booking…' : 'Confirm booking'}
                </button>
              </form>
            )}
          </>
        )}
      </div>
      <p className="book-foot">Class One Systems · classonesystems.in</p>
    </div>
  );
}
