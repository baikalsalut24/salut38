# Кадры из видео для проверки водяных знаков: sheet_video.jpg. Артикулы как аргументы или 12 случайных
import os, sys, random, subprocess, tempfile
from PIL import Image, ImageDraw
V = '/var/www/salut38/video'; OUT = '/var/www/salut38/_check'; os.makedirs(OUT, exist_ok=True)
fs = sorted(f for f in os.listdir(V) if f.endswith('.mp4'))
pick = random.sample(fs, min(12, len(fs)))
S, C = 400, 4; rows = (len(pick)+C-1)//C
sheet = Image.new('RGB', (C*S, rows*(S+24)), 'white'); dr = ImageDraw.Draw(sheet)
for k, f in enumerate(pick):
    t = tempfile.mktemp(suffix='.jpg')
    subprocess.run(['ffmpeg','-y','-loglevel','error','-ss','2','-i',os.path.join(V,f),'-frames:v','1',t])
    x, y = (k % C)*S, (k // C)*(S+24)
    try: im = Image.open(t).convert('RGB'); im.thumbnail((S, S)); sheet.paste(im, (x, y+24))
    except Exception: pass
    dr.text((x+4, y+6), f, fill='black')
sheet.save(os.path.join(OUT, 'sheet_video.jpg'), quality=85)
print('готово')
