#!/usr/bin/env bash
# Адрес ретранслятора Telegram (Cloudflare Worker). Вводится только здесь. Пример: https://имя.workers.dev/СЕКРЕТ
set -euo pipefail
[ "$(id -u)" -ne 0 ] && { echo "Запустите от root"; exit 1; }
read -rsp "Адрес ретранслятора (не виден): " U; echo
U=${U%/}
case "$U" in https://*) ;; *) echo "Адрес должен начинаться с https://"; exit 1;; esac
CODE=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$U/botTEST/getMe" || true)
# Telegram на неверный токен отвечает 401/404 — значит, ретранслятор дошёл до него. 000 — не дошёл. 404 от самого Worker (неверный секрет) не отличить, поэтому смотрим тело
BODY=$(curl -s -m 15 "$U/botTEST/getMe" || true)
echo "$BODY" | grep -q '"ok":false' || { echo "Ретранслятор не отвечает как Telegram (код $CODE). Проверьте адрес и секрет."; exit 1; }
sed -i '/^TG_API=/d' /etc/bs.env; printf 'TG_API=%s\n' "$U" >> /etc/bs.env; chmod 600 /etc/bs.env
systemctl restart bs; sleep 2; systemctl is-active bs
echo "Готово: Telegram работает через ретранслятор. Теперь запустите deploy/set-alert.sh и выберите Telegram."
