#!/usr/bin/env bash
# Deploy the static site and the /zoko stream gateway to the production VPS.
set -euo pipefail
cd "$(dirname "$0")/.."

# Settings come from the environment or from deploy/.env (git-ignored). See deploy/.env.example.
[ -f deploy/.env ] && . deploy/.env
HOST=${YORU_HOST:?Set YORU_HOST (e.g. ubuntu@203.0.113.10) in the environment or deploy/.env}
SITE_URL=${YORU_SITE_URL:-}
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)
if [ -n "${YORU_SSH_KEY:-}" ]; then
  # Windows mounts often expose the key as 0444, which OpenSSH refuses. Work from a private copy.
  KEY=$(mktemp)
  cp "$YORU_SSH_KEY" "$KEY"
  chmod 600 "$KEY"
  trap 'rm -f "$KEY"' EXIT
  SSH_OPTS+=(-i "$KEY")
fi
SSH=(ssh "${SSH_OPTS[@]}" "$HOST")
SCP=(scp "${SSH_OPTS[@]}")

npm run build

# 1. Static site.
tar -czf - -C dist . | "${SSH[@]}" 'tar -xzf - -C /var/www/yoru && find /var/www/yoru -maxdepth 3 -type f -exec chmod 644 {} +'

# 2. Stream gateway sources.
tar -czf - zoko.mjs anizone.mjs stream-urls.mjs media-server.mjs | "${SSH[@]}" 'mkdir -p /var/www/yoru/service && tar -xzf - -C /var/www/yoru/service && chmod 644 /var/www/yoru/service/*.mjs'

# 3. nginx + systemd, idempotently.
"${SCP[@]}" deploy/yoru-cache.conf deploy/yoru-zoko.conf deploy/yoru-streams.service deploy/install.sh "$HOST:/tmp/"
"${SSH[@]}" 'sudo bash /tmp/install.sh'

echo "deployed${SITE_URL:+: $SITE_URL}"
