#!/usr/bin/env bash
# Вход на сервер только по ключу (пароль по SSH отключается). Включается, только если вход по ключу уже сработал.
# Откат: bash ssh-keyonly.sh --undo   (консоль в панели Рег.облака пускает по паролю всегда)
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "Запустите от root"; exit 1; }
F=/etc/ssh/sshd_config.d/00-bs-keyonly.conf
reload() { systemctl reload ssh 2>/dev/null || systemctl reload sshd; }
if [ "${1:-}" = "--undo" ]; then rm -f "$F"; sshd -t && reload; echo "Вход по паролю снова включён."; exit 0; fi
n=$(grep -cE '^(ssh-|ecdsa-)' /root/.ssh/authorized_keys 2>/dev/null || echo 0)
echo "Ключей на сервере: $n"
[ "$n" -gt 0 ] || { echo "❌ Ключей нет — сначала добавьте ключ с телефона. Ничего не изменено."; exit 1; }
ok=$(journalctl --since "24 hours ago" --no-pager 2>/dev/null | grep -c "Accepted publickey for root")
echo "Входов по ключу за сутки: $ok"
[ "$ok" -gt 0 ] || { echo "❌ Ещё ни разу не входили по ключу. Подключитесь заново по ключу и запустите скрипт ещё раз. Ничего не изменено."; exit 1; }
mkdir -p /etc/ssh/sshd_config.d
grep -qi '^Include /etc/ssh/sshd_config.d' /etc/ssh/sshd_config || sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
cat > "$F" <<'S'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
S
if sshd -t; then reload; else rm -f "$F"; echo "❌ Ошибка проверки настроек — ничего не изменено."; exit 1; fi
echo "== Сейчас действует:"; sshd -T 2>/dev/null | grep -Ei '^(passwordauthentication|permitrootlogin|pubkeyauthentication) '
echo "✅ Готово: пароль по SSH больше не принимается. НЕ закрывайте это окно — откройте новое подключение и проверьте, что пускает."
