#!/usr/bin/env bash
# Служебный бот для владельца: новые заказы и тревоги сервера. Токен и chat id вводятся ТОЛЬКО здесь, в консоли сервера.
# Бота создайте в @BotFather, нажмите у него Start; свой chat id узнайте у @userinfobot.
set -euo pipefail
[ "$(id -u)" -ne 0 ] && { echo "Запустите от root"; exit 1; }
setkey() { sed -i "/^$1=/d" /etc/bs.env; printf '%s=%s\n' "$1" "$2" >> /etc/bs.env; }
read -rsp "Токен служебного бота от @BotFather (не виден): " T; echo
read -rp "Ваш chat id (число): " C
case "$C" in ''|*[!0-9-]*) echo "chat id должен быть числом"; exit 1;; esac
[ -n "$T" ] || { echo "Токен пустой"; exit 1; }
R=$(curl -s -m 15 "https://api.telegram.org/bot$T/sendMessage" --data-urlencode "chat_id=$C" --data-urlencode "text=✅ Байкал Салют: служебный бот подключён. Сюда будут приходить новые заказы и тревоги сервера.")
echo "$R" | grep -q '"ok":true' || { echo "Не получилось отправить. Проверьте токен и что вы нажали Start у бота."; exit 1; }
setkey ALERT_TOKEN "$T"; setkey ALERT_CHAT "$C"; chmod 600 /etc/bs.env
systemctl restart bs; sleep 2; systemctl is-active bs
echo "Готово. Проверочное сообщение отправлено."
