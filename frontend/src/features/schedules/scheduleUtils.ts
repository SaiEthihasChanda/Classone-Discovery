import type { EventType } from '../../types';

/** Event types: label and colour (the app's categorical palette, fixed order). */
export const TYPE_META: Record<EventType, { label: string; color: string }> = {
  visit: { label: 'Visit', color: '#2a78d6' },
  demo: { label: 'Demo', color: '#eb6834' },
  call: { label: 'Call', color: '#1baf7a' },
  meeting: { label: 'Meeting', color: '#eda100' },
  other: { label: 'Other', color: '#8b5cf6' },
  blocked: { label: 'Busy', color: '#9aa1ad' },
};

export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const sameDay = (a: Date, b: Date) => dayKey(a) === dayKey(b);
export const fmtTime = (d: string | Date) => new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
export const fmtDayTime = (d: string | Date) => new Date(d).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
export const mapLink = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`;
export const mapSearch = (address: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;

/** "yyyy-mm-ddThh:mm" in local time, for <input type="datetime-local">. */
export const toLocalInput = (d: Date) => `${dayKey(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** One GPS reading (or none, with the reason), for a field step. */
export function currentPosition(): Promise<{ lat?: number; lng?: number; accuracy?: number; problem?: string }> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve({ problem: 'This device cannot share its location.' });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      (e) => resolve({ problem: e.code === e.PERMISSION_DENIED ? 'Location permission was refused — recorded without a location.' : 'Could not get a location — recorded without one.' }),
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 },
    );
  });
}
