// Keeps the Python scraper service up for as long as `npm run dev` runs.
//
// - If something already answers on the scraper port (a Task Scheduler instance, a manual uvicorn),
//   it is reused rather than fought over the port.
// - Otherwise uvicorn is started from scraper-service/.venv and restarted if it exits.
// - Every 15 s the service's health is checked; if it has gone away (crash, the reused instance was
//   closed), a fresh one is started.
// - A missing .venv is a setup error, reported once with the fix, and fails the run loudly.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'scraper-service');
const PY = process.platform === 'win32' ? path.join(DIR, '.venv', 'Scripts', 'python.exe') : path.join(DIR, '.venv', 'bin', 'python');
const HOST = '127.0.0.1';
const PORT = Number(process.env.SCRAPER_PORT ?? 8000);
const HEALTH = `http://${HOST}:${PORT}/health`;

const log = (m) => console.log(`[scraper] ${m}`);

async function healthy() {
  try {
    const r = await fetch(HEALTH, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

if (!existsSync(PY)) {
  console.error(`[scraper] ${PY} not found: the scraper's Python environment is not set up.`);
  console.error('[scraper] Fix:  cd scraper-service && python -m venv .venv && .venv\\Scripts\\python.exe -m pip install -r requirements.txt');
  process.exit(1);
}

let child = null;
let starting = false;
let backoff = 2000;
let stopping = false;

function start() {
  if (child || starting || stopping) return;
  starting = true;
  log(`starting uvicorn on ${HOST}:${PORT}`);
  child = spawn(PY, ['-m', 'uvicorn', 'app.main:app', '--host', HOST, '--port', String(PORT)], { cwd: DIR, stdio: 'inherit', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const t0 = Date.now();
  child.on('exit', (code) => {
    child = null;
    starting = false;
    if (stopping) return;
    // a run that lasted a while resets the backoff; a crash loop backs off up to 30 s
    backoff = Date.now() - t0 > 60_000 ? 2000 : Math.min(backoff * 2, 30_000);
    log(`exited (code ${code}); checking again in ${Math.round(backoff / 1000)} s`);
    setTimeout(ensure, backoff);
  });
  // consider it started once health answers (or give the next check a chance)
  const wait = setInterval(async () => {
    if (!child) { clearInterval(wait); return; }
    if (await healthy()) { clearInterval(wait); starting = false; log(`up at ${HEALTH}`); }
  }, 1000);
}

let reusing = false;
async function ensure() {
  if (stopping || child || starting) return;
  if (await healthy()) {
    if (!reusing) log(`already running at ${HEALTH}; reusing it`);
    reusing = true;
    return;
  }
  if (reusing) log('the instance being reused has stopped');
  reusing = false;
  start();
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill();
    process.exit(0);
  });
}

await ensure();
setInterval(ensure, 15_000);
