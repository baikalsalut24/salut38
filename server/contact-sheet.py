# Склеивает картинки 63 новых карточек (от поставщика) в листы 4x4 для просмотра на телефоне
import json, os, sys
from PIL import Image, ImageDraw
D = os.environ.get('DATA_DIR', '/var/lib/bs-data'); IMG = '/var/www/salut38/img'; OUT = '/var/www/salut38/_check'
feed = json.load(open(os.path.join(D, 'feed.json'), encoding='utf-8'))
ad = feed.get('ad') or []
os.makedirs(OUT, exist_ok=True)
for f in os.listdir(OUT): os.remove(os.path.join(OUT, f))
N, C, S = 16, 4, 400
for p in range(0, len(ad), N):
    chunk = ad[p:p+N]; rows = (len(chunk) + C - 1) // C
    sheet = Image.new('RGB', (C*S, rows*(S+24)), 'white'); dr = ImageDraw.Draw(sheet)
    for k, it in enumerate(chunk):
        fp = os.path.join(IMG, os.path.basename(it['img'].split('?')[0]))
        x, y = (k % C)*S, (k // C)*(S+24)
        try: im = Image.open(fp).convert('RGB'); im.thumbnail((S, S)); sheet.paste(im, (x, y+24))
        except Exception: pass
        dr.text((x+4, y+6), str(p+k+1) + ' ' + str(it['sku'])[:30], fill='black')
    sheet.save(os.path.join(OUT, 'sheet%d.jpg' % (p//N+1)), quality=85)
print('Листов:', (len(ad)+N-1)//N)
