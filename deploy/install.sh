#!/bin/bash
# Runs on the VPS as root, from the directory deploy.sh copied everything into.
set -euo pipefail
cd "$(dirname "$0")"

install -d /opt/streamdrop /var/www/streamdrop
install -m 755 streamdrop /opt/streamdrop/streamdrop
rsync -a --delete dist/ /var/www/streamdrop/
install -m 644 streamdrop.service /etc/systemd/system/streamdrop.service
install -m 644 nginx-streamdrop.conf /etc/nginx/sites-available/streamdrop.kurohane.xyz
ln -sf /etc/nginx/sites-available/streamdrop.kurohane.xyz /etc/nginx/sites-enabled/streamdrop.kurohane.xyz

systemctl daemon-reload
systemctl enable streamdrop
systemctl restart streamdrop
nginx -t
systemctl reload nginx
systemctl --no-pager --lines=5 status streamdrop
