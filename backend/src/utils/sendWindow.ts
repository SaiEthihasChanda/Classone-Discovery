/**
 * When automatic emails may go out: Monday–Saturday, 09:00–18:00 India time —
 * so automatic follow-ups and product launches arrive like a person sent them.
 */
const IST = 330 * 60_000;
const OPEN_MIN = 9 * 60;
const CLOSE_MIN = 18 * 60;

export function inSendWindow(at = new Date()): boolean {
  const ist = new Date(at.getTime() + IST);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return ist.getUTCDay() !== 0 && minutes >= OPEN_MIN && minutes < CLOSE_MIN;
}

/** `at` itself when inside the window, else the next opening (09:00 IST, skipping Sunday). */
export function nextSendWindow(at = new Date()): Date {
  if (inSendWindow(at)) return at;
  const ist = new Date(at.getTime() + IST);
  let day = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 9, 0));
  if (ist.getUTCHours() * 60 + ist.getUTCMinutes() >= OPEN_MIN) day = new Date(day.getTime() + 86_400_000);
  while (day.getUTCDay() === 0) day = new Date(day.getTime() + 86_400_000);
  return new Date(day.getTime() - IST);
}
