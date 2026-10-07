#!/usr/bin/env bash
# Обновление файлов на сервере. Запуск: bash /opt/salut38-src/deploy/update.sh
set -euo pipefail
. /etc/salut38.conf
[ "${1:-}" = "nopull" ] || git -C "$SRC" pull --ff-only
cp -r "$SRC/server/server.js" "$SRC/server/public" "$SRC/server/catalog.json" /opt/bs/
chown -R bs:bs /opt/bs /var/lib/bs-data
sed "s#__ORDER_URL__#https://app.$BASE/order#g" "$SRC/site/index.html" > /var/www/salut38/index.html
if [ "$MODE" = "temp" ]; then cp "$SRC/site/robots-temp.txt" /var/www/salut38/robots.txt; else cp "$SRC/site/robots.txt" /var/www/salut38/robots.txt; fi
systemctl restart bs 2>/dev/null || true
echo "Обновлено."
