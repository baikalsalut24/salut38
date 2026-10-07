#!/usr/bin/env python3
"""Сколько картинок мелких и какие товары: python3 img-stats.py"""
import os, json
from PIL import Image
DATA = os.environ.get('DATA_DIR', '/var/lib/bs-data'); RAW = os.path.join(DATA, 'img-orig')
feed = json.load(open(os.path.join(DATA, 'feed.json')))
base = {b['sku']: b['name'] for b in json.load(open('/opt/bs/catalog.json'))}
base.update({a['sku']: a['name'] for a in feed.get('ad', [])})
sku_of = {u.split('/')[-1].split('?')[0]: k for k, u in feed.get('im', {}).items()}
rows = []; hist = {'<300': 0, '300-500': 0, '500-800': 0, '>=800': 0}
for fn in os.listdir(RAW):
    if not fn.lower().endswith(('jpg', 'jpeg', 'png', 'webp')): continue
    try: w, h = Image.open(os.path.join(RAW, fn)).size
    except Exception: continue
    m = max(w, h); hist['<300' if m < 300 else '300-500' if m < 500 else '500-800' if m < 800 else '>=800'] += 1
    rows.append((m, fn))
print('Всего:', len(rows), hist)
print('Самые мелкие (длинная сторона, px | артикул | название):')
for m, fn in sorted(rows)[:25]: k = sku_of.get(fn, '?'); print(' ', m, '|', k, '|', base.get(k, ''))
