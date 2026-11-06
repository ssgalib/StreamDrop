#!/bin/bash
# Run from your machine: builds, copies to the VPS (host "vps"), and runs install.sh there with sudo.
#
# One-time, also on the VPS: add this to the ingress list in /etc/cloudflared/config.yml, above the
# final "http_status:404" rule, then `sudo systemctl restart cloudflared` and
# `cloudflared tunnel route dns <tunnel> streamdrop.kurohane.xyz`:
#   - hostname: streamdrop.kurohane.xyz
#     service: http://127.0.0.1:80
set -euo pipefail
cd "$(dirname "$0")/.."

out=deploy/build
rm -rf "$out" && mkdir -p "$out"
(cd server && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o "../$out/streamdrop" .)
(cd web && npm ci --silent && npm run build --silent)
cp -r web/dist "$out/dist"
cp deploy/install.sh deploy/streamdrop.service deploy/nginx-streamdrop.conf "$out/"

rsync -a --delete "$out/" vps:streamdrop-deploy/
ssh -t vps 'sudo bash ~/streamdrop-deploy/install.sh'
