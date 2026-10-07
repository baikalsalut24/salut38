#!/usr/bin/env python3
"""Выравнивание картинок товаров: обрезаем белые поля, вписываем товар в квадрат 800x800 с одинаковыми отступами.
Оригиналы сохраняются в RAW_DIR. Запуск: normalize.py IMG_DIR RAW_DIR [--all]"""
import sys, os, json, shutil
from PIL import Image, ImageChops, ImageFilter
SIZE, FILL, THR = 800, 0.88, 18
img_dir, raw_dir = sys.argv[1], sys.argv[2]; force = '--all' in sys.argv
os.makedirs(raw_dir, exist_ok=True)
mark = os.path.join(raw_dir, '.normalized.json')
try: done = set(json.load(open(mark))) if not force else set()
except Exception: done = set()
n = bad = 0; small = []; hist = {'<300': 0, '300-500': 0, '500-800': 0, '>=800': 0}
for fn in sorted(os.listdir(img_dir)):
    ext = fn.rsplit('.', 1)[-1].lower() if '.' in fn else ''
    if ext not in ('jpg', 'jpeg', 'png', 'webp') or fn in done: continue
    dst, raw = os.path.join(img_dir, fn), os.path.join(raw_dir, fn)
    try:
        if not os.path.exists(raw): shutil.copy2(dst, raw)
        im = Image.open(raw); im.load()
        if im.mode in ('RGBA', 'LA', 'P'):
            im = im.convert('RGBA'); bg = Image.new('RGB', im.size, (255, 255, 255)); bg.paste(im, mask=im.split()[3]); im = bg
        else: im = im.convert('RGB')
        diff = ImageChops.difference(im, Image.new('RGB', im.size, (255, 255, 255))).convert('L').point(lambda p: 255 if p > THR else 0)
        box = diff.getbbox()
        if box and (box[2] - box[0]) > 20 and (box[3] - box[1]) > 20: im = im.crop(box)
        w, h = im.size; k = SIZE * FILL / max(w, h); m = max(w, h)
        hist['<300' if m < 300 else '300-500' if m < 500 else '500-800' if m < 800 else '>=800'] += 1
        if m < 400: small.append((m, fn))
        im = im.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)
        if k > 1.15: im = im.filter(ImageFilter.UnsharpMask(radius=1.4, percent=70, threshold=3))  # увеличенные картинки слегка подтягиваем по резкости
        out = Image.new('RGB', (SIZE, SIZE), (255, 255, 255)); out.paste(im, ((SIZE - im.size[0]) // 2, (SIZE - im.size[1]) // 2))
        tmp = dst + '.tmp'
        out.save(tmp, 'PNG' if ext == 'png' else 'WEBP' if ext == 'webp' else 'JPEG', **({} if ext == 'png' else {'quality': 86}))
        os.replace(tmp, dst); done.add(fn); n += 1
    except Exception as e:
        bad += 1; print('не удалось', fn, e)
json.dump(sorted(done), open(mark, 'w'))
print('картинок выровнено:', n, '| ошибок:', bad)
print('размер исходников по длинной стороне (после обрезки полей):', hist)
for m, fn in sorted(small)[:15]: print('  мелкая:', fn, m, 'px')
