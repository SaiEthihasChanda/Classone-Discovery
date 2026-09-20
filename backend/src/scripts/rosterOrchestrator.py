"""Runs the whole roster pipeline for a set of institutes, unattended.

Why a script and not a button: two of the steps wait on things outside our
control — the OpenAlex daily allowance resetting, and Vidwan answering — and
the right moment to run them may be hours away. This drives the existing
API (every step is still a visible job on the Faculty page), waits where it
has to, and writes a plain log.

    python backend/src/scripts/rosterOrchestrator.py \\
        --institutions I162827531 --reset-at 2026-09-21T00:26:00Z \\
        --wipe --log C:/path/to/orchestrator.log

Phases:
  A  now         wipe (optional) -> build (all sources) -> verify -> score
  B  when up     Vidwan pass (build with only that source) -> verify
  C  at reset    re-score -> instrument sweep -> promote (>= threshold plus
                 instrument owners, no per-lead scans) -> fill -> verify
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

API = "http://localhost:4000/api"


def log(msg: str) -> None:
    line = f"{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%SZ')}  {msg}"
    print(line, flush=True)
    if LOG:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")


def call(method: str, path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{API}{path}", data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read()
        return json.loads(raw) if raw else {}


def start_job(path: str, body: dict) -> str:
    """Starts a job; if one of that kind is already running, waits for it first."""
    while True:
        try:
            return call("POST", path, body)["job"]["id"]
        except urllib.error.HTTPError as exc:
            if exc.code == 409:
                log(f"  {path}: a job of that kind is running; waiting 60 s")
                time.sleep(60)
                continue
            raise


def wait_job(job_id: str, label: str) -> dict:
    last = ""
    while True:
        j = call("GET", f"/roster/jobs/{job_id}")
        stage = j.get("stage", "")
        if stage != last:
            log(f"  {label}: {stage} {json.dumps(j.get('counters'))}")
            last = stage
        if j["status"] != "running":
            for line in j.get("log", []):
                if line["level"] != "info":
                    log(f"  {label} [{line['level']}] {line['message'][:300]}")
            log(f"  {label} -> {j['status']} {json.dumps(j.get('result'))[:600]}")
            return j
        time.sleep(20)


def run(label: str, path: str, body: dict) -> dict:
    log(f"{label}: start")
    return wait_job(start_job(path, body), label)


def vidwan_up() -> bool:
    try:
        with socket.create_connection(("vidwan.inflibnet.ac.in", 443), timeout=8):
            return True
    except OSError:
        return False


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--institutions", nargs="+", required=True)
    p.add_argument("--reset-at", required=True, help="ISO time when the OpenAlex allowance resets, e.g. 2026-09-21T00:26:00Z")
    p.add_argument("--threshold", type=int, default=70)
    p.add_argument("--wipe", action="store_true", help="wipe roster and CRM first")
    p.add_argument("--log", default="")
    p.add_argument("--vidwan-deadline-hours", type=float, default=36)
    a = p.parse_args()
    global LOG
    LOG = a.log
    reset_at = datetime.fromisoformat(a.reset_at.replace("Z", "+00:00"))
    started = datetime.now(timezone.utc)

    log(f"orchestrator start; institutes={a.institutions} reset_at={reset_at.isoformat()} threshold={a.threshold}")

    # --- Phase A ----------------------------------------------------------------
    if a.wipe:
        log("wiping roster and CRM")
        log(f"  roster: {call('DELETE', '/roster', {'confirm': 'WIPE ROSTER'})}")
        log(f"  crm: {call('POST', '/admin/wipe-crm', {'confirm': 'WIPE'})}")
    vidwan_done = False
    if vidwan_up():
        run("A build (all sources)", "/roster/build", {"institutionIds": a.institutions, "sources": ["openalex", "orcid", "faculty_pages", "vidwan"], "includeInferredRoles": True})
        vidwan_done = True
    else:
        log("Vidwan unreachable; building without it and retrying it later")
        run("A build (openalex, orcid, pages)", "/roster/build", {"institutionIds": a.institutions, "sources": ["openalex", "orcid", "faculty_pages"], "includeInferredRoles": True})
    run("A verify", "/roster/verify", {"freshDays": 0})
    run("A score (cached where possible)", "/roster/score", {})

    # --- Phases B and C --------------------------------------------------------
    phase_c_done = False
    while True:
        now = datetime.now(timezone.utc)
        if not vidwan_done and vidwan_up():
            log("Vidwan is answering")
            run("B Vidwan pass", "/roster/build", {"institutionIds": a.institutions, "sources": ["vidwan"], "includeInferredRoles": True})
            run("B verify", "/roster/verify", {"freshDays": 0})
            if phase_c_done:
                run("B score new members", "/roster/score", {})
            vidwan_done = True
        if not phase_c_done and now >= reset_at:
            log("OpenAlex allowance should have reset")
            run("C re-score all", "/roster/score", {"rescore": True})
            run("C instrument sweep", "/roster/sweep", {"institutionIds": a.institutions})
            run("C promote", "/roster/promote", {"threshold": a.threshold, "identifyInstruments": False, "includeInstrumentOwners": True})
            run("C fill missing info", "/roster/fill", {"useScraper": True})
            run("C final verify", "/roster/verify", {"freshDays": 0})
            phase_c_done = True
        if phase_c_done and (vidwan_done or (now - started).total_seconds() > a.vidwan_deadline_hours * 3600):
            break
        time.sleep(1800 if not vidwan_done else 300)

    log(f"orchestrator done; vidwan_done={vidwan_done}")
    try:
        log(f"roster summary: {json.dumps(call('GET', '/roster/summary'))[:400]}")
        log(f"leads: {call('GET', '/leads?limit=1').get('total')}")
    except Exception as exc:  # noqa: BLE001
        log(f"summary failed: {exc}")
    return 0


LOG = ""
if __name__ == "__main__":
    sys.exit(main())
