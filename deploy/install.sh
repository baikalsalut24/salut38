#!/usr/bin/env bash
# Установка «Байкал Салют» на чистый Ubuntu 22.04/24.04 (от root).
#   bash install.sh BASE_DOMAIN [temp] [TG_TOKEN] [TG_BOT]
# Пример для временного адреса:  bash install.sh 80-78-245-34.sslip.io temp
# Сайт будет на https://BASE_DOMAIN, приложение сотрудников на https://app.BASE_DOMAIN
set -euo pipefail
BASE="${1:-}"; MODE="${2:-live}"; TGT="${3:-}"; TGB="${4:-}"
[ -z "$BASE" ] && { echo "Укажите домен: bash install.sh 80-78-245-34.sslip.io temp"; exit 1; }
[ "$(id -u)" -ne 0 ] && { echo "Запустите от root"; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"
export DEBIAN_FRONTEND=noninteractive
echo "== пакеты =="
apt-get update -y
apt-get install -y curl ca-certificates nginx certbot python3-certbot-nginx git ufw python3-pil
nodeok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; }
nodeok || apt-get install -y nodejs || true
if ! nodeok; then curl -fsSL https://deb.nodesource.com/setup_20.x | bash - ; apt-get install -y nodejs; fi
nodeok || { echo "Не удалось установить Node.js 18+"; exit 1; }
echo "== swap и журналы =="
if ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=200M\n' > /etc/systemd/journald.conf.d/size.conf
systemctl restart systemd-journald || true
echo "== файрвол =="
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null
echo "== сервер заказов =="
id bs >/dev/null 2>&1 || useradd --system --home /opt/bs --shell /usr/sbin/nologin bs
mkdir -p /opt/bs /var/lib/bs-data /var/www/salut38
umask 077
printf 'BASE=%s\nMODE=%s\nSRC=%s\n' "$BASE" "$MODE" "$SRC" > /etc/salut38.conf
if [ ! -f /etc/bs.env ]; then
cat > /etc/bs.env <<ENV
PORT=8080
DATA_DIR=/var/lib/bs-data
TG_TOKEN=$TGT
TG_BOT=$TGB
ENV
fi
umask 022
cat > /etc/systemd/system/bs.service <<'UNIT'
[Unit]
Description=Baikal Salut orders server
After=network.target
[Service]
User=bs
WorkingDirectory=/opt/bs
EnvironmentFile=/etc/bs.env
ExecStart=/usr/bin/node /opt/bs/server.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
bash "$SRC/deploy/update.sh" nopull
echo "== nginx =="
ROBOTS=""; [ "$MODE" = "temp" ] && ROBOTS='add_header X-Robots-Tag "noindex, nofollow" always;'
cat > /etc/nginx/sites-available/salut38 <<NGINX
server {
  listen 80;
  server_name $BASE;
  root /var/www/salut38;
  index index.html;
  gzip on; gzip_types text/html text/css application/javascript application/json image/svg+xml;
  $ROBOTS
  location /video/ { expires 30d; add_header Cache-Control "public"; }
  location /img/ { expires 30d; add_header Cache-Control "public"; }
  location / { try_files \$uri /index.html; }
  location = /index.html { add_header Cache-Control "no-cache"; $ROBOTS }
}
server {
  listen 80;
  server_name app.$BASE;
  client_max_body_size 450m;
  proxy_request_buffering off;
  client_body_timeout 900s;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 900s;
  }
}
NGINX
ln -sf /etc/nginx/sites-available/salut38 /etc/nginx/sites-enabled/salut38
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
systemctl daemon-reload && systemctl enable --now bs
sleep 2
systemctl is-active bs
echo "== сертификат (https) =="
certbot --nginx -d "$BASE" -d "app.$BASE" --non-interactive --agree-tos --register-unsafely-without-email --redirect
echo
echo "Готово."
echo "Сайт:                  https://$BASE"
echo "Приложение сотрудников: https://app.$BASE"
echo "ORDER_URL:             https://app.$BASE/order"
echo "Смените PIN по умолчанию (0000, 1111, 2222, 3333): вкладка «Команда» у владельца."
