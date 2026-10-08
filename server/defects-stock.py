# Сколько дефектных товаров сейчас есть в наличии у поставщика. Только чтение, ничего не меняет.
import json, os
D = os.environ.get('DATA_DIR', '/var/lib/bs-data')
def load(n):
    try: return json.load(open(os.path.join(D, n)))
    except Exception: return {}
auto, own, feed = load('defects-auto.json'), load('media-own.json'), load('feed.json')
hd = set(feed.get('hd', []))
names = {}
for a in feed.get('ad', []): names[a['sku']] = a.get('name', '')
for k, v in (feed.get('nm') or {}).items(): names.setdefault(k, v)
try:
    for b in json.load(open('/opt/bs/catalog.json')): names.setdefault(b.get('sku'), b.get('name', ''))
except Exception: pass
rows = []
for sku, a in auto.items():
    o = own.get(sku, {})
    ni = bool(a.get('i')) and not o.get('img') and not o.get('okI')
    nv = bool(a.get('v')) and not o.get('vid') and not o.get('okV')
    if ni or nv: rows.append((sku, ni, nv))
inst = [r for r in rows if r[0] not in hd]
out = [r for r in rows if r[0] in hd]
print('Дефектных всего:', len(rows))
print('  есть в наличии у поставщика:', len(inst))
print('  нет в наличии (скрыты):', len(out))
if inst:
    print('\nВ наличии, но с дефектом (нужна замена):')
    for sku, ni, nv in sorted(inst): print(' ', sku, '|', (names.get(sku) or '')[:50], '|', ('картинка ' if ni else '') + ('видео' if nv else ''))
