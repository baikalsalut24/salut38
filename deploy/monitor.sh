#!/usr/bin/env bash
# Проверка здоровья сервера раз в 5 минут. При проблеме — сообщение в Telegram (ALERT_CHAT в /etc/bs.env), всегда — запись в журнал.
. /etc/bs.env 2>/dev/null; . /etc/salut38.conf 2>/dev/null
ST=/var/lib/bs-data/monitor.state; touch "$ST"
P=()
cores=$(nproc); load=$(cut -d' ' -f2 /proc/loadavg)   # нагрузка за 5 минут
awk -v l="$load" -v c="$cores" 'BEGIN{exit !(l>c*0.8)}' && P+=("нагрузка процессора больше 80% ($load на $cores ядра)")
mem=$(awk '/MemAvailable/{a=$2}/MemTotal/{t=$2}END{printf "%d",a*100/t}' /proc/meminfo); [ "$mem" -lt 20 ] && P+=("занято больше 80% памяти (свободно ${mem}%)")
dsk=$(df / | awk 'NR==2{gsub("%","");print $5}'); [ "$dsk" -gt 80 ] && P+=("диск заполнен больше чем на 80% (${dsk}%)")
systemctl is-active --quiet bs || P+=("сервис заказов bs не работает")
systemctl is-active --quiet nginx || P+=("nginx не работает")
code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' -H "Host: $BASE" http://127.0.0.1/ ); case "$code" in 200|301|302) ;; *) P+=("сайт отвечает кодом $code");; esac
if systemctl is-enabled --quiet bs-sync.timer 2>/dev/null; then
  age=$(( $(date +%s) - $(stat -c %Y /var/lib/bs-data/feed.json 2>/dev/null || echo 0) ))
  [ "$age" -gt 10800 ] && P+=("синхронизация с поставщиком не обновлялась $((age/3600)) ч")
fi
msg=""; [ ${#P[@]} -gt 0 ] && msg=$(printf '%s; ' "${P[@]}")
prev=$(head -1 "$ST"); last=$(sed -n 2p "$ST"); now=$(date +%s)
send() { logger -t bs-monitor "$1"; [ -n "${ALERT_TOKEN:-}" ] && [ -n "${ALERT_CHAT:-}" ] || return 0
  if [ "${ALERT_CHANNEL:-telegram}" = max ]; then
    curl -s -m 15 -X POST "${MAX_API:-https://platform-api.max.ru}/messages?chat_id=$ALERT_CHAT" -H "Authorization: $ALERT_TOKEN" -H 'Content-Type: application/json' -d "$(python3 -c 'import json,sys;print(json.dumps({"text":sys.argv[1]}))' "$1")" >/dev/null
  else
    curl -s -m 15 "https://api.telegram.org/bot$ALERT_TOKEN/sendMessage" --data-urlencode "chat_id=$ALERT_CHAT" --data-urlencode "text=$1" >/dev/null
  fi; }
if [ -n "$msg" ]; then
  # то же самое повторно — не чаще раза в 3 часа
  if [ "$msg" != "$prev" ] || [ $((now - ${last:-0})) -gt 10800 ]; then send "⚠ Байкал Салют: $msg"; printf '%s\n%s\n' "$msg" "$now" > "$ST"; fi
else
  [ -n "$prev" ] && send "✅ Байкал Салют: всё в порядке"; printf '\n0\n' > "$ST"
fi
