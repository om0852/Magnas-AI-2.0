#!/usr/bin/env bash
# Sets up the Magnus relay on a fresh Ubuntu VM (Oracle Cloud Always Free, or any Ubuntu 22.04/24.04).
# Run ON THE VM, from the copied apps/relay folder:   sudo bash deploy/setup-oracle.sh
# It installs Node.js 22 and Caddy, runs the relay as a service on 127.0.0.1:8080, and lets Caddy
# serve it over https with a free certificate for <public-ip>.sslip.io (no domain to buy).
# Set DOMAIN=your.domain to use your own name instead.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "run with sudo"; exit 1; fi
HERE="$(cd "$(dirname "$0")/.." && pwd)"
IP="$(curl -fsS https://api.ipify.org)"
DOMAIN="${DOMAIN:-${IP//./-}.sslip.io}"
echo ">> relay folder: $HERE"
echo ">> address:      https://$DOMAIN"

echo ">> Node.js 22"
if ! command -v node >/dev/null || ! node -e 'process.exit(+process.versions.node.split(".")[0] < 22)'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo ">> Caddy"
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

echo ">> relay files in /opt/magnus-relay"
useradd --system --home /opt/magnus-relay --shell /usr/sbin/nologin magnus 2>/dev/null || true
mkdir -p /opt/magnus-relay/data
cp -r "$HERE/server.mjs" "$HERE/package.json" "$HERE/public" /opt/magnus-relay/
cd /opt/magnus-relay && npm install --omit=dev --no-audit --no-fund
chown -R magnus:magnus /opt/magnus-relay

echo ">> service"
cat > /etc/systemd/system/magnus-relay.service <<EOF
[Unit]
Description=Magnus relay
After=network-online.target

[Service]
User=magnus
WorkingDirectory=/opt/magnus-relay
Environment=PORT=8080 HOST=127.0.0.1 DATA_FILE=/opt/magnus-relay/data/rooms.json
ExecStart=/usr/bin/node /opt/magnus-relay/server.mjs
Restart=always
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/magnus-relay/data
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now magnus-relay

echo ">> https (Caddy)"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:8080
}
EOF
systemctl reload caddy || systemctl restart caddy

echo ">> firewall on the VM (ports 80 and 443)"
if command -v iptables >/dev/null; then
  for p in 80 443; do
    iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || iptables -I INPUT 6 -p tcp --dport $p -j ACCEPT
  done
  command -v netfilter-persistent >/dev/null && netfilter-persistent save || true
fi

echo
echo "Done. Also open ports 80 and 443 in Oracle Cloud: VCN → Security List → Ingress rules (TCP, 0.0.0.0/0)."
echo "Check:   curl https://$DOMAIN/healthz   (should print ok)"
echo "On your PC:   magnus relay setup https://$DOMAIN"
