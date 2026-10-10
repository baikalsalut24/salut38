#!/usr/bin/env bash
# Защита от подбора пароля SSH: строгий fail2ban + ограничения sshd. Вход по паролю остаётся. Безопасно запускать повторно.
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "Запустите от root"; exit 1; }
export DEBIAN_FRONTEND=noninteractive
echo "== Сколько раз пытались подобрать пароль"
for d in 1 7; do n=$(journalctl --since "$d days ago" --no-pager 2>/dev/null | grep -cE "sshd.*(Failed password|Invalid user)"); echo "  за $d дн.: $n попыток"; done
echo "  разных адресов за 7 дн.: $(journalctl --since '7 days ago' --no-pager 2>/dev/null | grep -E 'sshd.*Failed password' | grep -oE 'from [0-9.]+' | sort -u | wc -l)"
echo "== fail2ban: бан после 3 ошибок на сутки, повторно — на 30 дней"
apt-get install -y fail2ban python3-systemd >/dev/null 2>&1 || { apt-get update -qq >/dev/null 2>&1; apt-get install -y fail2ban python3-systemd >/dev/null 2>&1; }
cat > /etc/fail2ban/jail.d/bs.local <<'J'
[DEFAULT]
backend = systemd
[sshd]
enabled = true
maxretry = 3
findtime = 1h
bantime = 24h
[recidive]
enabled = true
logpath = /var/log/fail2ban.log
backend = auto
findtime = 7d
bantime = 30d
J
systemctl enable fail2ban >/dev/null 2>&1; systemctl restart fail2ban
echo "== sshd: не больше 3 попыток за подключение, 20 секунд на вход"
mkdir -p /etc/ssh/sshd_config.d
grep -qi '^Include /etc/ssh/sshd_config.d' /etc/ssh/sshd_config || sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
cat > /etc/ssh/sshd_config.d/10-bs-guard.conf <<'S'
MaxAuthTries 3
LoginGraceTime 20
MaxStartups 10:30:60
S
if sshd -t 2>/dev/null; then systemctl reload ssh 2>/dev/null || systemctl reload sshd; echo "  применено"; else rm -f /etc/ssh/sshd_config.d/10-bs-guard.conf; echo "  ошибка проверки — ограничения sshd не применены, остальное работает"; fi
ufw limit OpenSSH >/dev/null 2>&1 || true
sleep 3
echo "== Сейчас забанено:"
fail2ban-client status sshd 2>/dev/null | grep -E "Currently banned|Total banned" | sed 's/^[^A-Z]*/  /'
echo "Готово. Важно: если сами 3 раза ошибётесь паролем — ваш адрес заблокируется на сутки. Тогда заходите через консоль в панели Рег.облака и выполните: fail2ban-client unban --all"
