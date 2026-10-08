#!/usr/bin/env bash
# Куда слать уведомления о сбоях. Нужен бот (deploy/set-bot-keys.sh) и ваш chat id (число; узнать: написать боту @userinfobot).
set -euo pipefail
[ "$(id -u)" -ne 0 ] && { echo "Запустите от root"; exit 1; }
read -rp "Telegram chat id для уведомлений (число): " C
case "$C" in ''|*[!0-9-]*) echo "Нужно число"; exit 1;; esac
sed -i '/^ALERT_CHAT=/d' /etc/bs.env; echo "ALERT_CHAT=$C" >> /etc/bs.env; chmod 600 /etc/bs.env
bash /opt/bs/monitor.sh; echo "Готово. Чтобы уведомления пришли, бот должен быть запущен вами (кнопка Start у бота)."
