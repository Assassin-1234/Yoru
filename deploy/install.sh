# Install the stream gateway's nginx config on the production VPS. Run with sudo.
set -euo pipefail

install -d -o www-data -g www-data -m 700 /var/cache/nginx/yoru
install -d /etc/nginx/snippets
install -m 644 /tmp/yoru-cache.conf /etc/nginx/conf.d/yoru-cache.conf
install -m 644 /tmp/yoru-zoko.conf /etc/nginx/snippets/yoru-zoko.conf
install -m 644 /tmp/yoru-streams.service /etc/systemd/system/yoru-streams.service

# Idempotently put the gateway include inside the main yoru server block.
if ! grep -q 'yoru-zoko.conf' /etc/nginx/sites-enabled/yoru; then
  perl -0pi -e 's{(?:\A|\n)(\s*root /var/www/yoru;)}{$1\n    include /etc/nginx/snippets/yoru-zoko.conf;}' /etc/nginx/sites-enabled/yoru
fi

# AniZone challenges the VPS IP; FlareSolverr solves the clearance once and the gateway reuses the cookie.
if command -v docker >/dev/null 2>&1; then
  if ! docker ps --format '{{.Names}}' | grep -qx flaresolverr; then
    docker rm -f flaresolverr >/dev/null 2>&1 || true
    docker run -d --name flaresolverr --restart unless-stopped -p 127.0.0.1:8191:8191 ghcr.io/flaresolverr/flaresolverr:latest >/dev/null
  fi
fi

nginx -t
systemctl daemon-reload
systemctl enable yoru-streams
systemctl restart yoru-streams
# Warm the AniZone Cloudflare clearance so the first viewer after a deploy does not pay the solver latency.
sleep 1
curl -sS --max-time 30 http://127.0.0.1:5174/zoko/prewarm >/dev/null 2>&1 || true
systemctl reload nginx
