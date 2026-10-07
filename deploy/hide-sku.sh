#!/bin/bash
# Скрыть товары (картинка с водяным знаком и т.п.): bash hide-sku.sh АРТИКУЛ [АРТИКУЛ...]
# Видео без показа:  bash hide-sku.sh --video АРТИКУЛ ...   Список: bash hide-sku.sh --list
D=/var/lib/bs-data; F=hide-manual.txt
[ "$1" = "--list" ] && { echo "Скрыты:"; cat $D/hide-manual.txt 2>/dev/null; echo "Без видео:"; cat $D/novideo.txt 2>/dev/null; exit 0; }
[ "$1" = "--video" ] && { F=novideo.txt; shift; }
[ -z "$1" ] && { echo "Укажите артикулы"; exit 1; }
for a in "$@"; do grep -qxF "$a" $D/$F 2>/dev/null || echo "$a" >> $D/$F; done
echo "Записано. Применится после: systemctl start bs-sync.service"
