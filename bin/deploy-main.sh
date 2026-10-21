#!/usr/bin/env bash
set -euo pipefail

# Installed root-owned; runs as chris_dev, never as root.
revision=${1:-}
if [[ $# != 1 || ! $revision =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Usage: deploy-hockeystatsapi <40-character commit SHA>' >&2
  exit 2
fi
export PATH=/home/chris_dev/.local/share/pnpm:/home/chris_dev/.local/share/pnpm/bin:/usr/local/bin:/usr/bin:/bin
export GIT_TERMINAL_PROMPT=0
cd /home/chris_dev/projects/HockeyStatsAPI
exec 9>.git/jenkins-deploy.lock
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }

[[ $(git branch --show-current) == main ]] || { echo 'Live checkout must be on main.' >&2; exit 1; }
[[ -z $(git status --porcelain) ]] || { echo 'Live checkout has local changes; refusing to overwrite them.' >&2; exit 1; }
git fetch origin main
if [[ $(git rev-parse FETCH_HEAD) != "$revision" ]]; then
  echo 'Skipping superseded build: this commit is no longer the tip of main.'
  exit 0
fi
git merge-base --is-ancestor HEAD "$revision"

staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
git archive "$revision" | tar -x -C "$staging"
(
  cd "$staging"
  # No production .env or database credentials are copied into the test checkout.
  pnpm install --frozen-lockfile
  bash bin/check-deploy.sh
  pnpm test
  python3 -m venv venv
  venv/bin/python -m pip install -r requirements.txt
)

# Recheck after testing so a newer push doesn't deploy an obsolete build.
git fetch origin main
if [[ $(git rev-parse FETCH_HEAD) != "$revision" ]]; then
  echo 'Skipping superseded build after tests.'
  exit 0
fi
[[ -z $(git status --porcelain) ]] || { echo 'Live checkout changed during tests.' >&2; exit 1; }

# Stop before modifying files or dependencies used by the running process.
sudo -n /usr/bin/systemctl stop hockeystatsapi.service
trap 'rm -rf "$staging"; sudo -n /usr/bin/systemctl start hockeystatsapi.service' EXIT
git merge --ff-only "$revision"
pnpm install --frozen-lockfile
venv/bin/python -m pip install -r requirements.txt
sudo -n /usr/bin/systemctl start hockeystatsapi.service

# /health requires a secret; use the public local config route for readiness.
PORT=$(node -e 'require("dotenv").config({ quiet: true }); process.stdout.write(process.env.PORT || "9000")')
for attempt in {1..30}; do
  if /usr/bin/systemctl is-active --quiet hockeystatsapi.service &&
     curl --noproxy '*' --fail --silent --max-time 2 "http://127.0.0.1:${PORT}/api/push/config" >/dev/null; then
    echo "Deployed $revision successfully."
    exit 0
  fi
  sleep 2
done
echo 'API failed its readiness check. Inspect journalctl -u hockeystatsapi.service.' >&2
exit 1
