#!/usr/bin/env bash
# Sets up the Magnus relay on an Oracle Cloud VM (Oracle Linux 8/9 or Ubuntu 22.04/24.04).
# Run ON THE VM, from the copied apps/relay folder:   sudo bash deploy/setup-oracle.sh
# It installs Node.js 22 and Caddy, runs the relay as a service on 127.0.0.1:8080, and lets Caddy
# serve it over https with a free certificate for <public-ip>.sslip.io (no domain to buy).
# Set DOMAIN=your.domain to use your own name instead.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "run with sudo"; exit 1; fi
HERE="$(cd "$(dirname "$0")/.." && pwd)"
IP="$(curl -fsS https://api.ipify.org)"
DOMAIN="${DOMAIN:-${IP//./-}.sslip.io}"
ARCH="$(uname -m)"
case "$ARCH" in x86_64) CADDY_ARCH=amd64 ;; aarch64) CADDY_ARCH=arm64 ;; *) echo "unsupported CPU $ARCH"; exit 1 ;; esac
if command -v dnf >/dev/null; then PKG=dnf; elif command -v apt-get >/dev/null; then PKG=apt; else echo "needs dnf or apt"; exit 1; fi
echo ">> relay folder: $HERE"
echo ">> system:       $PKG, $ARCH"
echo ">> address:      https://$DOMAIN"

echo ">> Node.js 22 (official build from nodejs.org, checksum verified)"
# Not through dnf/apt: on a 1 GB Always Free VM, dnf's package lists run it out of memory.
export PATH="/usr/local/bin:$PATH"
if ! command -v node >/dev/null || ! node -e 'process.exit(+process.versions.node.split(".")[0] < 22)'; then
  NODE_ARCH=x64; [ "$ARCH" = aarch64 ] && NODE_ARCH=arm64
  BASE=https://nodejs.org/dist/latest-v22.x
  TMP="$(mktemp -d)"
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  FILE="$(grep -oE "node-v22\.[0-9]+\.[0-9]+-linux-${NODE_ARCH}\.tar\.xz" "$TMP/SHASUMS256.txt" | head -1)"
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
  (cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$TMP/$FILE" -C /usr/local --strip-components=1 --no-same-owner
  rm -rf "$TMP"
fi
node -v

echo ">> Caddy"
if ! command -v caddy >/dev/null; then
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=${CADDY_ARCH}" -o /usr/local/bin/caddy
  chmod 755 /usr/local/bin/caddy
fi
CADDY="$(command -v caddy)"
"$CADDY" version
id caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:8080
}
EOF
cat > /etc/systemd/system/caddy.service <<EOF
[Unit]
Description=Caddy (https for the Magnus relay)
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
ExecStart=$CADDY run --environ --config /etc/caddy/Caddyfile
ExecReload=$CADDY reload --config /etc/caddy/Caddyfile --force
Restart=on-failure
AmbientCapabilities=CAP_NET_BIND_SERVICE
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

echo ">> relay files in /opt/magnus-relay"
id magnus >/dev/null 2>&1 || useradd --system --home /opt/magnus-relay --shell /usr/sbin/nologin magnus
mkdir -p /opt/magnus-relay/data
cp -r "$HERE/server.mjs" "$HERE/package.json" "$HERE/public" /opt/magnus-relay/
(cd /opt/magnus-relay && npm install --omit=dev --no-audit --no-fund)
chown -R magnus:magnus /opt/magnus-relay
NODE="$(command -v node)"

cat > /etc/systemd/system/magnus-relay.service <<EOF
[Unit]
Description=Magnus relay
After=network-online.target

[Service]
User=magnus
WorkingDirectory=/opt/magnus-relay
Environment=PORT=8080 HOST=127.0.0.1 DATA_FILE=/opt/magnus-relay/data/rooms.json
ExecStart=$NODE /opt/magnus-relay/server.mjs
Restart=always
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/magnus-relay/data
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

# Oracle Linux runs SELinux: give the copied files their normal labels.
command -v restorecon >/dev/null && restorecon -R /opt/magnus-relay /etc/caddy "$CADDY" /etc/systemd/system/caddy.service /etc/systemd/system/magnus-relay.service || true

systemctl daemon-reload
systemctl enable --now magnus-relay
systemctl enable caddy
systemctl restart caddy

echo ">> firewall on the VM (ports 80 and 443)"
if command -v firewall-cmd >/dev/null && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http --add-service=https
  firewall-cmd --reload
elif command -v iptables >/dev/null; then
  for p in 80 443; do
    iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || iptables -I INPUT 6 -p tcp --dport $p -j ACCEPT
  done
  command -v netfilter-persistent >/dev/null && netfilter-persistent save || true
fi

sleep 2
echo
systemctl is-active magnus-relay caddy
curl -fsS http://127.0.0.1:8080/healthz && echo " (relay answers locally)"
echo "Done. Ports 80 and 443 must also be open in Oracle Cloud: VCN → Security List → Ingress rules."
echo "Check:   curl https://$DOMAIN/healthz   (should print ok; the first certificate takes up to a minute)"
echo "On your PC:   magnus relay setup https://$DOMAIN"
