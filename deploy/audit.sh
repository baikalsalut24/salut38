#!/usr/bin/env bash
# Проверка сервера на признаки взлома и майнеров. Ничего не меняет, только показывает.
echo "== Нагрузка (топ-8 процессов по CPU)"; ps -eo pid,user,%cpu,%mem,etime,comm --sort=-%cpu | head -9
echo; echo "== Процессы из /tmp, /dev/shm, /var/tmp или с удалённым файлом (должно быть пусто)"
for p in /proc/[0-9]*; do e=$(readlink "$p/exe" 2>/dev/null); case "$e" in /tmp/*|/dev/shm/*|/var/tmp/*|*"(deleted)"*) echo "$(basename $p) $e";; esac; done
echo; echo "== Типичные имена майнеров (должно быть пусто)"; ps aux | grep -Ei "xmrig|minerd|kinsing|kdevtmpfsi|cryptonight|stratum|\.ICEauth|kthreaddi" | grep -v grep
echo; echo "== Открытые порты (ожидаются 22, 80, 443; 8080 только на 127.0.0.1)"; ss -tlnp | awk 'NR==1||/LISTEN/' | cut -c1-120
echo; echo "== Задания cron у всех пользователей"; for u in $(cut -f1 -d: /etc/passwd); do c=$(crontab -u $u -l 2>/dev/null | grep -v '^#'); [ -n "$c" ] && echo "[$u]" && echo "$c"; done; ls /etc/cron.d 2>/dev/null
echo; echo "== Ключи SSH (должны быть только ваши)"; for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do [ -f "$f" ] && echo "$f: $(wc -l < $f) шт" && cut -c1-60 "$f"; done
echo; echo "== Пользователи с правами root (должен быть только root)"; awk -F: '$3==0{print $1}' /etc/passwd
echo; echo "== Последние входы"; last -n 8 -a | head -10
echo; echo "== Неудачные входы по SSH за сутки"; journalctl -u ssh --since "24 hours ago" --no-pager 2>/dev/null | grep -c "Failed password"
echo; echo "== Новые сервисы за 30 дней"; find /etc/systemd/system -name '*.service' -mtime -30 2>/dev/null
echo; echo "== Занято диска"; df -h / | tail -1
