#!/usr/bin/env bash
# Базовая защита сервера. Безопасно запускать повторно. Вход по паролю НЕ отключается (чтобы не потерять доступ с телефона).
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "Запустите от root"; exit 1; }
export DEBIAN_FRONTEND=noninteractive
echo "== 1. Установка fail2ban и автообновлений безопасности"
apt-get install -y fail2ban unattended-upgrades >/dev/null
cat > /etc/fail2ban/jail.d/bs.local <<'J'
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 2h
[recidive]
enabled = true
bantime = 14d
J
systemctl enable --now fail2ban >/dev/null 2>&1; systemctl restart fail2ban
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'A'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
A
echo "== 2. Файрвол: SSH с ограничением частоты, 80, 443"
ufw limit OpenSSH >/dev/null 2>&1; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null
echo "== 3. Ограничения для сервисов bs (запрет повышения прав, чужого /home и ядра)"
for u in bs bs-sync; do
  [ -f /etc/systemd/system/$u.service ] || continue
  mkdir -p /etc/systemd/system/$u.service.d
  cat > /etc/systemd/system/$u.service.d/harden.conf <<'H'
[Service]
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=full
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
H
done
systemctl daemon-reload; systemctl restart bs
sleep 2; systemctl is-active bs
echo "== 4. SSH сейчас:"
sshd -T 2>/dev/null | grep -Ei "^(permitrootlogin|passwordauthentication|pubkeyauthentication|port) "
echo "Готово. Для полной защиты SSH позже: войти по ключу и отключить пароль (см. чеклист)."
