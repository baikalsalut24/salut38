#!/usr/bin/env bash
# Ускорение и защита от перегрузки: кэш каталога (5 с), кэш открытых файлов, лимит одновременных видео-загрузок с одного IP.
# Безопасно запускать повторно. Перед применением проверяет nginx -t и при ошибке откатывает.
set -euo pipefail
[ "$(id -u)" -ne 0 ] && { echo "Запустите от root"; exit 1; }
NG=/etc/nginx/sites-available/salut38
CONF=/etc/nginx/conf.d/bs-tune.conf
cp "$NG" "$NG.bak-tune" 2>/dev/null || true
mkdir -p /var/cache/nginx/bs
cat > "$CONF" <<'C'
proxy_cache_path /var/cache/nginx/bs levels=1:2 keys_zone=bscat:5m max_size=20m inactive=10m;
limit_conn_zone $binary_remote_addr zone=bsconn:10m;
open_file_cache max=3000 inactive=60s;
open_file_cache_valid 120s;
open_file_cache_errors off;
gzip_comp_level 5;
gzip_min_length 512;
C
python3 - <<'P'
import re
p='/etc/nginx/sites-available/salut38'; s=open(p).read()
# 1. видео: не больше 8 одновременных загрузок с одного IP, после 10 МБ скорость ограничена (канал не забивается одним зрителем)
if 'limit_conn bsconn' not in s:
    s=s.replace('location /video/ { expires 30d; add_header Cache-Control "public"; }',
                'location /video/ { expires 30d; add_header Cache-Control "public"; limit_conn bsconn 8; limit_rate_after 10m; limit_rate 3m; }',1)
# 2. /catalog через кэш на 5 секунд: тысяча запросов в секунду = один запрос к серверу
if 'proxy_cache bscat' not in s:
    blk='''  location = /catalog {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_cache bscat;
    proxy_cache_key "$scheme$host$request_uri$http_origin";
    proxy_cache_valid 200 5s;
    proxy_ignore_headers Cache-Control Expires;
    proxy_cache_lock on;
    proxy_cache_use_stale error timeout updating;
  }
'''
    i=s.find('server_name app.')
    j=s.find('  location / {',i)
    if i>0 and j>0: s=s[:j]+blk+s[j:]
open(p,'w').write(s)
P
if nginx -t 2>/dev/null; then systemctl reload nginx; echo "nginx настроен."; else echo "Ошибка в конфиге, откатываю"; cp "$NG.bak-tune" "$NG"; rm -f "$CONF"; nginx -t && systemctl reload nginx; exit 1; fi
