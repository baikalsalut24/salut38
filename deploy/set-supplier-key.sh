#!/usr/bin/env bash
# Ввод ключей поставщика ПРЯМО В КОНСОЛИ сервера (в чат и в git их не отправляйте).
set -euo pipefail
[ "$(id -u)" -ne 0 ] && { echo "Запустите от root"; exit 1; }
read -rp "CLIENT_ID: " ID
read -rsp "CLIENT_SECRET (ввод не виден): " SEC; echo
sed -i '/^SALUT_ID=/d;/^SALUT_SECRET=/d' /etc/bs.env
printf 'SALUT_ID=%s\nSALUT_SECRET=%s\n' "$ID" "$SEC" >> /etc/bs.env
chmod 600 /etc/bs.env; chown root:root /etc/bs.env
echo "Ключи сохранены в /etc/bs.env"
