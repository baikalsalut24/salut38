#!/usr/bin/env bash
# Служебный бот для владельца: новые заказы и тревоги сервера. Работает в MAX (из России доступен) или в Telegram.
# Токен вводится ТОЛЬКО здесь, в консоли сервера. Бота создайте в MAX (раздел для ботов / MasterBot) и получите токен.
set -euo pipefail
[ "$(id -u)" -ne 0 ] && { echo "Запустите от root"; exit 1; }
setkey() { sed -i "/^$1=/d" /etc/bs.env; printf '%s=%s\n' "$1" "$2" >> /etc/bs.env; }
MAXA=https://platform-api.max.ru
read -rp "Канал: 1 — MAX (рекомендуется), 2 — Telegram [1]: " K; K=${K:-1}
read -rsp "Токен служебного бота (не виден): " T; echo
[ -n "$T" ] || { echo "Токен пустой"; exit 1; }
if [ "$K" = 1 ]; then
  CODE=$(curl -s -m 15 -o /dev/null -w '%{http_code}' -H "Authorization: $T" "$MAXA/me" || true)
  [ "$CODE" = 200 ] || { echo "MAX не принял токен или недоступен (код $CODE)."; exit 1; }
  echo "Откройте своего бота в MAX, нажмите «Начать» (Start) и напишите ему любое слово. Жду до 2 минут..."
  C=""; M=""
  for i in $(seq 1 8); do
    R=$(curl -s -m 20 -H "Authorization: $T" "$MAXA/updates?timeout=10&types=message_created,bot_started${M:+&marker=$M}" || true)
    C=$(echo "$R" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin)
  for u in d.get("updates",[]):
    c=u.get("chat_id") or (u.get("message",{}).get("recipient",{}).get("chat_id"))
    if c: print(c); break
except Exception: pass')
    [ -n "$C" ] && break
  done
  [ -n "$C" ] || { echo "Не увидел сообщения от вас. Запустите скрипт заново и напишите боту сразу после запуска."; exit 1; }
  CH=max
  RES=$(curl -s -m 15 -X POST "$MAXA/messages?chat_id=$C" -H "Authorization: $T" -H 'Content-Type: application/json' -d '{"text":"✅ Байкал Салют: служебный бот подключён. Сюда будут приходить новые заказы и тревоги сервера."}')
  echo "$RES" | grep -q '"message"' || { echo "Не получилось отправить: $RES" | cut -c1-200; exit 1; }
else
  read -rp "Ваш chat id (число): " C
  case "$C" in ''|*[!0-9-]*) echo "chat id должен быть числом"; exit 1;; esac
  CH=telegram
  R=$(curl -s -m 15 "https://api.telegram.org/bot$T/sendMessage" --data-urlencode "chat_id=$C" --data-urlencode "text=✅ Байкал Салют: служебный бот подключён.") || true
  echo "$R" | grep -q '"ok":true' || { echo "Telegram с сервера недоступен или токен неверный."; exit 1; }
fi
setkey ALERT_TOKEN "$T"; setkey ALERT_CHAT "$C"; setkey ALERT_CHANNEL "$CH"; chmod 600 /etc/bs.env
systemctl restart bs; sleep 2; systemctl is-active bs
echo "Готово. Проверочное сообщение отправлено в $CH."
