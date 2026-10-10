#!/usr/bin/env bash
# Проверка здоровья сервера раз в 5 минут. При проблеме — сообщение в Telegram (ALERT_CHAT в /etc/bs.env), всегда — запись в журнал.
. /etc/bs.env 2>/dev/null; . /etc/salut38.conf 2>/dev/null
ST=/var/lib/bs-data/monitor.state; touch "$ST"
P=()
cores=$(nproc); load=$(cut -d' ' -f2 /proc/loadavg)   # нагрузка за 5 минут
! systemctl is-active --quiet bs-sync.service && awk -v l="$load" -v c="$cores" 'BEGIN{exit !(l>c*0.8)}' && P+=("нагрузка процессора больше 80% ($load на $cores ядра)")
mem=$(awk '/MemAvailable/{a=$2}/MemTotal/{t=$2}END{printf "%d",a*100/t}' /proc/meminfo); [ "$mem" -lt 20 ] && P+=("занято больше 80% памяти (свободно ${mem}%)")
dsk=$(df / | awk 'NR==2{gsub("%","");print $5}'); [ "$dsk" -gt 80 ] && P+=("диск заполнен больше чем на 80% (${dsk}%)")
# канал: сколько сервер отдаёт в интернет (среднее за 5 минут между проверками). Порог — NET_ALERT_MBIT в /etc/bs.env, по умолчанию 300 Мбит/с
NS=/var/lib/bs-data/monitor.net; nic=$(ip route show default 2>/dev/null | awk '{print $5; exit}'); nic=${nic:-eth0}
tx=$(awk -v n="$nic:" '$1==n{print $10}' /proc/net/dev); now0=$(date +%s)
if [ -n "$tx" ] && [ -f "$NS" ] && read -r ptx pt < "$NS" && [ "$now0" -gt "${pt:-0}" ] && [ "$tx" -ge "${ptx:-0}" ]; then
  mbit=$(( (tx - ptx) * 8 / (now0 - pt) / 1000000 ))
  [ "$mbit" -gt "${NET_ALERT_MBIT:-300}" ] && P+=("канал сильно загружен: сервер отдаёт ~${mbit} Мбит/с (скорее всего видео) — у клиентов может тормозить")
fi; [ -n "$tx" ] && echo "$tx $now0" > "$NS"
# одновременные подключения к сайту
conn=$(ss -Htn state established '( sport = :443 or sport = :80 )' 2>/dev/null | wc -l)
[ "$conn" -gt "${CONN_ALERT:-400}" ] && P+=("на сайте очень много подключений одновременно: $conn")
# скорость ответа главной страницы
tt=$(curl -s -o /dev/null -m 15 -w '%{time_total}' -H "Host: $BASE" http://127.0.0.1/ 2>/dev/null)
awk -v t="${tt:-0}" 'BEGIN{exit !(t>2)}' && P+=("сайт отвечает медленно: ${tt} с")
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
  for CH_ID in ${ALERT_CHAT//,/ }; do  # несколько получателей через запятую
  if [ "${ALERT_CHANNEL:-telegram}" = max ]; then
    curl -s -m 15 -X POST "${MAX_API:-https://platform-api.max.ru}/messages?chat_id=$CH_ID" -H "Authorization: $ALERT_TOKEN" -H 'Content-Type: application/json' -d "$(python3 -c 'import json,sys;print(json.dumps({"text":sys.argv[1]}))' "$1")" >/dev/null
  else
    curl -s -m 15 "${TG_API:-https://api.telegram.org}/bot$ALERT_TOKEN/sendMessage" --data-urlencode "chat_id=$CH_ID" --data-urlencode "text=$1" >/dev/null
  fi; done; }
if [ -n "$msg" ]; then
  # то же самое повторно — не чаще раза в 3 часа (цифры при сравнении не учитываем)
  if [ "${msg//[0-9.,]/}" != "${prev//[0-9.,]/}" ] || [ $((now - ${last:-0})) -gt 10800 ]; then send "⚠ Байкал Салют: $msg"; printf '%s\n%s\n' "$msg" "$now" > "$ST"; fi
else
  [ -n "$prev" ] && send "✅ Байкал Салют: всё в порядке"; printf '\n0\n' > "$ST"
fi
