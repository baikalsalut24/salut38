#!/usr/bin/env python3
# Отчёт по одной позиции поставщика: что приходит из pyro_goodlist и pyro_good_params -> xlsx
# Запуск: python3 probe-good.py MC143   (ключи из /etc/bs.env, токен из DATA_DIR)
import os, sys, json, urllib.request, urllib.parse
art = (sys.argv[1] if len(sys.argv) > 1 else 'MC143').strip()
D = os.environ.get('DATA_DIR', '/var/lib/bs-data')
BASE = os.environ.get('SALUT_BASE', 'https://system.salut-1.ru').rstrip('/')
ID = os.environ.get('SALUT_ID', '')
tk = json.load(open(os.path.join(D, 'supplier-token.json')))['access_token']
def api(path, **kw):
    kw.update(client_id=ID, token=tk)
    with urllib.request.urlopen(BASE + path + '?' + urllib.parse.urlencode(kw), timeout=120) as r:
        return json.loads(r.read().decode())
gl = api('/api/1.0/pyro_goodlist/', empty_count=1)
items = gl.get('data') or gl.get('goods') or gl
if isinstance(items, dict): items = list(items.values())
low = art.lower()
hit = [g for g in items if low in str(g.get('art', '')).lower() or low in str(g.get('name', '')).lower()]
if not hit: sys.exit('Не найдено: ' + art)
g = hit[0]
try: pr = api('/api/1.0/pyro_good_params/', good_id=g['id'])
except Exception as e: pr = {'error': str(e)}
rows1 = [[k, json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v] for k, v in g.items()]
rows2 = [[p.get('name'), p.get('value'), p.get('unit')] for p in (pr.get('data') or [])] if isinstance(pr, dict) else []
if not rows2: rows2 = [['(нет данных)', json.dumps(pr, ensure_ascii=False)[:500], '']]
print('== pyro_goodlist (' + art + ')')
for r in rows1: print(' ', r[0], '=', r[1])
print('== pyro_good_params')
for r in rows2: print(' ', r[0], '=', r[1], r[2])
try:
    from openpyxl import Workbook
    wb = Workbook(); ws = wb.active; ws.title = 'pyro_goodlist'; ws.append(['Поле', 'Значение'])
    for r in rows1: ws.append(r)
    w2 = wb.create_sheet('pyro_good_params'); w2.append(['Параметр', 'Значение', 'Ед.'])
    for r in rows2: w2.append(r)
    wb.save(f'/tmp/{art}-params.xlsx'); print('xlsx: /tmp/%s-params.xlsx' % art)
except ImportError:
    print('(xlsx не создан: нет openpyxl; данные выше)')
