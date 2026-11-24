#!/usr/bin/env bash
# Puts a new version of the code live: copies it in, reinstalls dependencies, rebuilds the
# frontend, restarts the services. The database and .env are left as they are.
#
#   sudo bash /opt/classone/app/deploy/update.sh --git            # pull from the git remote
#   sudo bash deploy/update.sh                                    # from a freshly unpacked copy
#
# Restarting the backend stops any pipeline stage that is running — check the Faculty page first.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run as root: sudo bash $0"; exit 1; }

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=/opt/classone/app
U=classone

if [[ "${1:-}" == "--git" ]]; then
  sudo -u $U -H git -C $APP pull --ff-only
elif [[ "$SRC" != "$APP" ]]; then
  rsync -a --delete \
    --exclude node_modules --exclude .venv --exclude .mongo-data --exclude 'frontend/dist' \
    --exclude logs --exclude exports --exclude Motion_as_kit --exclude '.env' --exclude '.env.*' \
    --exclude '__pycache__' \
    "$SRC/" "$APP/"
  chown -R $U:$U $APP
fi

sudo -u $U -H bash -c "cd $APP/backend && npm ci --no-audit --no-fund"
sudo -u $U -H bash -c "cd $APP/frontend && npm ci --no-audit --no-fund && VITE_API_BASE_URL=/api npm run build"
sudo -u $U -H bash -c "cd $APP/scraper-service && .venv/bin/pip install -q -r requirements.txt"

cp $APP/deploy/classone-backend.service $APP/deploy/classone-scraper.service /etc/systemd/system/
systemctl daemon-reload
systemctl restart classone-scraper classone-backend
sleep 5
curl -fsS http://127.0.0.1:4000/api/health && echo && echo "Updated."
