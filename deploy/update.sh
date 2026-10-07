#!/usr/bin/env bash
# Обновление файлов на сервере. Запуск: bash /opt/salut38-src/deploy/update.sh
set -euo pipefail
. /etc/salut38.conf
[ "${1:-}" = "nopull" ] || git -C "$SRC" pull --ff-only
python3 -c "import PIL" 2>/dev/null || apt-get install -y python3-pil >/dev/null
cp -r "$SRC/server/list-supplier-images.js" "$SRC/server/img-stats.py" "$SRC/server/contact-sheet.py" "$SRC/server/video-frames.py" "$SRC/server/wm-check.py" "$SRC/server/normalize.py" "$SRC/server/check-feed.js" "$SRC/server/server.js" "$SRC/server/cardbot.js" "$SRC/server/sync.js" "$SRC/server/public" "$SRC/server/catalog.json" /opt/bs/
mkdir -p /var/www/salut38/img /var/www/salut38/video
chown -R bs:bs /opt/bs /var/lib/bs-data /var/www/salut38/img /var/www/salut38/video
sed "s#__ORDER_URL__#https://app.$BASE/order#g" "$SRC/site/index.html" > /var/www/salut38/index.html
if [ "$MODE" = "temp" ]; then cp "$SRC/site/robots-temp.txt" /var/www/salut38/robots.txt; else cp "$SRC/site/robots.txt" /var/www/salut38/robots.txt; fi
cat > /opt/bs/run-sync.sh <<'R'
#!/bin/bash
# синхронизация -> проверка водяных знаков -> если появились новые, ещё раз синхронизация (скрыть их сразу)
H=/var/lib/bs-data/hide-auto.txt; B=$(cat $H 2>/dev/null | md5sum)
/usr/bin/node /opt/bs/sync.js "$@" || exit $?
DATA_DIR=/var/lib/bs-data /usr/bin/python3 /opt/bs/wm-check.py
[ "$B" != "$(cat $H 2>/dev/null | md5sum)" ] && /usr/bin/node /opt/bs/sync.js
exit 0
R
chmod +x /opt/bs/run-sync.sh
(python3 -c "import cv2" 2>/dev/null && command -v tesseract >/dev/null) || apt-get install -y -qq python3-opencv python3-numpy ffmpeg tesseract-ocr
mkdir -p /opt/bs/wm-templates; cp -r "$SRC"/server/wm-templates/. /opt/bs/wm-templates/ 2>/dev/null
cat > /etc/systemd/system/bs-sync.service <<'U'
[Unit]
Description=Baikal Salut supplier sync
[Service]
Type=oneshot
User=bs
WorkingDirectory=/opt/bs
EnvironmentFile=/etc/bs.env
Environment=IMG_DIR=/var/www/salut38/img
Environment=VIDEO_DIR=/var/www/salut38/video
ExecStart=/opt/bs/run-sync.sh
U
cat > /etc/systemd/system/bs-sync.timer <<'U'
[Unit]
Description=Hourly supplier sync
[Timer]
OnCalendar=hourly
RandomizedDelaySec=300
Persistent=true
[Install]
WantedBy=timers.target
U
cp "$SRC/site/card.jpg" /var/www/salut38/card.jpg
grep -q '^SITE_URL=' /etc/bs.env || printf 'SITE_URL=https://%s\nCARD_IMG=https://%s/card.jpg\n' "$BASE" "$BASE" >> /etc/bs.env
systemctl daemon-reload
systemctl restart bs 2>/dev/null || true
echo "Обновлено."
