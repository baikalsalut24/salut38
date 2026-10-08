#!/usr/bin/env python3
# Какие названия параметров вообще бывают в pyro_good_params (ищем «финал» и др.). Запуск: python3 params-scan.py [сколько товаров, по умолчанию 150]
import os, sys, json, time, urllib.request, urllib.parse, collections
D = os.environ.get('DATA_DIR', '/var/lib/bs-data'); BASE = os.environ.get('SALUT_BASE', 'https://system.salut-1.ru').rstrip('/'); ID = os.environ.get('SALUT_ID', '')
t = json.load(open(os.path.join(D, 'supplier-token.json'))); tk = t['access_token']
print('Права ключа:', ', '.join(t.get('scopes') or ['(не записаны — выполните sync.js --auth)']))
def api(p, **kw):
    kw.update(client_id=ID, token=tk)
    with urllib.request.urlopen(BASE + p + '?' + urllib.parse.urlencode(kw), timeout=120) as r: return json.loads(r.read().decode())
items = api('/api/1.0/pyro_goodlist/')['data']
n = int(sys.argv[1]) if len(sys.argv) > 1 else 150
bat = [g for g in items if g.get('category_name') in ('Батареи салютов', 'Супер-салюты', 'Римские свечи')]
other = [g for g in items if g not in bat]
pick = (bat[:n * 2 // 3] + other[:n // 3])
cnt = collections.Counter(); ex = {}; fin = []
for i, g in enumerate(pick):
    try: d = api('/api/1.0/pyro_good_params/', good_id=g['id']).get('data') or []
    except Exception as e: print('Ошибка', g['art'], e); break
    for p in d:
        cnt[p.get('name')] += 1; ex.setdefault(p.get('name'), p.get('value'))
        if 'финал' in (str(p.get('name')) + str(p.get('value'))).lower(): fin.append((g['art'], p.get('name'), p.get('value')))
    time.sleep(0.15)
print('Проверено товаров:', len(pick))
for k, v in cnt.most_common(): print(f'{v:4d}  {k}  (пример: {str(ex[k])[:60]})')
print('\nСо словом «финал»:', len(fin))
for f in fin[:15]: print(' ', f)
