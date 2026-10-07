# Проверка КАЖДОЙ картинки и КАЖДОГО видео на водяной знак поставщика по образцам из wm-templates/*.png
# Результат: DATA/hide-auto.txt (артикулы для скрытия), DATA/media-check.csv (артикул;название;нужно видео;нужна картинка)
import json, os, sys, csv, subprocess, tempfile, glob, re
from multiprocessing import Pool
import cv2, numpy as np
DATA = os.environ.get('DATA_DIR', '/var/lib/bs-data'); WWW = '/var/www/salut38'
TPL = ['/opt/bs/wm-templates', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'wm-templates'), os.path.join(DATA, 'wm-templates')]
T = float(os.environ.get('WM_T', '0.62'))
tpls = []
for d in TPL:
    for f in glob.glob(os.path.join(d, '*.png')) + glob.glob(os.path.join(d, '*.jpg')):
        im = cv2.imread(f, cv2.IMREAD_GRAYSCALE)
        if im is not None: tpls.append((os.path.basename(f), im))
cache_f = os.path.join(DATA, 'wm-cache.json')
try: cache = json.load(open(cache_f))
except Exception: cache = {}
sig = '|'.join(sorted('%s:%d' % (n, t.size) for n, t in tpls) + [str(T)])
if cache.get('_sig') != sig: cache = {'_sig': sig}

WM_RE = re.compile(r"s\s*[a4]\s*l\s*[uv]\s*t\s*[-—–_.=]?\s*[1lI|!]", re.I)  # адрес сайта поставщика: salut-1
def ocr_hit(g):  # водяной знак — текст salut-1(.ru/.com): ищем распознаванием текста на нескольких вариантах кадра
    cl = cv2.createCLAHE(clipLimit=4.0, tileGridSize=(8, 8)).apply(g)
    for v in (g, cl, 255 - cl, cv2.resize(cl, None, fx=1.6, fy=1.6, interpolation=cv2.INTER_CUBIC)):
        tmp = tempfile.mktemp(suffix='.png'); cv2.imwrite(tmp, v)
        try:
            for psm in ('11', '6'):
                out = subprocess.run(['tesseract', tmp, 'stdout', '--psm', psm, '-l', 'eng'], capture_output=True, text=True, timeout=60).stdout
                if WM_RE.search(out): return True
        except Exception: pass
        finally:
            if os.path.exists(tmp): os.remove(tmp)
    return False
def score(g):  # g — серый кадр шириной 800
    if ocr_hit(g): return 1.0
    best = 0.0
    for _, t in tpls:
        for sc in (0.6, 0.8, 1.0, 1.25, 1.5):
            tt = cv2.resize(t, None, fx=sc, fy=sc, interpolation=cv2.INTER_AREA if sc < 1 else cv2.INTER_CUBIC)
            if tt.shape[0] >= g.shape[0] or tt.shape[1] >= g.shape[1] or tt.std() < 3: continue
            best = max(best, float(cv2.matchTemplate(g, tt, cv2.TM_CCOEFF_NORMED).max()))
    return best
def prep(im):
    h, w = im.shape[:2]; k = 800.0 / w
    return cv2.cvtColor(cv2.resize(im, None, fx=k, fy=k, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
def img_bad(path):
    im = cv2.imread(path)
    return (score(prep(im)) if im is not None else 0.0)
def vid_bad(path):
    best = 0.0
    for t in ('1', '4', '8'):
        tmp = tempfile.mktemp(suffix='.jpg')
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', t, '-i', path, '-frames:v', '1', tmp])
        im = cv2.imread(tmp)
        if os.path.exists(tmp): os.remove(tmp)
        if im is not None: best = max(best, score(prep(im)))
    return best
def checked(kind, path):
    key = kind + ':' + os.path.basename(path); st = os.path.getsize(path)
    c = cache.get(key)
    if c and c[0] == st: return c[1]
    s = (img_bad if kind == 'i' else vid_bad)(path); cache[key] = [st, round(s, 3)]; return s

feed = json.load(open(os.path.join(DATA, 'feed.json'), encoding='utf-8'))
names = {}
for p in (json.load(open('/opt/bs/catalog.json', encoding='utf-8')) if os.path.exists('/opt/bs/catalog.json') else []): names[p['sku']] = p['name']
names.update(feed.get('nm') or {})
imgs = dict(feed.get('im') or {}); vids = dict(feed.get('vd') or {})
for a in feed.get('ad') or []: imgs[a['sku']] = a['img']; names[a['sku']] = a['name']
loc = lambda u, root: os.path.join(WWW, u.split('?')[0].lstrip('/')) if u else ''
def job(a):
    kind, sku, f = a; return kind, sku, f, checked(kind, f)
bad = {}
jobs = [('i', k, loc(u, WWW)) for k, u in imgs.items()] + [('v', k, loc(u, WWW)) for k, u in vids.items()]
jobs = [j for j in jobs if os.path.exists(j[2])]
with Pool(2) as pl:
    for n, (kind, sku, f, s_) in enumerate(pl.imap_unordered(job, jobs, chunksize=4), 1):
        cache[kind + ':' + os.path.basename(f)] = [os.path.getsize(f), round(s_, 3)]
        if s_ >= T: bad.setdefault(sku, {})[kind] = s_
        if n % 100 == 0: print('...проверено', n, 'из', len(jobs), flush=True)
json.dump(cache, open(cache_f, 'w'))
open(os.path.join(DATA, 'hide-auto.txt'), 'w', encoding='utf-8').write('\n'.join(sorted(bad)) + ('\n' if bad else ''))
with open(os.path.join(DATA, 'media-check.csv'), 'w', encoding='utf-8-sig', newline='') as fh:
    w = csv.writer(fh, delimiter=';'); w.writerow(['Артикул', 'Название', 'Нужно видео', 'Нужна картинка'])
    for sku in sorted(bad): w.writerow([sku, names.get(sku, ''), 'да' if 'v' in bad[sku] else 'нет', 'да' if 'i' in bad[sku] else 'нет'])
print('Проверено картинок: %d, видео: %d | с водяным знаком: %d (порог %.2f)' % (len(imgs), len(vids), len(bad), T))
print('Таблица: ' + os.path.join(DATA, 'media-check.csv'))
