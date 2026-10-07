#!/usr/bin/env node
// Синхронизация с API поставщика САЛЮТ-1: цены, наличие, новые карточки.
//   node sync.js --dry     пробный прогон: только отчёт, ничего не записывается
//   node sync.js           рабочий запуск: записывает DATA_DIR/feed.json (его читает сервер заказов и сайт)
// Ключи берутся из окружения: SALUT_ID, SALUT_SECRET (файл /etc/bs.env). В логи они не попадают.
// Правила владельца:
//   - цена на сайте = price_roz (розничная цена поставщика), округление до рубля
//   - товара нет у поставщика или остаток 0 -> скрыт на сайте
//   - новая карточка создаётся, только если товар есть в наличии, есть картинка и известна категория
//   - количество на сайте не показывается
const fs = require('fs'), path = require('path'), http = require('http'), https = require('https'), crypto = require('crypto');

const DRY = process.argv.includes('--dry');
const BASEURL = (process.env.SALUT_BASE || 'https://system.salut-1.ru').replace(/\/$/, '');
const ID = process.env.SALUT_ID || '', SECRET = process.env.SALUT_SECRET || '';
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const IMGDIR = process.env.IMG_DIR || '/var/www/salut38/img';
const IMGURL = process.env.IMG_URL || '/img';
const VIDDIR = process.env.VIDEO_DIR || '/var/www/salut38/video', VIDURL = process.env.VIDEO_URL || '/video';
const MARKUP = +process.env.PRICE_MARKUP || 1; // 1 = без наценки
const F = { token: path.join(DATA, 'supplier-token.json'), feed: path.join(DATA, 'feed.json'), status: path.join(DATA, 'sync-status.json') };

const MAP = { // категория поставщика -> категория сайта
  'Батареи салютов': 'Батареи салютов', 'Супер-салюты': 'Батареи салютов', 'Римские свечи': 'Римские свечи',
  'Бенгальские свечи': 'Бенгальские свечи', 'Фонтаны': 'Фонтаны', 'Фонтаны (Россия)': 'Фонтаны', 'Ракеты': 'Ракеты',
  'Одиночные салюты': 'Одиночные салюты', 'Дымы и факела': 'Дымы и факела', 'Хлопушки': 'Хлопушки',
  'Пневматические хлопушки': 'Пневматические хлопушки', 'Петарды': 'Петарды', 'Гендер-пати': 'Гендер пати', 'Гендер пати': 'Гендер пати',
  'Летающие, наземные фейерверки и вертушки': 'Летающие петарды',
};

const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const saveAtomic = (f, v, mode) => { const t = f + '.tmp'; fs.writeFileSync(t, typeof v === 'string' ? v : JSON.stringify(v), mode ? { mode } : undefined); fs.renameSync(t, f); };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fail = (msg, code) => { log('ОШИБКА:', msg); try { if (!DRY) saveAtomic(F.status, { ok: false, at: new Date().toISOString(), error: msg }); } catch {} process.exit(code || 1); };

function get(url, { raw, hops = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(u, { headers: { 'user-agent': 'baikalsalut-sync/1.0', accept: raw ? '*/*' : 'application/json' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 4) { res.resume(); return resolve(get(new URL(res.headers.location, u).href, { raw, hops: hops + 1 })); }
      const ch = []; res.on('data', c => ch.push(c));
      res.on('end', () => { const b = Buffer.concat(ch); if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode)); resolve(raw ? b : b.toString('utf8')); });
    });
    req.setTimeout(raw ? 30000 : 90000, () => req.destroy(new Error('таймаут')));
    req.on('error', reject);
  });
}
function download(url, file, hops = 0) { // потоком на диск, без загрузки файла в память
  return new Promise((resolve, reject) => {
    const u = new URL(url), lib = u.protocol === 'http:' ? http : https, tmp = file + '.part';
    const req = lib.get(u, { headers: { 'user-agent': 'baikalsalut-sync/1.0', accept: '*/*' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 4) { res.resume(); return resolve(download(new URL(res.headers.location, u).href, file, hops + 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const out = fs.createWriteStream(tmp); let n = 0;
      res.on('data', c => n += c.length); res.pipe(out);
      out.on('finish', () => { try { if (n < 5000) throw new Error('пустой файл'); fs.renameSync(tmp, file); resolve(n); } catch (e) { try { fs.unlinkSync(tmp) } catch {} reject(e); } });
      const bad = e => { try { out.destroy() } catch {} try { fs.unlinkSync(tmp) } catch {} reject(e); };
      res.on('error', bad); out.on('error', bad);
    });
    req.setTimeout(60000, () => req.destroy(new Error('таймаут')));
    req.on('error', reject);
  });
}
const q = o => Object.keys(o).map(k => k + '=' + encodeURIComponent(o[k])).join('&');
async function getJson(url) { const t = await get(url); try { return JSON.parse(t); } catch { throw new Error('ответ не JSON'); } }

async function token() {
  const now = Math.floor(Date.now() / 1000);
  let t = load(F.token, null);
  if (t && t.access_token && t.expires_in > now + 300) return t.access_token;
  if (t && t.refresh_token) { // продление
    try {
      const r = await getJson(BASEURL + '/oauth2/token/?' + q({ grant_type: 'refresh_token', client_id: ID, refresh_token: t.refresh_token, client_secret: SECRET }));
      if (r.success && r.access_token) { t = { ...t, access_token: r.access_token, expires_in: r.expires_in }; if (!DRY) saveAtomic(F.token, t, 0o600); return t.access_token; }
    } catch (e) { log('продление не удалось, получаем новый доступ:', e.message); }
  }
  const a = await getJson(BASEURL + '/oauth2/autorize/?' + q({ response_type: 'code', client_id: ID }));
  if (!a.success || !a.code) throw new Error('поставщик не выдал временный код (проверьте CLIENT_ID)');
  const r = await getJson(BASEURL + '/oauth2/token/?' + q({ grant_type: 'authorization_code', client_id: ID, code: a.code, client_secret: SECRET, scopes: 'pyro_catlist,pyro_goodlist' }));
  if (!r.success || !r.access_token) throw new Error('поставщик не выдал ключ доступа (проверьте CLIENT_SECRET)');
  t = { access_token: r.access_token, refresh_token: r.refresh_token, expires_in: r.expires_in };
  if (!DRY) saveAtomic(F.token, t, 0o600);
  return t.access_token;
}

const stockOf = v => { // "20+" -> 20; пусто, 0, «нет» -> 0
  if (v === null || v === undefined) return 0;
  const s = String(v).trim().toLowerCase(); if (!s) return 0;
  const m = s.match(/^\d+/); if (m) return +m[0];
  return /нет|отсутств|ожида/.test(s) ? 0 : 1; // непонятный текст («много», «в наличии») = есть
};
const cleanName = n => String(n || '').replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim(); // скобки и всё в них убираем
const calOf = k => (Array.isArray(k) ? k : k ? [k] : []).map(x => String(x).trim().replace('.', ',')).filter(Boolean).join('-');
const money = v => { const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.')); return n > 0 ? Math.round(n * MARKUP) : 0; };

async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); }

async function main() {
  if (!ID || !SECRET) { log('Ключи поставщика не заданы (SALUT_ID / SALUT_SECRET), синхронизация пропущена.'); process.exit(0); }
  fs.mkdirSync(DATA, { recursive: true });
  const base = load(path.join(__dirname, 'catalog.json'), []);
  if (!base.length) fail('не найден catalog.json');
  const prev = load(F.feed, null);

  log(DRY ? 'Пробный прогон (ничего не записывается)' : 'Синхронизация с поставщиком');
  let list;
  try {
    const tk = await token();
    const r = await getJson(BASEURL + '/api/1.0/pyro_goodlist/?' + q({ client_id: ID, token: tk }));
    if (!r.success || !Array.isArray(r.data)) throw new Error('поставщик вернул ошибку вместо списка товаров');
    list = r.data;
  } catch (e) { return fail('не удалось получить данные поставщика: ' + e.message, 2); }
  log('Получено строк от поставщика:', list.length);

  // защита: пустая или резко уменьшившаяся выгрузка не должна обнулить сайт
  const prevN = prev && prev.apiN || 0;
  if (list.length < 20 || (prevN && list.length < prevN * 0.5)) return fail(`подозрительно мало товаров у поставщика (${list.length}, раньше ${prevN}); сайт не изменён`, 3);

  const api = new Map(), dup = new Set();
  for (const it of list) {
    const art = String(it.art || '').trim(); if (!art) continue;
    const row = { it, st: stockOf(it.sklad), price: money(it.price_roz) };
    if (api.has(art)) { dup.add(art); const o = api.get(art); if ((row.st > 0 && o.st === 0) || (row.st > 0 && o.st > 0 && row.price && row.price < o.price)) api.set(art, row); } else api.set(art, row);
  }

  const pr = {}, hd = [], diffs = [], inBase = new Set(base.map(b => b.sku));
  let same = 0, noPrice = 0;
  for (const b of base) {
    const r = api.get(b.sku);
    if (!r || r.st <= 0) { hd.push(b.sku); continue; }
    if (!(r.price > 0)) { noPrice++; continue; }
    pr[b.sku] = r.price;
    if (r.price === b.price) same++; else diffs.push({ sku: b.sku, name: b.name, from: b.price, to: r.price, raw: r.it.price_roz, uc: r.it.unit_count, un: r.it.unit_name, pct: (r.price - b.price) / b.price });
  }

  // новые карточки
  const sk = { stock: 0, noimg: 0, nocat: 0, noprice: 0, cats: {} }, cand = [];
  for (const [art, r] of api) {
    if (inBase.has(art)) continue;
    const it = r.it;
    if (r.st <= 0) { sk.stock++; continue; }
    if (!it.img) { sk.noimg++; continue; }
    const cat = MAP[String(it.category_name || '').trim()];
    if (!cat) { sk.nocat++; sk.cats[it.category_name] = (sk.cats[it.category_name] || 0) + 1; continue; }
    if (!(r.price > 0)) { sk.noprice++; continue; }
    cand.push({ art, it, cat, price: r.price });
  }
  const ad = [];
  if (!DRY && cand.length) {
    try { fs.mkdirSync(IMGDIR, { recursive: true }); } catch (e) { log('нет папки для картинок:', e.message); }
  }
  await pool(cand, 4, async c => {
    const ext = (String(c.it.img).split('?')[0].match(/\.(jpe?g|png|webp)$/i) || [, 'jpg'])[1].toLowerCase();
    const fn = crypto.createHash('md5').update(c.art).digest('hex').slice(0, 12) + '.' + ext, file = path.join(IMGDIR, fn);
    if (!DRY) {
      if (!fs.existsSync(file)) {
        try { const b = await get(c.it.img, { raw: true }); if (b.length < 500) throw new Error('пустая картинка'); fs.writeFileSync(file, b); }
        catch (e) { sk.noimg++; return; }
      }
    }
    ad.push({ sku: c.art, name: cleanName(c.it.name) || c.art, price: c.price, cats: [c.cat], brand: String(c.it.prod || '').trim(), shots: parseInt(c.it.vystrel, 10) || 0, cal: calOf(c.it.kalibr), img: IMGURL + '/' + fn });
  });
  ad.sort((a, b) => a.price - b.price);

  // свои копии картинок и видео поставщика для всех товаров в наличии (на нашем сервере)
  const im = {}, vd = {}, md = { img: 0, vid: 0, fail: 0 };
  const have = [...base.filter(b => pr[b.sku]).map(b => ({ art: b.sku, it: api.get(b.sku).it })), ...cand.filter(c => ad.some(a => a.sku === c.art))];
  const fetchFile = async (url, dir, art, defExt, okExts, minB, stream) => {
    const ext = (String(url).split('?')[0].match(/\.([a-z0-9]{2,4})$/i) || [, defExt])[1].toLowerCase();
    if (!okExts.includes(ext)) return null;
    const fn = crypto.createHash('md5').update(art).digest('hex').slice(0, 12) + '.' + ext, file = path.join(dir, fn);
    if (fs.existsSync(file)) return fn;
    if (DRY) return fn;
    try { if (stream) await download(url, file); else { const b = await get(url, { raw: true }); if (b.length < minB) throw 0; fs.writeFileSync(file, b); } return fn; } catch { md.fail++; return null; }
  };
  if (!DRY) { try { fs.mkdirSync(IMGDIR, { recursive: true }); fs.mkdirSync(VIDDIR, { recursive: true }); } catch (e) { log('нет папки для медиа:', e.message); } }
  await pool(have, 4, async h => {
    if (h.it.img) { const f = await fetchFile(h.it.img, IMGDIR, h.art, 'jpg', ['jpg', 'jpeg', 'png', 'webp'], 500, false); if (f) { im[h.art] = IMGURL + '/' + f; md.img++; } }
    if (h.it.video_mp4) { const f = await fetchFile(h.it.video_mp4, VIDDIR, h.art, 'mp4', ['mp4'], 5000, true); if (f) { vd[h.art] = VIDURL + '/' + f; md.vid++; } }
  });
  log('Свои копии на сервере: картинок', md.img, '| видео', md.vid, '| ошибок скачивания', md.fail);

  diffs.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  log('--- ИТОГ ---');
  log('Товаров в каталоге сайта:', base.length, '| цена та же:', same, '| цена изменится:', diffs.length, '| будут скрыты (нет у поставщика):', hd.length, '| без цены у поставщика (цена не меняется):', noPrice);
  log('Новых карточек (в наличии, есть картинка, категория известна):', ad.length || cand.length);
  log('Пропущено новых: нет в наличии', sk.stock, '| нет картинки', sk.noimg, '| неизвестная категория', sk.nocat, '| нет цены', sk.noprice);
  if (Object.keys(sk.cats).length) log('Неизвестные категории:', Object.entries(sk.cats).map(([k, v]) => k + ' ×' + v).join('; '));
  if (dup.size) log('Повторяющихся артикулов у поставщика:', dup.size, '(берётся позиция в наличии с меньшей ценой)');
  if (diffs.length) { log('Самые большие изменения цены:'); diffs.slice(0, 12).forEach(d => log('  ' + d.sku, '|', d.name.slice(0, 32), '|', d.from, '->', d.to, '(' + (d.pct > 0 ? '+' : '') + Math.round(d.pct * 100) + '%)', '| поставщик: price_roz=' + d.raw + ', в упаковке ' + d.uc + ' ' + d.un)); }
  if (DRY) { log('Пробный прогон завершён, файл не записан.'); return; }

  if (!prev && hd.length > base.length * 0.5 && !process.argv.includes('--force')) return fail(`при первом запуске скрылось бы ${hd.length} из ${base.length} товаров: похоже на неполную выгрузку. Проверьте пробным прогоном (--dry); если так и должно быть, запустите с --force`, 4);
  saveAtomic(F.feed, { t: Date.now(), apiN: list.length, im, vd, pr, hd, ad });
  saveAtomic(F.status, { ok: true, at: new Date().toISOString(), apiN: list.length, changed: diffs.length, hidden: hd.length, added: ad.length });
  log('Готово: данные записаны, сайт обновится сам.');
}
main().catch(e => fail(e.message || String(e)));
