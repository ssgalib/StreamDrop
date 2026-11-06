#!/bin/bash
# Optional. Runs on the VPS as root (deploy/deploy.sh does NOT run this): installs coturn, writes its
# config with a fresh secret, and turns on relay credentials in the StreamDrop server.
# Afterwards open UDP 3478, TCP 3478 and UDP 49160-49400 in any provider-level firewall too.
set -euo pipefail
cd "$(dirname "$0")"

ip=$(ip -4 -o addr show scope global dev eth0 | awk '{print $4}' | cut -d/ -f1 | head -1)
[ -n "$ip" ] || { echo "could not find the public IPv4 address on eth0"; exit 1; }

apt-get install -y coturn
install -d -m 0750 -o turnserver -g turnserver /var/log/turnserver
install -d -m 0755 /etc/streamdrop

# Keep the secret if one exists, so credentials issued before a re-run stay valid.
if ! grep -q '^TURN_SECRET=' /etc/streamdrop/env 2>/dev/null; then
  printf 'TURN_SECRET=%s\nTURN_HOST=%s\nRELAY_BUDGET_GB=600\n' "$(openssl rand -hex 32)" "$ip" > /etc/streamdrop/env
  chmod 600 /etc/streamdrop/env
fi
secret=$(sed -n 's/^TURN_SECRET=//p' /etc/streamdrop/env)

sed "s|@SECRET@|$secret|; s|@IP@|$ip|g" turnserver.conf.in > /etc/turnserver.conf
chown root:turnserver /etc/turnserver.conf
chmod 640 /etc/turnserver.conf
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn

install -d /etc/systemd/system/streamdrop.service.d
install -m 644 streamdrop-turn.conf /etc/systemd/system/streamdrop.service.d/turn.conf
cat > /etc/logrotate.d/streamdrop-turn <<'ROT'
/var/log/turnserver/turnserver.log {
    weekly
    rotate 4
    copytruncate
    missingok
    notifempty
}
ROT

if ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow 3478/tcp
  ufw allow 3478/udp
  ufw allow 49160:49400/udp
fi

systemctl daemon-reload
systemctl enable coturn
systemctl restart coturn
systemctl restart streamdrop
systemctl --no-pager --lines=3 status coturn streamdrop
echo "relay enabled on $ip:3478, budget 600 GB/month (edit RELAY_BUDGET_GB in /etc/streamdrop/env)"
