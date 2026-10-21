#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run this script with sudo on the API host.' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
id jenkins >/dev/null
id chris_dev >/dev/null
for executable in /usr/bin/systemctl /usr/bin/flock /usr/bin/curl /usr/sbin/visudo; do
  [[ -x $executable ]] || { echo "Missing $executable" >&2; exit 1; }
done
sudo -u chris_dev env PATH=/home/chris_dev/.local/share/pnpm:/home/chris_dev/.local/share/pnpm/bin:/usr/local/bin:/usr/bin:/bin \
  bash -ec 'command -v pnpm; command -v node; command -v git; command -v python3; test -x /home/chris_dev/projects/HockeyStatsAPI/venv/bin/python'

install -o root -g root -m 0755 "$source_dir/bin/deploy-main.sh" /usr/local/bin/deploy-hockeystatsapi
rules=$(mktemp)
trap 'rm -f "$rules"' EXIT
cat >"$rules" <<'SUDOERS'
jenkins ALL=(chris_dev) NOPASSWD: /usr/local/bin/deploy-hockeystatsapi *
chris_dev ALL=(root) NOPASSWD: /usr/bin/systemctl stop hockeystatsapi.service, /usr/bin/systemctl start hockeystatsapi.service
SUDOERS
/usr/sbin/visudo -cf "$rules"
install -o root -g root -m 0440 "$rules" /etc/sudoers.d/hockeystatsapi-jenkins
echo 'Deployment helper installed. Configure the Jenkins job as described in docs/jenkins.md.'
