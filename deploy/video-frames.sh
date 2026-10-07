#!/bin/bash
. /etc/salut38.conf
command -v ffmpeg >/dev/null || apt-get install -y -qq ffmpeg
python3 /opt/bs/video-frames.py && echo "Откройте: https://$BASE/_check/sheet_video.jpg (повторный запуск — другие 12 видео)"
