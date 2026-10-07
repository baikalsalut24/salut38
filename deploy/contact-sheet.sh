#!/bin/bash
# Листы с картинками новых карточек: открыть https://<сайт>/_check/sheet1.jpg ... Потом удалить: rm -r /var/www/salut38/_check
. /etc/salut38.conf
DATA_DIR=/var/lib/bs-data python3 /opt/bs/contact-sheet.py && ls /var/www/salut38/_check && echo "Откройте: https://$BASE/_check/sheet1.jpg (sheet2, sheet3, sheet4)"
echo "После просмотра: rm -r /var/www/salut38/_check"
