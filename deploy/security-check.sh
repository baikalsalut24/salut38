#!/usr/bin/env bash
# Проверка сервера на посторонних: пользователи, ключи, входы, майнеры, автозапуск, порты. Ничего не меняет (кроме удаления дублей ключей).
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "Запустите от root"; exit 1; }
W=0; ok(){ echo "✅ $1"; }; bad(){ echo "⚠ $1"; W=$((W+1)); }
echo "===== Пользователи ====="
u0=$(awk -F: '$3==0 && $1!="root"{print $1}' /etc/passwd); [ -z "$u0" ] && ok "права root только у root" || bad "права root ещё у: $u0"
sh=$(awk -F: '$7!~/(nologin|false|sync|halt|shutdown)$/ && $1!="root"{print $1}' /etc/passwd)
if [ -z "$sh" ]; then ok "других пользователей со входом нет"; else for u in $sh; do st=$(passwd -S "$u" 2>/dev/null | awk '{print $2}'); id=$(id -u "$u")
  if [ "$st" = P ]; then bad "пользователь $u (id $id) — задан пароль, может входить"; else echo "   пользователь $u (id $id) — пароля нет (норма)"; fi; done; fi
sd=$(ls /etc/sudoers.d 2>/dev/null | grep -vE "^(README|90-cloud-init-users)$" | tr '\n' ' '); [ -z "$sd" ] && ok "доп. прав sudo нет" || bad "доп. права sudo: /etc/sudoers.d/$sd"
echo "===== Ключи входа ====="
f=/root/.ssh/authorized_keys; if [ -f "$f" ]; then b=$(wc -l < "$f"); awk 'NF && !s[$0]++' "$f" > "$f.tmp" && cat "$f.tmp" > "$f" && rm -f "$f.tmp"; a=$(grep -c . "$f"); [ "$b" != "$a" ] && echo "   убраны дубли ключей: было $b, стало $a"
  ssh-keygen -lf "$f" 2>/dev/null | awk '{print "   root: "$2" "$NF}'; fi
for h in /home/*; do [ -f "$h/.ssh/authorized_keys" ] && bad "есть ключи у пользователя $(basename "$h")"; done
echo "===== Успешные входы за 30 дней (адрес — сколько раз) ====="
journalctl --since "30 days ago" --no-pager 2>/dev/null | grep -E "sshd.*Accepted" | grep -oE "for [a-z0-9_-]+ from [0-9.]+" | awk '{print "   "$2" с "$4}' | sort | uniq -c | sort -rn | head -10
echo "   (сравните адреса со своими — ваш последний: $(last -i -n 1 root 2>/dev/null | awk 'NR==1{print $3}'))"
echo "===== Майнеры и подозрительные процессы ====="
mn=$(ps -eo pid,user,comm,args --no-headers | grep -iE "xmrig|kdevtmpfsi|kinsing|minerd|cpuminer|xmr-stak|nanominer|c3pool|moneroocean|nbminer|t-rex|lolminer|\.x86_64|kthreaddk|sysupdate|networkservice" | grep -v grep); [ -z "$mn" ] && ok "известных майнеров нет" || bad "подозрительные процессы:
$mn"
tm=$(ls -l /proc/[0-9]*/exe 2>/dev/null | grep -E "/tmp/|/dev/shm/|/var/tmp/|\(deleted\)" | grep -vE "node|nginx|python|systemd|snapd|fail2ban|ffmpeg" | head -5); [ -z "$tm" ] && ok "процессов из временных папок нет" || bad "процессы из временных папок или удалённых файлов:
$tm"
echo "   больше всего грузят процессор сейчас:"; ps -eo pcpu,user,comm --sort=-pcpu --no-headers | head -5 | awk '{printf "   %5s%%  %-10s %s\n",$1,$2,$3}'
ex=$(find /tmp /var/tmp /dev/shm -type f -perm -u+x -size +1k 2>/dev/null | grep -v -E "systemd-private|snap" | while read -r x; do h=$(head -c4 "$x" 2>/dev/null | od -An -c | tr -d ' '); case "$h" in *ELF*|\#\!*) echo "$x";; esac; done | head -5); [ -z "$ex" ] && ok "исполняемых файлов во временных папках нет" || bad "исполняемые файлы во временных папках:
$ex"
[ -s /etc/ld.so.preload ] && bad "есть /etc/ld.so.preload (часто признак взлома): $(cat /etc/ld.so.preload)" || ok "подмены системных библиотек нет"
echo "===== Автозапуск ====="
cr=$(for u in $(cut -d: -f1 /etc/passwd); do crontab -l -u "$u" 2>/dev/null | grep -vE '^\s*(#|$)' | sed "s/^/   $u: /"; done); [ -z "$cr" ] && ok "личных заданий cron нет" || { echo "   задания cron (проверьте, все ли знакомы):"; echo "$cr"; }
cd_=$(ls /etc/cron.d 2>/dev/null | grep -vE "^(e2scrub_all|sysstat|popularity-contest|php|certbot|\.placeholder|anacron)$" | tr '\n' ' '); [ -z "$cd_" ] && ok "лишних файлов в /etc/cron.d нет" || echo "   /etc/cron.d: $cd_"
sv=$(ls /etc/systemd/system/*.service /etc/systemd/system/*.timer 2>/dev/null | xargs -n1 basename 2>/dev/null | grep -vE "^(bs|bs-sync|bs-monitor|bs-[a-z-]+|snap\..*|dbus-.*|sshd|syslog|display-manager|cloud-.*|iscsi|vmtoolsd|systemd-networkd-wait-online|open-vm-tools)\.(service|timer)$" | tr '\n' ' '); [ -z "$sv" ] && ok "посторонних служб нет" || echo "   свои службы в /etc/systemd/system (проверьте): $sv"
echo "===== Открытые порты и соединения ====="
ss -Htlnp 2>/dev/null | awk '{split($4,a,":");p=a[length(a)];h=$4;sub(":"p"$","",h);match($0,/users:\(\("[^"]+"/);n=substr($0,RSTART+9,RLENGTH-10);print "   "p" "h" "n}' | sort -un -k1,1
po=$(ss -Htnp state established 2>/dev/null | awk '{split($4,a,":");print a[length(a)]" "$0}' | grep -E "^(3333|4444|5555|6666|7777|8888|9999|14444|14433|45700|10128|20128) " | head -3); [ -z "$po" ] && ok "соединений с майнинг-пулами нет" || bad "соединения на порты майнинг-пулов:
$po"
echo "===== Целостность системных программ ====="
iv=$(dpkg -V openssh-server openssh-client coreutils procps util-linux login passwd sudo 2>/dev/null | grep -E '^..5' | grep -v " c /etc/" | head -5); [ -z "$iv" ] && ok "ssh, ps, ls, login, sudo не подменены" || bad "изменены системные файлы:
$iv"
echo "=========================="
[ "$W" = 0 ] && echo "✅ Итог: следов посторонних не найдено" || echo "⚠ Итог: замечаний $W — пришлите скриншот"
