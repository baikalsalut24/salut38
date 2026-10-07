#!/usr/bin/env bash
# Токены ботов вводятся ТОЛЬКО в консоли сервера. Пустое поле — оставить как есть.
set -euo pipefail
[ "$(id -u)" -ne 0 ] && { echo "Запустите от root"; exit 1; }
setkey() { sed -i "/^$1=/d" /etc/bs.env; printf '%s=%s\n' "$1" "$2" >> /etc/bs.env; }
read -rp "Telegram: имя бота без @ (Enter — пропустить): " B; if [ -n "$B" ]; then read -rsp "Telegram: токен от @BotFather (не виден): " T; echo; setkey TG_BOT "$B"; setkey TG_TOKEN "$T"; fi
read -rp "MAX: имя бота (Enter — пропустить): " B; if [ -n "$B" ]; then read -rsp "MAX: токен бота (не виден): " T; echo; setkey MAX_BOT "$B"; setkey MAX_TOKEN "$T"; fi
chmod 600 /etc/bs.env; systemctl restart bs; sleep 2; journalctl -u bs -n 5 --no-pager | tail -4
