/**
 * Schedules: the team calendar, field visits and demo booking.
 *   Calendar   — month view; click a day to add, an event to edit. Filter by person.
 *   Field      — who is where today, from each executive's On my way / Check in / Check out.
 *   My visits  — the signed-in person's own appointments, with the phone-friendly check-in buttons.
 *   Booking    — the public demo-booking page: hours, length, who runs it, and its link.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { ErrorBanner, Loading } from '../../components/common';
import { Tabs } from '../../components/ui';
import type { ScheduleEvent } from '../../types';
import { BookingTab } from './BookingTab';
import { EventModal } from './EventModal';
import { FieldBoard } from './FieldBoard';
import { MyVisits } from './MyVisits';
import { TYPE_META, dayKey, fmtTime, sameDay } from './scheduleUtils';

type View = 'calendar' | 'field' | 'mine' | 'booking';

export function SchedulesPage() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const view = (params.get('view') as View | null) ?? 'calendar';
  const setView = (v: View) => setParams(v === 'calendar' ? {} : { view: v }, { replace: true });
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Schedules</h1>
          <p>Visits, demos and meetings — who is going where, and who is there now.</p>
        </div>
      </div>
      <Tabs<View>
        items={[
          { key: 'calendar', label: 'Calendar' },
          { key: 'field', label: 'Field today' },
          { key: 'mine', label: 'My visits' },
          ...(can('admin') ? [{ key: 'booking' as const, label: 'Demo booking' }] : []),
        ]}
        value={view}
        onChange={setView}
      />
      {view === 'calendar' && <CalendarView />}
      {view === 'field' && <FieldBoard />}
      {view === 'mine' && <MyVisits />}
      {view === 'booking' && <BookingTab />}
    </>
  );
}

// --- Calendar -------------------------------------------------------------------------------------------

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const lead = (first.getDay() + 6) % 7; // Monday first
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead);
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

function CalendarView() {
  const { can } = useAuth();
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [selected, setSelected] = useState(() => new Date());
  const [person, setPerson] = useState('');
  const [people, setPeople] = useState<Array<{ email: string; name: string }>>([]);
  const [events, setEvents] = useState<ScheduleEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ event?: ScheduleEvent; day?: Date } | null>(null);
  const days = useMemo(() => monthGrid(month), [month]);

  const load = useCallback(() => {
    setError(null);
    api
      .scheduleEvents({ from: days[0]!.toISOString(), to: new Date(days[41]!.getTime() + 86_400_000).toISOString(), assignee: person || undefined })
      .then((r) => setEvents(r.events))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the calendar'));
  }, [days, person]);
  useEffect(load, [load]);
  useEffect(() => {
    void api.schedulePeople().then((r) => setPeople(r.people)).catch(() => {});
  }, []);

  const byDay = useMemo(() => {
    const m = new Map<string, ScheduleEvent[]>();
    for (const e of events ?? []) {
      // Multi-day events show on each day they cover.
      for (let d = new Date(e.start); d < new Date(e.end); d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
        m.set(dayKey(d), [...(m.get(dayKey(d)) ?? []), e]);
      }
    }
    return m;
  }, [events]);
  const today = new Date();
  const dayEvents = byDay.get(dayKey(selected)) ?? [];

  return (
    <div className="sched">
      <div className="sched-toolbar">
        <div className="row" style={{ gap: 6 }}>
          <button className="btn btn-sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month">
            ‹
          </button>
          <button className="btn btn-sm" onClick={() => (setMonth(new Date(today.getFullYear(), today.getMonth(), 1)), setSelected(today))}>
            Today
          </button>
          <button className="btn btn-sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month">
            ›
          </button>
          <h2 className="sched-month">{month.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</h2>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <select value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Whose calendar" style={{ width: 'auto' }}>
            <option value="">Everyone</option>
            {people.map((p) => (
              <option key={p.email} value={p.email}>
                {p.name}
              </option>
            ))}
          </select>
          {can('sales') && (
            <button className="btn btn-primary btn-sm" onClick={() => setEditing({ day: selected })}>
              + Add
            </button>
          )}
        </div>
      </div>
      <div className="sched-legend">
        {Object.entries(TYPE_META).map(([k, m]) => (
          <span key={k}>
            <i style={{ background: m.color }} /> {m.label}
          </span>
        ))}
      </div>
      {error && <ErrorBanner message={error} />}

      <div className="sched-body">
        <div className="card sched-grid" role="grid" aria-label="Month">
          {WEEKDAYS.map((w) => (
            <div key={w} className="sched-wd">
              {w}
            </div>
          ))}
          {days.map((d) => {
            const list = byDay.get(dayKey(d)) ?? [];
            const out = d.getMonth() !== month.getMonth();
            return (
              <button
                key={dayKey(d)}
                className={`sched-day${out ? ' out' : ''}${sameDay(d, today) ? ' today' : ''}${sameDay(d, selected) ? ' selected' : ''}`}
                onClick={() => setSelected(d)}
                onDoubleClick={() => can('sales') && setEditing({ day: d })}
              >
                <span className="sched-num">{d.getDate()}</span>
                <span className="sched-chips">
                  {list.slice(0, 3).map((e) => (
                    <span key={e.id} className={`sched-chip${e.displayStatus === 'cancelled' ? ' cancelled' : ''}`} style={{ ['--c' as string]: TYPE_META[e.type].color }}>
                      {!e.allDay && <b>{fmtTime(e.start)}</b>} {e.title}
                    </span>
                  ))}
                  {list.length > 3 && <span className="sched-more">+{list.length - 3} more</span>}
                </span>
              </button>
            );
          })}
        </div>

        <aside className="card card-pad sched-agenda">
          <div className="sched-agenda-head">
            <h3>{selected.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
            {can('sales') && (
              <button className="btn btn-sm btn-ghost" onClick={() => setEditing({ day: selected })}>
                + Add
              </button>
            )}
          </div>
          {!events ? (
            <Loading />
          ) : !dayEvents.length ? (
            <p className="muted small">Nothing on this day.</p>
          ) : (
            <div className="sched-agenda-list">
              {dayEvents.map((e) => (
                <button key={e.id} className="sched-item" onClick={() => setEditing({ event: e })} style={{ ['--c' as string]: TYPE_META[e.type].color }}>
                  <span className="sched-item-time">{e.allDay ? 'All day' : `${fmtTime(e.start)}–${fmtTime(e.end)}`}</span>
                  <span className="sched-item-title">{e.title}</span>
                  <span className="muted small">
                    {[e.contactName && `${e.contactName}${e.institution ? `, ${e.institution}` : ''}`, e.assigneeName && `→ ${e.assigneeName}`].filter(Boolean).join(' · ')}
                  </span>
                  <StatusPill status={e.displayStatus} />
                </button>
              ))}
            </div>
          )}
        </aside>
      </div>

      {editing && (
        <EventModal
          event={editing.event}
          day={editing.day}
          people={people}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

export function StatusPill({ status }: { status: ScheduleEvent['displayStatus'] }) {
  const label: Record<ScheduleEvent['displayStatus'], string> = {
    scheduled: 'Scheduled',
    on_the_way: 'On the way',
    checked_in: 'There now',
    done: 'Done',
    cancelled: 'Cancelled',
    missed: 'Missed',
  };
  return <span className={`vstatus ${status}`}>{label[status]}</span>;
}
