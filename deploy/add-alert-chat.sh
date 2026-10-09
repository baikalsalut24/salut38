#!/bin/bash
# Добавить ещё одного получателя уведомлений о заказах и алертов: bash add-alert-chat.sh 123456789
# (получатель сначала должен нажать Start у бота)
set -e
C="${1:-}"; case "$C" in ''|*[!0-9-]*) echo "Нужен chat id числом: bash add-alert-chat.sh 123456789"; exit 1;; esac
set -a; . /etc/bs.env; set +a
[ -n "${ALERT_TOKEN:-}" ] || { echo "Сначала настройте бота: bash set-alert.sh"; exit 1; }
case ",${ALERT_CHAT}," in *",$C,"*) echo "Этот chat id уже добавлен."; exit 0;; esac
R=$(curl -s -m 15 "${TG_API:-https://api.telegram.org}/bot$ALERT_TOKEN/sendMessage" --data-urlencode "chat_id=$C" --data-urlencode "text=✅ Байкал Салют: вы подключены к уведомлениям о заказах.") || true
echo "$R" | grep -q '"ok":true' || { echo "Не отправилось. Человек нажал Start у бота? Ответ: $(echo "$R" | cut -c1-160)"; exit 1; }
NEW="${ALERT_CHAT},${C}"
sed -i "s|^ALERT_CHAT=.*|ALERT_CHAT=$NEW|" /etc/bs.env
systemctl restart bs; sleep 2; systemctl is-active bs
echo "Готово. Получатели: $NEW"
