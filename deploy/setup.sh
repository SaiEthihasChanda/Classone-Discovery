#!/usr/bin/env bash
# One-shot server setup for Classone-Discovery on a fresh Ubuntu 24.04 VM (2–4 GB RAM).
#
# Installs everything on the one machine — MongoDB, the Node API, the Python scraper with its
# Chromium, and Caddy serving the built frontend over HTTPS — and runs them as systemd services
# that start on boot and restart on crash. Safe to re-run: every step checks before it acts.
#
#   sudo bash deploy/setup.sh                       # from an unpacked copy of the repo
#   sudo SITE_ADDRESS=crm.example.com bash deploy/setup.sh
#   sudo BASIC_AUTH_USER=classone BASIC_AUTH_PASSWORD='…' bash deploy/setup.sh
#
# SITE_ADDRESS  domain the site is served on. Default: <public-ip>.sslip.io, a free hostname that
#               resolves to this machine's IP, so HTTPS works without buying a domain.
# BASIC_AUTH_*  optional single shared login in front of the whole site (stopgap until real
#               access management). Leave unset for none.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run as root: sudo bash $0"; exit 1; }

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER=classone
BASE=/opt/classone
APP=$BASE/app
export PLAYWRIGHT_BROWSERS_PATH=$BASE/ms-playwright
export DEBIAN_FRONTEND=noninteractive

step() { echo; echo "==> $*"; }

RAM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)

step "Swap (2 GB) so Chromium + MongoDB + Node fit on a small VM (skipped at 4 GB RAM or more)"
if (( RAM_MB < 3800 )) && ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

step "Base packages and firewall (only SSH, HTTP, HTTPS reachable from outside)"
apt-get update -y
apt-get install -y curl gnupg ca-certificates git rsync python3 python3-venv python3-pip debian-keyring debian-archive-keyring apt-transport-https
if [[ -f /etc/iptables/rules.v4 ]] && grep -q REJECT /etc/iptables/rules.v4; then
  # Oracle Cloud's Ubuntu image ships its own iptables rules (SSH only, everything else rejected)
  # and ufw fights them, so open 80/443 in those rules instead, just ahead of the final REJECT.
  for port in 80 443; do
    if ! iptables -C INPUT -p tcp -m state --state NEW --dport $port -j ACCEPT 2>/dev/null; then
      pos=$(iptables -L INPUT --line-numbers | awk '$2=="REJECT" {print $1; exit}')
      iptables -I INPUT "${pos:-1}" -p tcp -m state --state NEW --dport $port -j ACCEPT
    fi
  done
  netfilter-persistent save >/dev/null
else
  apt-get install -y ufw
  ufw allow OpenSSH >/dev/null && ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi

step "Node.js 22"
if ! node --version 2>/dev/null | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

step "MongoDB 8.0 (local only, small cache)"
if ! command -v mongod >/dev/null; then
  curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-server-8.0.gpg
  echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
    > /etc/apt/sources.list.d/mongodb-org-8.0.list
  apt-get update -y
  apt-get install -y mongodb-org
fi
cp "$SRC/deploy/mongod.conf" /etc/mongod.conf
# Bigger cache on a bigger machine (e.g. Oracle's free 12 GB Arm VM).
(( RAM_MB >= 7500 )) && sed -i 's/cacheSizeGB: .*/cacheSizeGB: 2/' /etc/mongod.conf
systemctl enable --now mongod
systemctl restart mongod

step "Caddy (web server, automatic HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

step "App user and code in $APP"
id $APP_USER >/dev/null 2>&1 || useradd --system --create-home --home-dir $BASE --shell /usr/sbin/nologin $APP_USER
mkdir -p $APP $BASE/logs /var/backups/classone
if [[ "$SRC" != "$APP" ]]; then
  # Copy the code, never the local-only folders.
  rsync -a --delete \
    --exclude node_modules --exclude .venv --exclude .mongo-data --exclude 'frontend/dist' \
    --exclude logs --exclude exports --exclude Motion_as_kit --exclude '.env' --exclude '.env.*' \
    --exclude '__pycache__' \
    "$SRC/" "$APP/"
fi
if [[ ! -f $APP/.env ]]; then
  cp $APP/deploy/env.production.example $APP/.env
  echo "    Created $APP/.env from the template — fill in the API keys (see DEPLOYMENT.md)."
fi
chmod 600 $APP/.env
chown -R $APP_USER:$APP_USER $BASE

step "Backend and frontend dependencies, frontend build"
sudo -u $APP_USER -H bash -c "cd $APP/backend && npm ci --no-audit --no-fund"
sudo -u $APP_USER -H bash -c "cd $APP/frontend && npm ci --no-audit --no-fund && VITE_API_BASE_URL=/api npm run build"

step "Scraper: Python environment and Chromium"
sudo -u $APP_USER -H bash -c "cd $APP/scraper-service && python3 -m venv .venv && .venv/bin/pip install -q --upgrade pip && .venv/bin/pip install -q -r requirements.txt"
$APP/scraper-service/.venv/bin/python -m playwright install-deps chromium
sudo -u $APP_USER -H env PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH \
  $APP/scraper-service/.venv/bin/python -m playwright install chromium

step "Services"
cp $APP/deploy/classone-backend.service $APP/deploy/classone-scraper.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable classone-scraper classone-backend
systemctl restart classone-scraper classone-backend

step "Website (Caddy)"
if [[ -z "${SITE_ADDRESS:-}" ]]; then
  IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
  SITE_ADDRESS="${IP//./-}.sslip.io"
fi
AUTH_BLOCK=""
if [[ -n "${BASIC_AUTH_USER:-}" && -n "${BASIC_AUTH_PASSWORD:-}" ]]; then
  HASH=$(caddy hash-password --plaintext "$BASIC_AUTH_PASSWORD")
  # Links that people outside the team open (campaign tracking, "Review & send", demo booking) skip the password.
  AUTH_BLOCK="@private not path /api/public/* /act/* /book/*
	basic_auth @private {
		$BASIC_AUTH_USER $HASH
	}"
fi
python3 - "$APP/deploy/Caddyfile.template" "$SITE_ADDRESS" "$AUTH_BLOCK" > /etc/caddy/Caddyfile <<'PY'
import sys
template, site, auth = sys.argv[1], sys.argv[2], sys.argv[3]
print(open(template).read().replace("{{SITE_ADDRESS}}", site).replace("{{AUTH_BLOCK}}", auth))
PY
# The app's CORS list and the site address agree.
sed -i "s#^CORS_ORIGINS=.*#CORS_ORIGINS=https://$SITE_ADDRESS#" $APP/.env
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
usermod -aG $APP_USER caddy
chmod 750 $BASE $APP $APP/frontend
systemctl reload caddy || systemctl restart caddy
systemctl restart classone-backend

step "Nightly database backup (02:30, keeps 14 days)"
install -m 755 $APP/deploy/backup.sh /usr/local/bin/classone-backup
echo "30 2 * * * root /usr/local/bin/classone-backup >> $BASE/logs/backup.log 2>&1" > /etc/cron.d/classone-backup

step "Health"
sleep 5
curl -fsS http://127.0.0.1:4000/api/health && echo
curl -fsS http://127.0.0.1:8000/health && echo
echo
echo "Done. Open https://$SITE_ADDRESS"
echo "Logs:  journalctl -u classone-backend -f   |   journalctl -u classone-scraper -f"
