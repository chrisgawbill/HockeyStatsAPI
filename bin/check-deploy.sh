#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
bash -n bin/deploy-main.sh bin/setup-jenkins-deploy.sh
# Invalid inputs must fail before fetching, stopping, or changing the service.
for revision in '' main '--help' '$(touch /tmp/invalid-deploy)' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-extra; do
  if bash bin/deploy-main.sh "$revision" >/dev/null 2>&1; then
    echo "Invalid revision accepted: $revision" >&2
    exit 1
  else
    result=$?
    [[ $result == 2 ]] || { echo "Unexpected validation exit: $result" >&2; exit 1; }
  fi
done
echo 'Deployment script syntax and input validation passed.'
