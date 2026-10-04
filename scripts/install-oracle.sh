#!/usr/bin/env bash
set -euo pipefail
sudo apt update
sudo apt install -y ca-certificates curl git openssl
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo usermod -aG docker "$USER" || true
echo
echo "Docker installed."
echo "If this is your first install, log out and SSH back in, then run:"
echo "cp .env.example .env && nano .env && ./scripts/deploy.sh"
