#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: ./scripts/enable-https.sh your.domain.com your@email.com"
  exit 1
fi

DOMAIN="$1"
EMAIL="$2"

mkdir -p certbot/conf certbot/www gateway/conf.d

echo "Requesting Let's Encrypt certificate for $DOMAIN ..."
docker compose up -d gateway
docker run --rm   -v "$(pwd)/certbot/conf:/etc/letsencrypt"   -v "$(pwd)/certbot/www:/var/www/certbot"   certbot/certbot:latest certonly --webroot   --webroot-path=/var/www/certbot   --email "$EMAIL" --agree-tos --no-eff-email   -d "$DOMAIN"

sed "s/__DOMAIN__/$DOMAIN/g" gateway/templates/https.conf.template > gateway/conf.d/default.conf

if grep -q '^PUBLIC_URL=' .env; then
  sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=https://$DOMAIN#" .env
else
  echo "PUBLIC_URL=https://$DOMAIN" >> .env
fi

docker compose up -d --force-recreate api gateway

echo "HTTPS enabled: https://$DOMAIN"
echo "IMPORTANT: set the GitHub OAuth callback URL to:"
echo "https://$DOMAIN/api/auth/github/callback"
