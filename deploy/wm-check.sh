#!/bin/bash
# Проверить все картинки и видео на водяные знаки, обновить список скрытых и таблицу /root/media-check.csv
(python3 -c "import cv2" 2>/dev/null && command -v tesseract >/dev/null) || apt-get install -y -qq python3-opencv python3-numpy ffmpeg tesseract-ocr
echo "Первая проверка идёт долго (до часа), не закрывайте окно или запустите: nohup bash $0 &"
DATA_DIR=/var/lib/bs-data python3 /opt/bs/wm-check.py
