# Deploying Classone-Discovery to the cloud

Everything runs on **one Linux server**: MongoDB, the Node API, the Python scraper (with its
Chromium), and Caddy, which serves the website over HTTPS. Nothing runs on anyone's PC. Pipelines
are started from the Faculty page and keep running on the server after the browser is closed.

```
 users' browsers ──HTTPS──▶ Caddy :443 ─┬─ /        → frontend/dist (static files)
                                        └─ /api/*   → Node API 127.0.0.1:4000 ─┬─ MongoDB 127.0.0.1:27017
                                                                               └─ scraper 127.0.0.1:8000 ──▶ faculty pages, Vidwan
                                                                    (outbound) ──▶ OpenAlex, ORCID, Jev/OpenAI
```

Only ports 22, 80 and 443 are open. The database, API and scraper can't be reached from outside.

## Choosing the server

| Option | Monthly | Notes |
|---|---|---|
| **DigitalOcean, Bangalore, 2 GB / 1 vCPU / 50 GB** | **$12** | Recommended starting point. You can resize to 4 GB in place ($24) if pipeline runs get tight. Backups cost +20% ($2.40). |
| AWS Lightsail, Mumbai, 2 GB | $12 | Same size and price. Snapshots are about $0.05/GB-month. Resizing means restoring a snapshot onto a bigger plan. |
| Vultr / Linode (Akamai), Mumbai, 2–4 GB | $12–24 | Equivalent alternatives. |
| Oracle Cloud Always Free (Mumbai/Hyderabad, Arm) | $0 | Free, but Arm capacity is often unavailable. Free-tier VMs that sit idle for a week get reclaimed unless the account is upgraded to pay-as-you-go (the free resources stay free after the upgrade). Only worth it if the trial below passes there. |
| Domain name (optional) | about ₹800/year | Not needed: by default the site is served at `<ip>.sslip.io` with a real HTTPS certificate. |

**Expected total: about $12–15 a month.** RAM drives the size. Chromium is the hungry part, so
2 GB plus the 2 GB swap the setup adds is enough for the one-at-a-time manual runs this tool does.

**Before you commit, run the IP trial.** Faculty pages and Vidwan block by IP reputation, so a
datacenter IP can get 403s that a home connection doesn't. Scraping instead of calling an API
doesn't change that. All three providers bill by the hour, so a trial costs a few cents:

1. Create the smallest Ubuntu 24.04 VM in the India region.
2. `curl -fsSLO https://raw.githubusercontent.com/<repo>/main/deploy/probe-ip.sh`, or upload `deploy/probe-ip.sh` with `scp`.
3. Run `bash probe-ip.sh`. It sends one GET per site, 2 s apart, with the scraper's identified User-Agent.
4. Repeat on a second provider, keep the one with the fewest `BLOCKED` results, and delete the others.

ORCID and OpenAlex aren't IP-sensitive. Anything blocked from the server can still come in from
those two sources; the pipeline already treats faculty pages and Vidwan as optional.

## First-time setup (about 15 minutes)

On your PC, in the repo:

```powershell
powershell -File deploy\pack.ps1                          # classone-app.tar.gz, the code without secrets/data
npm --prefix backend run db:export -- ..\classone-db.ndjson.gz   # all current data (about 4 MB)
scp classone-app.tar.gz classone-db.ndjson.gz root@<server-ip>:~
```

(If the code is pushed to GitHub, you can use `git clone` on the server instead of the archive.)

On the server (`ssh root@<server-ip>`, or `ubuntu@…` with `sudo`):

```bash
mkdir -p ~/classone && tar -xzf classone-app.tar.gz -C ~/classone
sudo bash ~/classone/deploy/setup.sh
#   optional: sudo SITE_ADDRESS=crm.yourdomain.com BASIC_AUTH_USER=classone BASIC_AUTH_PASSWORD='…' bash …
sudo nano /opt/classone/app/.env           # paste JEV_API_KEY / OPENAI_API_KEY / OPENALEX_API_KEY from your local .env
sudo systemctl restart classone-backend
cd /opt/classone/app/backend && sudo npm run db:import -- ~/classone-db.ndjson.gz
```

`db:import` refuses to write into a database that already has data. Add `--replace` to overwrite it.

The setup script prints the site address at the end. The 2 GB of swap, firewall, Node 22,
MongoDB 8, Python and Chromium, systemd services, Caddy with HTTPS and the nightly backup are all
done by that one script. It's safe to run again.

**Shared login.** Until real access management exists, `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD`
put one shared username and password in front of the whole site. Without them the site is open to
anyone who has the address.

## Day to day

| Task | Command (on the server) |
|---|---|
| Is everything up? | `systemctl status classone-backend classone-scraper mongod caddy` |
| Live logs | `journalctl -u classone-backend -f` / `journalctl -u classone-scraper -f` |
| Put a new version live | Upload a fresh `classone-app.tar.gz`, unpack it to `~/classone`, then `sudo bash ~/classone/deploy/update.sh`. With git: `sudo bash /opt/classone/app/deploy/update.sh --git`. |
| Backups | Nightly at 02:30 to `/var/backups/classone`, 14 kept. Run one now: `sudo classone-backup` |
| Restore a backup | `mongorestore --gzip --archive=/var/backups/classone/classone-YYYY-MM-DD.archive.gz --drop` |
| Off-server copy | Turn on the provider's weekly backups/snapshots, or `scp` an archive down now and then. The nightly backups are on the same disk. |
| Unattended orchestrator | `sudo systemd-run --unit=classone-orch --uid=classone python3 /opt/classone/app/backend/src/scripts/rosterOrchestrator.py …` (it keeps running after you log out; `journalctl -u classone-orch`) |

An update restarts the backend, which stops a running pipeline stage. Check the Faculty page first.

## Files in this folder

| File | What it is |
|---|---|
| `ORACLE.md` | Step by step for Oracle Cloud's free tier |
| `setup.sh` | One-shot server setup (Ubuntu 24.04, x86 or Arm, Oracle's image included) |
| `update.sh` | Deploy a new version: copy, reinstall, rebuild, restart |
| `probe-ip.sh` | IP trial: can this server reach faculty pages and Vidwan? |
| `pack.ps1` | Windows: pack the working copy for upload |
| `backup.sh` | Nightly `mongodump`, installed as `classone-backup` |
| `classone-backend.service`, `classone-scraper.service` | systemd units |
| `Caddyfile.template` | Website + `/api` proxy + HTTPS |
| `mongod.conf` | MongoDB bound to localhost, cache capped at 0.4 GB |
| `env.production.example` | The server's `.env`, minus the keys |

The database move uses `backend/src/scripts/dbExport.ts` / `dbImport.ts`
(`npm run db:export` / `db:import`). They need no MongoDB tools on Windows, and they keep ids,
dates and indexes exactly as they were.
