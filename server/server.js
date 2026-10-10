// Байкал Салют · сервер заказов и мобильного приложения для сотрудников.
// Без зависимостей, нужен Node 18+. Запуск:  node server.js
//   PORT=8080 node server.js        (порт, по умолчанию 8080)
//   DATA_DIR=./data                 (где хранятся заказы и сотрудники)
// Что делает:
//   POST /order        принимает заказ с сайта (window.ORDER_URL='https://ВАШ-ДОМЕН/order')
//   POST /cart         сайт: клиент нажал «Далее» → корзина попадает в «Брошенные»; при заказе переносится в обычные
//   GET  /catalog      сайт узнаёт, какие товары скрыты и какие цены выставлены в приложении (вкладка «Товары»)
//   GET  /promo/check  сайт проверяет промокод (действует ли), скидку считает сам по сетке
//   /                  мобильное приложение (папка public)
//   /api/...           вход по PIN, заказы, статусы, сводка, сотрудники, промокоды
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = +process.env.PORT || 8080;
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUB = path.join(__dirname, 'public');
fs.mkdirSync(DATA, { recursive: true });

/* ---------- хранилище ---------- */
const F = { orders: path.join(DATA, 'orders.json'), users: path.join(DATA, 'users.json'), sessions: path.join(DATA, 'sessions.json'), promos: path.join(DATA, 'promos.json'), carts: path.join(DATA, 'carts.json'), catalog: path.join(DATA, 'catalog.json'), cardcfg: path.join(DATA, 'card-cfg.json') };
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const save = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };
let cardCfg = load(F.cardcfg, null) || { type: 'tiers', value: null, until: '', active: true}; // общие настройки всех дисконтных карт
let orders = load(F.orders, {}), users = load(F.users, null), sessions = load(F.sessions, {}), promos = load(F.promos, null), carts = load(F.carts, {}), cat = load(F.catalog, {}); // cat: правки каталога {sku:{p:цена,h:1 скрыт,by,at}}
const BASE0 = load(path.join(__dirname, 'catalog.json'), []); // базовый каталог (файл catalog.json)
// Выгрузка поставщика (САЛЮТ-1): цены, скрытые товары и новые карточки. Пишет sync.js в DATA/feed.json
const FEEDF = path.join(DATA, 'feed.json');
// Дефекты медиа: DATA/defects-auto.json пишет проверка (wm-check.py): {sku:{i:'wm'|'low',v:'wm'}}; свои фото/видео из приложения — DATA/media-own.json
const AUTOF = path.join(DATA, 'defects-auto.json'), OWNF = path.join(DATA, 'media-own.json');
const IMGDIR = process.env.IMG_DIR || '/var/www/salut38/img', VIDDIR = process.env.VIDEO_DIR || '/var/www/salut38/video', RAWDIR = process.env.IMG_RAW_DIR || path.join(DATA, 'img-orig');
let AUTO = {}, autoM = 0, OWN = load(OWNF, {}), RAWFEED = null;
const defectOf = sku => { const a = AUTO[sku]; if (!a) return null; const o = OWN[sku] || {}; const ni = !!a.i && !o.img && !o.okI, nv = !!a.v && !o.vid && !o.okV; return ni || nv ? { ni, nv, ri: a.i || '', rv: a.v || '', hide: (ni && a.i === 'wm') || (nv && a.v === 'wm') } : null };
function applyFeed() { // лента поставщика + дефекты + свои фото/видео
  const f = RAWFEED; if (!f) return;
  const im = { ...f.im }, vd = { ...f.vd }, hd = new Set(f.hd);
  for (const k in OWN) { if (OWN[k].img) im[k] = OWN[k].img; if (OWN[k].vid) vd[k] = OWN[k].vid }
  for (const k in AUTO) { const d = defectOf(k); if (d && d.hide) hd.add(k) } // скрываем только водяной знак; мелкая картинка остаётся на сайте (жёлтый светофор)
  FEED = { t: f.t, im, vd, nm: f.nm, fn: f.fn, pr: f.pr, hd: [...hd], ad: f.ad };
  BASE = BASE0.map(b => ({ ...b, ...(FEED.pr[b.sku] > 0 ? { price: FEED.pr[b.sku] } : {}), ...(FEED.nm[b.sku] ? { name: FEED.nm[b.sku] } : {}), ...(FEED.im[b.sku] ? { img: FEED.im[b.sku] } : {}) })).concat(f.ad.map(a => ({ ...a, ...(FEED.im[a.sku] ? { img: FEED.im[a.sku] } : {}) })));
}
let DURC = { m: 0, d: {} };
let GPC = { m: 0, d: {} };
function gpData() { // характеристики от поставщика: sku -> [[имя, значение, ед.]]
  let m = 0; try { m = fs.statSync(path.join(DATA, 'good-params.json')).mtimeMs } catch {}
  if (m !== GPC.m) { GPC = { m, d: load(path.join(DATA, 'good-params.json'), {}) || {} } }
  return GPC.d;
}
const secOf = v => { const s = String(v || '').trim(); let m = s.match(/^(\d+):(\d{1,2})$/); if (m) return +m[1] * 60 + +m[2]; m = s.match(/^\d+$/); return m ? +s : 0 };
const durFmt = s => s >= 60 ? Math.floor(s / 60) + ' мин' + (s % 60 ? ' ' + s % 60 + ' с' : '') : s + ' с';
const PM_SKIP = /^(производитель|кол-во выстрелов|калибр)$/i; // уже показаны в карточке
function pmMap() { // sku -> [[название, значение]] для карточки товара
  const out = {}, d = gpData();
  for (const k in d) {
    const rows = [];
    for (const [n, v, u] of d[k].p || []) {
      if (PM_SKIP.test(n)) continue;
      const nm = n.charAt(0).toUpperCase() + n.slice(1);
      rows.push([nm, /время работы/i.test(n) && secOf(v) ? durFmt(secOf(v)) : (v + (u && u !== '"' ? ' ' + u : '')).replace(/\s+/g, ' ').trim()]);
    }
    if (rows.length) out[k] = rows;
  }
  return out;
}
function durMap() { // sku -> секунды работы: «время работы» от поставщика, иначе длина ролика минус 2 с заставки
  let m = 0; try { m = fs.statSync(path.join(DATA, 'video-dur.json')).mtimeMs } catch {}
  if (m !== DURC.m) { DURC = { m, d: load(path.join(DATA, 'video-dur.json'), {}) || {} } }
  const out = {}, gp = gpData();
  for (const k in FEED.vd) { const e = DURC.d[String(FEED.vd[k]).split('/').pop()]; if (e && e.d > 2) out[k] = Math.max(1, e.d - 2) }
  for (const k in gp) { const w = (gp[k].p || []).find(x => /^время работы$/i.test(x[0])); if (w && secOf(w[1]) > 0) out[k] = secOf(w[1]) }
  return out;
}
let FEED = { t: 0, im: {}, vd: {}, nm: {}, fn: {}, pr: {}, hd: [], ad: [] }, feedM = 0, feedChk = 0, BASE = BASE0;
function refreshFeed() {
  const now = Date.now(); if (now - feedChk < 5000) return; feedChk = now;
  let m = 0, am = 0; try { m = fs.statSync(FEEDF).mtimeMs } catch {} try { am = fs.statSync(AUTOF).mtimeMs } catch {}
  if (m === feedM && am === autoM) return;
  if (am !== autoM) { autoM = am; AUTO = load(AUTOF, {}) || {} }
  if (m === feedM) return applyFeed(); feedM = m;
  const f = load(FEEDF, null); if (!f || typeof f !== 'object') return;
  RAWFEED = { t: +f.t || 0, im: f.im || {}, vd: f.vd || {}, nm: f.nm || {}, fn: f.fn || {}, pr: f.pr || {}, hd: Array.isArray(f.hd) ? f.hd : [], ad: Array.isArray(f.ad) ? f.ad : [] };
  applyFeed();
}
refreshFeed();

if (!promos) { // первый запуск: единый бессрочный промокод для всех покупателей
  promos = [{ code: 'БАЙКАЛСАЛЮТ01', aliases: ['БАЙКАСАЛЮТ01'], kind: 'promo', type: 'tiers', value: null, until: '', note: 'Единый промокод для всех покупателей, бессрочный', active: true, createdAt: new Date().toISOString(), by: 'Система' }];
  save(F.promos, promos);
}
{ // единый код принимается в двух написаниях: БайкалСалют01 и БайкаСалют01
  const NEW = 'БАЙКАЛСАЛЮТ01', OLD = 'БАЙКАСАЛЮТ01';
  const old = promos.find(p => p.code === OLD);
  if (old && !promos.some(p => p.code === NEW)) { old.code = NEW; old.aliases = [OLD]; save(F.promos, promos) }
}

const hashPin = (pin, salt = crypto.randomBytes(8).toString('hex')) => ({ salt, hash: crypto.scryptSync(String(pin), salt, 32).toString('hex') });
const checkPin = (u, pin) => { const h = crypto.scryptSync(String(pin), u.salt, 32); const b = Buffer.from(u.hash, 'hex'); return b.length === h.length && crypto.timingSafeEqual(h, b); };
const uid = () => crypto.randomBytes(4).toString('hex');
if (!users) {
  const mk = (name, role, pin) => ({ id: uid(), name, role, ...hashPin(pin) });
  users = [mk('Владелец', 'admin', '0000')];
  save(F.users, users);
  console.log('Создан владелец с PIN по умолчанию 0000. Смените PIN в приложении (вкладка «Команда»).');
}
// остаётся только роль «Владелец»: сотрудников с другими ролями убираем (роли будут собраны отдельно)
if (users.some(u => u.role !== 'admin')) { users = users.filter(u => u.role === 'admin'); if (!users.length) users.push({ id: uid(), name: 'Владелец', role: 'admin', ...hashPin('0000') }); save(F.users, users); console.log('Роли кроме «Владелец» удалены, сотрудников:', users.length); }

/* ---------- роли и статусы ---------- */
const ROLES = { admin: 'Владелец' }; // пока одна роль с полными правами; остальные роли будут собраны отдельно
const STATUS = {
  new: 'Новый', confirmed: 'В обработке', picking: 'Размещён', packed: 'Собран',
  shipping: 'В доставке', delivered: 'Отгружен', failed: 'Не доставлен', cancelled: 'Отменён'
};
const PAY = { unpaid: 'Не оплачен', partial: 'Частично оплачен', paid: 'Оплачен' }; // статус оплаты — отдельно от статуса заказа
const M = ['admin'];
// из какого статуса, в какой, кому можно
const FLOW = [
  ['new', 'confirmed', M], ['new', 'cancelled', M],
  ['confirmed', 'picking', [...M, 'storekeeper']], ['confirmed', 'cancelled', M],
  ['picking', 'packed', [...M, 'storekeeper']], ['picking', 'confirmed', [...M, 'storekeeper']], ['picking', 'cancelled', M],
  ['packed', 'shipping', [...M, 'courier']], ['packed', 'picking', [...M, 'storekeeper']], ['packed', 'cancelled', M],
  ['shipping', 'delivered', [...M, 'courier']], ['shipping', 'failed', [...M, 'courier']],
  ['failed', 'shipping', [...M, 'courier']], ['failed', 'cancelled', M]
];
const canMove = (role, from, to) => FLOW.some(([f, t, r]) => f === from && t === to && r.includes(role));
const nextFor = (role, from) => FLOW.filter(([f, , r]) => f === from && r.includes(role)).map(x => x[1]);
// какие статусы видит роль
const SEES = { admin: null };

/* ---------- промокоды и дисконтные карты ---------- */
const normCode = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\s]/g, '').toUpperCase().slice(0, 30);
const TIER = t => t < 5000 ? 5 : t < 20000 ? 10 : t < 50000 ? 15 : t < 100000 ? 20 : t < 500000 ? 25 : 30; // система скидок по сумме заказа
const promoDiscount = (p, total) => p.min > 0 && total < p.min ? 0 : p.type === 'percent' ? Math.round(total * p.value / 100) : p.type === 'amount' ? Math.min(Math.round(p.value), total) : Math.round(total * TIER(total) / 100);
const cleanSlug = v => { const t = String(v == null ? '' : v).trim().toLowerCase(); return t === '' ? '' : /^[a-z0-9_-]{2,40}$/.test(t) ? t : null }; // метка для ссылки на бота: t.me/бот?start=promo_МЕТКА
const irkToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const CLAIMS = new Map(); // метка сайта → номер карты (живёт час, только в памяти)
const SNAPS = new Map(); // метка сайта → корзина (сутки, в памяти): чтобы корзина открылась и в другом браузере после бота
const snapCart = it => { const o = {}; let n = 0; for (const [k, v] of Object.entries(it && typeof it === 'object' ? it : {})) { const q = Math.floor(+v); if (/^[\p{L}\p{N}_.\-\/]{1,40}$/u.test(k) && q > 0 && q <= 999 && n++ < 200) o[k] = q } return o };
const claimCard = (sid, code) => { CLAIMS.set(String(sid).toLowerCase(), { code, at: Date.now() }); if (CLAIMS.size > 20000) for (const [k, v] of CLAIMS) if (Date.now() - v.at > 36e5) CLAIMS.delete(k) };
const BOT_MIN = { 5: 0, 10: 5000, 15: 20000, 20: 50000, 25: 100000, 30: 500000 }; // как в таблице «скидки» в боте (и на InSales)
for (const v of [5, 10, 15, 20, 25, 30]) { // старые промокоды из BotHelp: остаются рабочими; создаются, только если их ещё нет
  const code = 'БОТ' + String(v).padStart(2, '0');
  if (!promos.some(x => x.code === code || (x.aliases || []).includes(code))) { promos.push({ code, kind: 'promo', type: 'percent', value: v, until: '', note: 'Из BotHelp: скидка ' + v + '% по сумме заказа', active: true, createdAt: new Date().toISOString(), by: 'система', min: BOT_MIN[v] }); save(F.promos, promos) }
  else { const p = promos.find(x => x.code === code); if (p && p.min == null) { p.min = BOT_MIN[v]; save(F.promos, promos) } } // порог от суммы — один раз, дальше меняется в приложении
}
{ // САЛЮТ15 — 15% по ссылке t.me/Salut38_bot?start=promo_salut15 (окно «15% скидка» на старом сайте); создаётся, только если ещё нет
  let p = promos.find(x => x.code === 'САЛЮТ15' || (x.aliases || []).includes('САЛЮТ15'));
  if (!p) { promos.push({ code: 'САЛЮТ15', kind: 'promo', type: 'percent', value: 15, until: '', note: 'Скидка 15% (ссылка из окна на сайте)', active: true, createdAt: new Date().toISOString(), by: 'система', slug: 'salut15' }); save(F.promos, promos) }
  else if (!p.slug && !promos.some(x => x.slug === 'salut15')) { p.slug = 'salut15'; save(F.promos, promos) }
}
{ // однократный перенос промокодов из InSales (все — многоразовые, скидка в % от суммы заказа); повторно не создаются, даже если их удалят
  const MARK = path.join(DATA, '.insales-promos-done');
  if (!fs.existsSync(MARK)) {
    const L = [['ЖЕМЧУЖИНА', 15, '', false, 'InSales: только категории «Салюты от 1.500 до 3.000 р.», «Салюты до 1.500 р.», «Батареи салютов» — здесь ограничения по категориям нет, поэтому код выключен'],
      ['ИЮНЬ26', 15, '', true, ''], ['ВЕСНА26', 15, '2026-05-31', true, ''], ['2ГИС', 15, '', true, ''], ['САЛЮТ1025', 10, '', true, ''], ['6С', 15, '', true, ''],
      ['НГ25', 16, '', true, ''], ['КОНЬ', 16, '', true, ''], ['САЛЮТ2415', 15, '', true, ''], ['111125', 20, '2025-11-30', true, 'Чёрная пятница'], ['SALE15', 15, '', true, ''], ['ЯНДЕКС', 15, '', true, '']];
    for (const [code, v, until, on, note] of L) if (!promos.some(x => x.code === code || (x.aliases || []).includes(code)))
      promos.push({ code, kind: 'promo', type: 'percent', value: v, until, note: 'Из InSales' + (note ? ': ' + note : ''), active: on, createdAt: new Date().toISOString(), by: 'система' });
    save(F.promos, promos); try { fs.writeFileSync(MARK, new Date().toISOString()) } catch {}
  }
}
const promoState = p => !p.active ? 'paused' : (p.until && p.until < irkToday() ? 'expired' : 'ok');
const findPromo = code => { const c = normCode(code); return c ? promos.find(p => p.code === c || (p.aliases || []).includes(c)) : null };
const promoPub = p => { const used = Object.values(orders).filter(o => o.status !== 'cancelled' && [p.code, ...(p.aliases || [])].includes(normCode(o.promo))); return { ...p, state: promoState(p), uses: used.length, sum: used.reduce((s, o) => s + o.total, 0), disc: used.reduce((s, o) => s + (o.discount || 0), 0) } };

function view(o, role) {
  const v = { ...o, next: nextFor(role, o.status) };
  v.items = o.items.map(i => ({ ...i, cat: catOf(i.sku)[0] || '' }));
  if (o.subst && o.subst.length) v.subst = o.subst.map(c => ({ ...c, a: prodInfo(c.sku, c.name, c.price), b: c.offer ? prodInfo(c.offer.sku, c.offer.name, c.offer.price) : null }));
  if (o.subst && o.subst.length && M.includes(role)) { v.rlink = o.rt ? APP_BASE() + '/r/' + o.rt : ''; v.rp = o.rp ? { sentAt: o.rp.sentAt || '', due: o.rp.due || '', rem: o.rp.rem || 0, cold: !!o.rp.cold } : null }
  v.site = SITE_BASE();
  if (o.notify) v.notify = { channel: o.notify.channel, email: o.notify.email || '', linked: !!o.notify.linked };
  if (M.includes(role) && o.promo) { const p = findPromo(o.promo), base = o.items.reduce((s, i) => s + i.sum, 0); v.promoInfo = p ? { state: o.discount > 0 ? 'applied' : promoState(p) === 'ok' && p.min > base ? 'min' : promoState(p), min: p.min || 0, kind: p.kind, type: p.type, value: p.value, discount: o.discount > 0 ? o.discount : promoDiscount(p, base) } : { state: 'unknown' } }
  if (role === 'storekeeper') { delete v.consentAt; delete v.notify; delete v.pay; delete v.paid; delete v.discountNote; delete v.phone; delete v.address; delete v.name; delete v.comment; delete v.promo; v.items = o.items.map(i => ({ ...i })); }
  if (role === 'courier') { v.items = o.items.map(({ sku, name, qty }) => ({ sku, name, qty })); }
  return v;
}


/* ---------- дефектные товары: водяной знак поставщика / мелкая картинка. Свои фото и видео грузятся из приложения ---------- */
const saveRaw = (req, file, max) => new Promise((ok, no) => {
  let n = 0, dead = false; const tmp = file + '.part', out = fs.createWriteStream(tmp);
  const fail = e => { if (dead) return; dead = true; try { req.unpipe(out); out.destroy() } catch {} fs.unlink(tmp, () => {}); no(e) };
  req.on('data', c => { n += c.length; if (n > max) { fail(Object.assign(new Error('big'), { big: 1 })); req.resume() } });
  req.on('error', fail); out.on('error', fail); req.on('aborted', () => fail(new Error('aborted')));
  out.on('finish', () => { if (dead) return; if (n < 1000) return fail(new Error('empty')); try { fs.renameSync(tmp, file); ok(n) } catch (e) { fail(e) } });
  req.pipe(out);
});
const saveOwn = () => { save(OWNF, OWN); applyFeed() };
const dropFile = u => { if (!u) return; const f = String(u).split('?')[0].split('/').pop(); if (!/^own-/.test(f)) return; for (const d of [IMGDIR, VIDDIR, RAWDIR]) fs.unlink(path.join(d, f), () => {}) };
const normImgs = () => new Promise(r => require('child_process').execFile('python3', [path.join(__dirname, 'normalize.py'), IMGDIR, RAWDIR], { timeout: 120e3 }, () => r()));
const defRow = (sku, b) => { const a = AUTO[sku] || {}, o = OWN[sku] || {}, d = defectOf(sku); return { sku, name: b.name, cat: (b.cats || [])[0] || '', price: b.price, img: FEED.im[sku] || b.img || '', ni: !!(d && d.ni), nv: !!(d && d.nv), ri: a.i || '', rv: a.v || '', ownImg: !!o.img, ownVid: !!o.vid, okI: !!o.okI, okV: !!o.okV, open: !!d, hide: !!(d && d.hide), hasVid: !!(FEED.vd[sku]), by: o.by || '', at: o.at || '' } };

/* ---------- утилиты ---------- */
const send = (res, code, body, extra = {}) => { const s = typeof body === 'string' ? body : JSON.stringify(body); res.writeHead(code, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }); res.end(s) };
const body = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 200e3) { req.destroy(); no(new Error('big')) } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}) } catch (e) { no(e) } }); req.on('error', no) });
const hits = new Map();
const limit = (key, n, ms) => { const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < ms); a.push(now); hits.set(key, a); return a.length > n };
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some(t => now - t < 3600e3)) hits.delete(k) }, 600e3).unref();
const ipOf = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,authorization', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS' };
const auth = req => { const t = (req.headers.authorization || '').replace(/^Bearer /, ''); const s = sessions[t]; if (!s || s.exp < Date.now()) return null; const u = users.find(x => x.id === s.uid); return u ? { ...u, token: t } : null };
const pub = u => ({ id: u.id, name: u.name, role: u.role, roleName: ROLES[u.role] });
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
for (const k in orders) { const o = orders[k]; if (!PAY[o.pay]) o.pay = o.paid ? 'paid' : 'unpaid'; o.paid = o.pay === 'paid' }
const persist = () => save(F.orders, orders);
const persistC = () => save(F.carts, carts);
const persistCat = () => save(F.catalog, cat);

/* ---------- уведомления клиента о статусе ---------- */
// Telegram: TG_TOKEN (токен бота от @BotFather) и TG_BOT (имя бота без @). Без них клиент выбирает канал, а менеджер видит выбор в заказе.
// MAX и почта: выбор сохраняется, отправка включается после подключения (токен бота MAX / SMTP).
const TG = process.env.TG_TOKEN || '', TG_BOT = process.env.TG_BOT || '', TG_API = process.env.TG_API || 'https://api.telegram.org';
const MAX_BOT = process.env.MAX_BOT || '';
const NOTE = { new: 'принят', confirmed: 'принят в работу', picking: 'передан на сборку', packed: 'собран и скоро поедет к вам', shipping: 'передан курьеру, он уже в пути', delivered: 'отгружен. Спасибо, что выбрали «Байкал Салют»!', failed: 'не удалось доставить, менеджер свяжется с вами', cancelled: 'отменён' };
const tgSend = (chat, text) => TG && chat ? fetch(TG_API + '/bot' + TG + '/sendMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text }) }).catch(e => console.error('tg', e.message)) : null;
let BOT = null, SUBS = null;
// Уведомление о новом заказе в служебный бот (ALERT_TOKEN, ALERT_CHAT в /etc/bs.env) — только для владельца
const ALERT_TOKEN = process.env.ALERT_TOKEN || '', ALERT_CHAT = process.env.ALERT_CHAT || '', ALERT_CH = process.env.ALERT_CHANNEL || 'telegram', MAX_API_A = process.env.MAX_API || 'https://platform-api.max.ru';
function alertOrder(o) {
  if (!ALERT_TOKEN || !ALERT_CHAT) return;
  const rub = n => Math.round(n).toString().replace(/\B(?=(\d{3})+$)/g, ' ') + ' ₽';
  const d = o.deliveryDate ? o.deliveryDate.split('-').reverse().join('.') : 'не указана';
  const text = '🛒 Новый заказ № ' + o.id + '\nСумма: ' + rub(o.total) + '\nДоставка: ' + d + (o.deliveryInterval ? ', ' + o.deliveryInterval : '') + '\nАдрес: ' + (o.address || 'не указан') + '\nКлиент: ' + o.name + '\nТелефон: ' + o.phone;
  for (const chat of ALERT_CHAT.split(',').map(x => x.trim()).filter(Boolean)) { // можно несколько получателей: ALERT_CHAT=123,456
    const req = ALERT_CH === 'max'
      ? fetch(MAX_API_A + '/messages?chat_id=' + encodeURIComponent(chat), { method: 'POST', headers: { 'content-type': 'application/json', authorization: ALERT_TOKEN }, body: JSON.stringify({ text }) })
      : fetch(TG_API + '/bot' + ALERT_TOKEN + '/sendMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text }) });
    req.catch(e => console.error('alert', e.message));
  }
}
function alertText(text) { // произвольное уведомление сотрудникам (служебный бот)
  if (!ALERT_TOKEN || !ALERT_CHAT) return;
  for (const chat of ALERT_CHAT.split(',').map(x => x.trim()).filter(Boolean)) {
    const req = ALERT_CH === 'max'
      ? fetch(MAX_API_A + '/messages?chat_id=' + encodeURIComponent(chat), { method: 'POST', headers: { 'content-type': 'application/json', authorization: ALERT_TOKEN }, body: JSON.stringify({ text }) })
      : fetch(TG_API + '/bot' + ALERT_TOKEN + '/sendMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text }) });
    req.catch(e => console.error('alert', e.message));
  }
}
function notifyOrder(o, text) { const n = o.notify; if (!n || !n.chatId || !BOT) return; if (n.channel === 'telegram' || n.channel === 'max') BOT.send(n.channel, n.chatId, text) }
const statusText = o => 'Заказ № ' + o.id + ': ' + (NOTE[o.status] || o.status) + (o.status === 'shipping' && o.deliveryInterval ? '. Доставка: ' + o.deliveryInterval : '').replace(/([^.!])$/, '$1.');
const priceOf = (sku, p) => { const o = cat[sku]; return o && o.p > 0 ? o.p : p }; // цена, выставленная менеджером, главнее цены с сайта

/* ---------- «Закончился»: скрытие на 15 дней и замена товара в заказе ---------- */
const OOS_DAYS = 15;
const oosOn = k => { const o = cat[k]; return !!(o && o.oos && Date.parse(o.oos) > Date.now()) }; // скрыт вручную как «закончился» и срок ещё идёт
const hiddenNow = k => { const o = cat[k]; return !!(o && (o.h || oosOn(k))) };
function sweepOos() { let n = 0; for (const k in cat) { const o = cat[k]; if (o.oos && Date.parse(o.oos) <= Date.now()) { delete o.oos; n++; if (!o.p && !o.h) delete cat[k] } } if (n) persistCat() }
setInterval(sweepOos, 3600e3).unref(); sweepOos();
const shotsOf = sku => { const g = gpData()[sku], r = g && (g.p || []).find(x => /выстрел/i.test(x[0])); return r ? (+String(r[1]).replace(/\D/g, '') || 0) : 0 };
const visibleNow = b => !hiddenNow(b.sku) && !FEED.hd.includes(b.sku);
const PM_NUM = /выстрел|калибр|высот|длительн|время|продолж|эффект|мощност|залп|диаметр/i; // числовые характеристики для сравнения
const numsOf = sku => { const g = gpData()[sku], o = {}; for (const r of (g && g.p) || []) { if (!PM_NUM.test(r[0])) continue; const v = parseFloat(String(r[1]).replace(',', '.').replace(/[^\d.:]/g, '').replace(/^(\d+):(\d+)$/, (m, x, y) => +x * 60 + +y)); if (v > 0) o[String(r[0]).toLowerCase().trim()] = v } return o };
function suggestFor(sku, exclude) { // замена: та же категория; характеристики не ниже (если таких нет — ближайший послабее); из подходящих ближайший по цене; бренд любой
  const base = BASE.find(b => b.sku === sku); if (!base) return null;
  const p0 = priceOf(sku, base.price) || 1, n0 = numsOf(sku), c0 = catOf(sku), keys = Object.keys(n0); let best = null, bs = -1e9, weak = null, ws = -1e9;
  for (const b of BASE) {
    if (b.sku === sku || exclude.includes(b.sku) || !visibleNow(b)) continue;
    const pr = priceOf(b.sku, b.price); if (!(pr > 0)) continue;
    if (!catOf(b.sku).some(c => c0.includes(c))) continue; // только своя категория
    const n1 = numsOf(b.sku), cmpk = keys.filter(k => n1[k]); let ok = !keys.length || cmpk.length > 0, lack = 0;
    for (const k of cmpk) { if (n1[k] < n0[k] * 0.999) { ok = false; lack += (n0[k] - n1[k]) / n0[k] } }
    const d = Math.abs(pr - p0) / p0, br = b.brand && b.brand === base.brand ? 0.03 : 0;
    if (ok) { const sc = -d + br; if (sc > bs) { bs = sc; best = b } }
    else { const sc = -(lack * 3 + d) + br - (cmpk.length ? 0 : 5); if (sc > ws) { ws = sc; weak = b } }
  }
  const pick = best || weak; if (!pick) return null;
  return { sku: pick.sku, name: pick.name, price: priceOf(pick.sku, pick.price), img: FEED.im[pick.sku] || pick.img || '', ...(best ? {} : { weaker: true }) };
}
const imgUrl = i => !i ? '' : /^https?:/.test(i) ? i : (process.env.SITE_URL ? process.env.SITE_URL.replace(/\/$/, '') + i : '');
const money = n => Math.round(n).toString().replace(/\B(?=(\d{3})+$)/g, ' ') + ' ₽';
function recalcOrder(o) {
  const sumAll = o.items.reduce((s, i) => s + i.sum, 0); let d = o.discount || 0;
  if (o.promo) { const pr = findPromo(o.promo); if (pr && promoState(pr) === 'ok') d = promoDiscount(pr, sumAll) }
  o.discount = Math.max(0, Math.min(d, sumAll)); o.total = Math.round((sumAll - o.discount) * 100) / 100;
}
const histAdd = (o, by, note) => (o.history = o.history || []).push({ at: new Date().toISOString(), by, role: 'system', from: o.status, to: o.status, note });
function chatOf(o) { const n = o.notify; return n && n.channel === 'telegram' && n.linked && n.chatId ? String(n.chatId) : '' }
const hx = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const SITE_BASE = () => (process.env.SITE_URL || process.env.SHOP_URL || 'https://salut38.shop').replace(/\/$/, '');
const APP_BASE = () => { const b = SITE_BASE(); return /\/\/app\./.test(b) ? b : b.replace('//', '//app.') };
const pLink = (name, sku) => '<a href="' + SITE_BASE() + '/#p/' + encodeURIComponent(sku) + '">«' + hx(name) + '»</a>';
function facts(sku) { // краткие характеристики одной строкой: выстрелы · калибр · время
  const g = gpData()[sku], rows = (g && g.p) || [], f = re => rows.find(r => re.test(r[0])), out = [];
  const sh = f(/выстрел|залп/i), ca = f(/калибр/i), tm = f(/длительн|время|продолж/i);
  if (sh && sh[1]) out.push(hx(sh[1]) + ' ' + hx(sh[2] || 'выстрелов'));
  if (ca && ca[1]) out.push('калибр ' + hx(ca[1]) + hx(ca[2] || ''));
  if (tm && tm[1]) out.push(hx(tm[1]) + ' ' + hx(tm[2] || 'сек'));
  return out.join(' · ');
}
const catName = sku => catOf(sku)[0] || '';
function prodBlock(mark, sku, name, price) { return mark + ' · ' + hx(catName(sku)) + '\n' + pLink(name, sku) + (facts(sku) ? '\n<i>' + facts(sku) + '</i> · ' : '\n') + money(price) }
const endedBlock = c => prodBlock('❌ Закончился', c.sku, c.name, c.price);
const offerBlock = of => prodBlock('✅ Предложение автозамены', of.sku, of.name, of.price);
function orderLink(o) { if (!o.vt) { o.vt = crypto.randomBytes(12).toString('hex'); persist() } return APP_BASE() + '/o/' + o.vt }
const ORDER_KB = o => ({ inline_keyboard: [[{ text: '📄 Состав заказа', url: orderLink(o) }]] });
/* Все замены заказа клиент решает на одной странице /r/<код>. В чат: приглашение (через 3 минуты после первой «Закончился»), до 3 напоминаний, итог */
const BATCH_MS = (+process.env.REPL_BATCH_MIN || 0) * 60e3; // задержка приглашения о заменах; временно 0 — сразу (вернуть: REPL_BATCH_MIN=3 в /etc/bs.env)
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c };
const ended = n => 'закончил' + plural(n, 'ась', 'ись', 'ись') + ' ' + n + ' ' + plural(n, 'позиция', 'позиции', 'позиций');
function replLink(o) { if (!o.rt) { o.rt = crypto.randomBytes(12).toString('hex'); persist() } return APP_BASE() + '/r/' + o.rt }
const isOpen = c => c.st === 'wait' || c.st === 'manual';
const liveCases = o => (o.subst || []).filter(c => c.st !== 'cancel' && !c.supDone); // замены текущей партии (ещё не переданы поставщику)
const canAll = c => c.st === 'wait' && c.offer && !c.autoOff && !c.supDone;
const shortOf = (sku, price) => hx(catName(sku)) + (facts(sku) ? ' · ' + facts(sku) : '') + ' · ' + money(price);
const endedLine = c => '❌ ' + pLink(c.name, c.sku) + ' · ' + shortOf(c.sku, c.price);
function replKb(o) { const r = [[{ text: '📋 Открыть замены', url: replLink(o) }]]; const n = liveCases(o).filter(canAll).length; if (n) r.push([{ text: '✅ Утвердить все предложенные' + (n > 1 ? ' (' + n + ')' : ''), callback_data: 'sa:' + o.id }]); return { inline_keyboard: r } }
function replState(o) { const l = liveCases(o), open = l.filter(isOpen).length; return { all: l.length, open, done: l.length - open } }
function inviteText(o, ids) { // ids — новые позиции для «закончилась ещё»; без ids — все нерешённые
  const st = replState(o), l = ids ? liveCases(o).filter(c => ids.includes(c.id)) : liveCases(o).filter(isOpen), n = l.length;
  const head = ids ? '<b>Заказ № ' + hx(o.id) + '</b>\nК сожалению, ' + ended(n).replace(/^(\S+) (\d+)/, '$1 ещё $2') + '. ' + (n > 1 ? 'Замены добавлены' : 'Замена добавлена') + ' на ту же страницу.'
    : '<b>Заказ № ' + hx(o.id) + '</b>\nК сожалению, ' + ended(n) + '. Мы уже подобрали ' + (n > 1 ? 'замены, их можно посмотреть и согласовать одним списком.' : 'замену, её можно посмотреть и согласовать по ссылке.');
  return head + '\n\n' + l.map(endedLine).join('\n') + '\n\n<i>Решено: ' + st.done + ' из ' + st.all + '</i>';
}
function flushRepl() { // после «Закончился» (сразу или через REPL_BATCH_MIN минут) — одно сообщение со ссылкой на страницу замен
  const now = Date.now(); let ch = false;
  for (const o of Object.values(orders)) {
    const rp = o.rp; if (!rp || !rp.due || Date.parse(rp.due) > now) continue;
    delete rp.due; ch = true;
    const fresh = (o.subst || []).filter(c => isOpen(c) && !c.ann); if (!fresh.length) continue;
    fresh.forEach(c => { c.ann = true }); const chat = chatOf(o), more = !!rp.sentAt && replState(o).all > fresh.length, n = fresh.length;
    if (chat && BOT) {
      BOT.send('telegram', chat, inviteText(o, more ? fresh.map(c => c.id) : null), '', replKb(o), true);
      rp.sentAt = new Date().toISOString(); rp.rem = 0; rp.remAt = ''; rp.cold = false; rp.doneSent = false;
      (o.subst || []).forEach(c => { if (isOpen(c)) { c.cold = false; c.noChat = false } });
      histAdd(o, 'система', 'Клиенту отправлена ссылка на страницу замен: ' + ended(n));
      alertText('📦 Заказ № ' + o.id + ': ' + ended(n) + '. Клиенту отправлена ссылка на страницу замен, ждём решения.');
    } else {
      fresh.forEach(c => { c.noChat = true });
      alertText('📞 ЗВОНИТЬ ВРУЧНУЮ · заказ № ' + o.id + ': ' + ended(n) + ', клиент не в боте. Телефон: ' + o.phone + '. Ссылку на страницу замен можно отправить в любой мессенджер: ' + replLink(o));
    }
  }
  if (ch) persist();
}
setInterval(flushRepl, 20e3).unref();
function checkDone(o) { // все позиции решены — итог клиенту и сотрудникам (один раз)
  const st = replState(o), rp = o.rp; if (!st.all || st.open || !rp || rp.doneSent) return;
  rp.doneSent = true; if (rp.due) delete rp.due; const l = liveCases(o);
  const lines = l.map(c => c.st === 'ok' && c.final ? '❌ ' + pLink(c.name, c.sku) + '\n✅ ' + pLink(c.final.name, c.final.sku) + ' · ' + shortOf(c.final.sku, c.final.price) : c.st === 'removed' ? '✖ ' + pLink(c.name, c.sku) + ' — удалено из заказа' : '✅ ' + pLink(c.name, c.sku) + ' — решено с оператором').join('\n\n');
  if (rp.sentAt) clientMsg(o, '✅ <b>Все замены согласованы</b> · заказ № ' + hx(o.id) + '\n\n' + lines + '\n\nАктуальный состав заказа можно посмотреть и скачать в PDF.', ORDER_KB(o));
  alertText('✅ Заказ № ' + o.id + ': все замены решены. Сумма: ' + money(o.total) + '. Уведомите поставщика — кнопка «Поставщик уведомлён» в заказе.');
}
function clientMsg(o, text, kb) { const chat = chatOf(o); if (chat && BOT) BOT.send('telegram', chat, text, '', kb, true) }
const supNeed = (c, kind) => { c.sup = { kind, at: new Date().toISOString() }; c.supDone = false }; // вручную передаём заказы поставщику — нужно сообщить ему об изменении
const catOf = sku => { const b = BASE.find(x => x.sku === sku); return b ? (b.cats || []).filter(x => x !== 'Хит продаж') : [] };
function prodInfo(sku, name, price) { // карточка товара для сравнения «было / предложено»
  const b = BASE.find(x => x.sku === sku) || {}, g = gpData()[sku], specs = ((g && g.p) || []).slice(0, 16).map(r => [String(r[0]), String(r[1]) + (r[2] ? ' ' + r[2] : '')]);
  return { sku, name: name || b.name || sku, brand: b.brand || '', cat: (catOf(sku)[0]) || '', price, img: FEED.im[sku] || b.img || '', specs };
}
function selfList(o, c, page) { // весь список товаров из категории; показ начинаем с цены закончившегося товара минус 30%
  const cs = catOf(c.sku), inO = o.items.map(i => i.sku), lo = c.price * 0.7;
  const all = BASE.filter(b => b.sku !== c.sku && !inO.includes(b.sku) && visibleNow(b) && catOf(b.sku).some(x => cs.includes(x))).map(b => ({ b, pr: priceOf(b.sku, b.price) })).filter(x => x.pr > 0);
  const up = all.filter(x => x.pr >= lo).sort((x, y) => x.pr - y.pr), down = all.filter(x => x.pr < lo).sort((x, y) => y.pr - x.pr), l = up.concat(down);
  const N = 5, pages = Math.max(1, Math.ceil(l.length / N)); page = Math.max(0, Math.min(pages - 1, +page || 0));
  const part = l.slice(page * N, page * N + N);
  const lines = part.map((x, i) => '<b>' + (i + 1) + '.</b> ' + pLink(x.b.name, x.b.sku) + ' · ' + money(x.pr) + (facts(x.b.sku) ? '\n<i>' + facts(x.b.sku) + '</i>' : '')).join('\n');
  const rows = []; if (part.length) rows.push(part.map((x, i) => ({ text: String(i + 1), callback_data: 'sc:' + o.id + ':' + c.id + ':' + x.b.sku })));
  const nav = []; if (page > 0) nav.push({ text: '◀ Назад', callback_data: 'sp:' + o.id + ':' + c.id + ':' + (page - 1) }); if (page < pages - 1) nav.push({ text: 'Дальше ▶', callback_data: 'sp:' + o.id + ':' + c.id + ':' + (page + 1) });
  if (nav.length) rows.push(nav); rows.push([{ text: '✖ Удалить из заказа', callback_data: 'sd:' + o.id + ':' + c.id }]);
  return { text: '<b>Выберите замену</b>\n' + endedBlock(c) + '\n\n' + (l.length ? lines + '\n\n<i>Категория «' + hx(cs[0] || '') + '» · от цены чуть ниже вашей · стр. ' + (page + 1) + ' из ' + pages + '</i>' : 'В этой категории сейчас нет подходящих товаров. Можно удалить позицию из заказа или написать нам сюда, оператор поможет.'), kb: { inline_keyboard: rows }, list: true, html: true };
}
function removeItem(o, c, by) {
  if (!c || !isOpen(c) || c.supDone) return { error: 'Позиция уже обработана' };
  const i = o.items.findIndex(x => x.sku === c.sku); if (i < 0) return { error: 'Позиции уже нет в заказе' };
  o.items.splice(i, 1); recalcOrder(o); c.st = 'removed'; c.by = by; c.doneAt = new Date().toISOString(); if (!o.items.length) o.supCancel = { at: c.doneAt, done: false }; // поставщику об удалении сообщаем только если заказ опустел целиком
  histAdd(o, by, 'Позиция «' + c.name + '» удалена из заказа (' + by + '). Сумма заказа: ' + money(o.total)); o.updatedAt = new Date().toISOString();
  if (!o.items.length) alertText('✖ Заказ № ' + o.id + ': в заказе не осталось позиций! Заказ отменён клиентом полностью — уведомите поставщика (список «Уведомить поставщика»).');
  checkDone(o); persist();
  return { ok: true };
}
function startOos(o, sku, by) {
  const it = o.items.find(i => i.sku === sku); if (!it) return { error: 'Нет такой позиции' };
  if (!['new', 'confirmed', 'picking'].includes(o.status)) return { error: 'Замена доступна, пока заказ не собран' };
  o.subst = o.subst || []; if (o.subst.some(c => c.sku === sku && isOpen(c))) return { error: 'По этой позиции замена уже предлагается' };
  if (o.subst.some(c => c.st === 'ok' && c.final && c.final.sku === sku && !c.supDone)) return { error: 'Это уже замена. Нажмите «Изменить» у этой позиции в списке замен' };
  const k = cat[sku] || (cat[sku] = {}); k.oos = new Date(Date.now() + OOS_DAYS * 864e5).toISOString(); k.by = by; k.at = new Date().toISOString(); persistCat();
  const c = { id: String((o.subst.reduce((m, x) => Math.max(m, +x.id || 0), 0)) + 1), sku, name: it.name, qty: it.qty, price: it.price, tried: [], st: 'wait', at: new Date().toISOString() };
  o.subst.push(c);
  const off = suggestFor(sku, [...o.items.map(i => i.sku)]);
  if (off) { c.offer = off; c.tried.push(off.sku); histAdd(o, by, 'Закончился: ' + it.name + '. Предложена замена: ' + off.name) }
  else { c.autoOff = true; histAdd(o, by, 'Закончился: ' + it.name + '. Подходящей замены автоматически не нашлось — клиент выберет сам') }
  c.noChat = !chatOf(o); if (c.noChat && !off) c.st = 'manual';
  const rp = o.rp || (o.rp = {}); if (!rp.due) rp.due = new Date(Date.now() + BATCH_MS).toISOString(); rp.doneSent = false; replLink(o);
  o.updatedAt = new Date().toISOString(); persist();
  if (!BATCH_MS) setImmediate(flushRepl); // без задержки — клиенту сразу
  return { ok: true };
}
function acceptSubst(o, c, by) {
  if (!c || c.st !== 'wait' || !c.offer || c.supDone) return { error: 'Замена уже обработана' };
  const i = o.items.findIndex(x => x.sku === c.sku); if (i < 0) return { error: 'Позиции уже нет в заказе' };
  const of = c.offer; o.items[i] = { sku: of.sku, name: of.name, qty: c.qty, price: of.price, sum: Math.round(of.price * c.qty * 100) / 100, picked: false };
  recalcOrder(o); c.st = 'ok'; c.final = of; c.by = by; c.doneAt = new Date().toISOString(); c.self = false; supNeed(c, 'replace');
  histAdd(o, by, 'Замена утверждена (' + by + '): ' + c.name + ' → ' + of.name + '. Сумма заказа: ' + money(o.total)); o.updatedAt = new Date().toISOString();
  checkDone(o); persist();
  return { ok: true };
}
function undoSubst(o, c, by) { // «изменить» / «вернуть»: позиция снова ждёт решения, пока поставщик не уведомлён
  if (!c || c.supDone) return { error: 'Поставщик уже уведомлён — изменить нельзя. Напишите нам в бота.' };
  if (c.st !== 'ok' && c.st !== 'removed') return { error: 'Нечего менять' };
  const orig = { sku: c.sku, name: c.name, qty: c.qty, price: c.price, sum: Math.round(c.price * c.qty * 100) / 100, picked: false };
  if (c.st === 'ok') { const i = c.final ? o.items.findIndex(x => x.sku === c.final.sku) : -1; if (i >= 0) o.items[i] = orig; else o.items.push(orig); c.offer = c.final; c.final = null }
  else { o.items.push(orig); if (o.supCancel && !o.supCancel.done) delete o.supCancel; if (!c.offer) c.autoOff = true }
  recalcOrder(o); c.st = 'wait'; c.sup = null; c.supDone = false; c.chosen = false; c.by = '';
  if (o.rp) o.rp.doneSent = false;
  histAdd(o, by, 'Решение по «' + c.name + '» отменено (' + by + '), позиция снова ждёт замены'); o.updatedAt = new Date().toISOString(); persist();
  return { ok: true };
}
function acceptAll(o, by) { let n = 0; for (const c of (o.subst || []).filter(canAll)) if (!acceptSubst(o, c, by).error) n++; return n }
function pickSubst(o, c, sku, by) { // клиент или менеджер выбрал товар сам
  if (!c || !isOpen(c) || c.supDone) return { error: 'Позиция уже обработана' };
  const b = BASE.find(x => x.sku === sku); if (!b || !visibleNow(b)) return { error: 'Этот товар сейчас недоступен, выберите другой' };
  if (o.items.some(i => i.sku === sku)) return { error: 'Этот товар уже есть в заказе' };
  c.offer = { sku: b.sku, name: b.name, price: priceOf(b.sku, b.price), img: FEED.im[b.sku] || b.img || '' }; if (!c.tried.includes(b.sku)) c.tried.push(b.sku); c.chosen = true; c.st = 'wait'; c.autoOff = false;
  return acceptSubst(o, c, by);
}
function nextSubst(o, c, by, sku) {
  if (!c || !isOpen(c) || c.supDone) return { error: 'Замена уже обработана' };
  const cl = by === 'клиент'; let off = null;
  if (sku) { const b = BASE.find(x => x.sku === sku); if (!b) return { error: 'Товар не найден' }; if (!visibleNow(b)) return { error: 'Этот товар сейчас скрыт или закончился' }; off = { sku: b.sku, name: b.name, price: priceOf(b.sku, b.price), img: FEED.im[b.sku] || b.img || '' } }
  else if (cl) { c.nexts = (c.nexts || 0) + 1; if (c.nexts < 4) off = suggestFor(c.sku, [...o.items.map(i => i.sku), ...c.tried]) }
  else off = suggestFor(c.sku, [...o.items.map(i => i.sku), ...c.tried]);
  if (!off) {
    if (cl) { c.autoOff = true; c.offer = null; c.st = 'wait'; histAdd(o, by, 'Автозамены для «' + c.name + '» закончились — клиенту остался самостоятельный выбор или удаление'); o.updatedAt = new Date().toISOString(); persist(); return { ok: true } }
    c.st = 'manual'; c.offer = null; histAdd(o, by, 'Подходящих замен для «' + c.name + '» больше нет — нужна связь с клиентом'); o.updatedAt = new Date().toISOString(); persist(); return { ok: true } }
  c.offer = off; c.st = 'wait'; c.self = false; c.autoOff = false; c.tried.push(off.sku); histAdd(o, by, 'Другая замена для «' + c.name + '»: ' + off.name); o.updatedAt = new Date().toISOString(); persist();
  return { ok: true };
}
const irkHour = () => new Date(Date.now() + 8 * 3600e3).getUTCHours();
function remindSubst() { // раз в 60 минут с 9:00 до 21:00 по Иркутску, максимум 3 напоминания на заказ
  const h = irkHour(); if (h < 9 || h >= 21) return; let ch = false;
  for (const o of Object.values(orders)) {
    const rp = o.rp; if (!rp || !rp.sentAt || rp.cold || rp.due) continue;
    const st = replState(o); if (!st.open || !chatOf(o)) continue;
    if (!(Date.now() - Date.parse(rp.remAt || rp.sentAt) >= 3600e3)) continue;
    if ((rp.rem || 0) >= 3) { rp.cold = true; rp.coldAt = new Date().toISOString(); liveCases(o).filter(isOpen).forEach(c => { c.cold = true }); histAdd(o, 'система', 'Клиент не ответил на 3 напоминания о заменах. Нужен звонок оператора'); o.updatedAt = rp.coldAt; ch = true;
      alertText('🥶 Заказ № ' + o.id + ': клиент не ответил по заменам после 3 напоминаний (осталось решить ' + st.open + ' из ' + st.all + '). Позвоните: ' + o.phone); continue }
    clientMsg(o, '⏰ <b>Ждём решения по заменам</b> · заказ № ' + hx(o.id) + '\nОсталось решить: <b>' + st.open + ' из ' + st.all + '</b>.', replKb(o));
    rp.rem = (rp.rem || 0) + 1; rp.remAt = new Date().toISOString(); ch = true;
  }
  if (ch) persist() }
setInterval(remindSubst, 5 * 60e3).unref();
for (const o of Object.values(orders)) { // заказы, где замены уже ушли старыми карточками в чат: переводим на страницу без повторной отправки
  const old = (o.subst || []).filter(c => isOpen(c) && c.sentAt && !c.ann); if (!old.length || (o.rp && o.rp.sentAt)) continue;
  o.rp = { sentAt: old[0].sentAt, rem: Math.max(...old.map(c => c.rem || 0)), remAt: old[0].remAt || '' }; old.forEach(c => { c.ann = true });
}
function substAnswer(act, orderId, caseId, chat, arg) { // нажатия кнопок клиента в боте
  const o = orders[orderId]; if (!o || chatOf(o) !== String(chat)) return 'Это предложение уже недоступно.';
  if (act === 'all' || act === 'allyes' || act === 'back') { // «Утвердить все предложенные» прямо из чата
    if (act === 'allyes') acceptAll(o, 'клиент');
    const l = liveCases(o).filter(canAll);
    if (act === 'all' && l.length) return { list: true, html: true, text: '<b>Утвердить все предложенные замены?</b> · заказ № ' + hx(o.id) + '\n\n' + l.map(c => '❌ ' + pLink(c.name, c.sku) + '\n✅ ' + pLink(c.offer.name, c.offer.sku) + ' · ' + shortOf(c.offer.sku, c.offer.price)).join('\n\n'),
      kb: { inline_keyboard: [[{ text: '✅ Да, утвердить все', callback_data: 'sb:' + o.id }], [{ text: '↩ Назад', callback_data: 'sr:' + o.id }], [{ text: '📋 Открыть замены', url: replLink(o) }]] } };
    const st = replState(o);
    return { list: true, html: true, text: '<b>Заказ № ' + hx(o.id) + '</b>\n' + (st.open ? 'Замены можно посмотреть и согласовать по ссылке.' : 'Все замены решены, спасибо!') + '\n\n<i>Решено: ' + st.done + ' из ' + st.all + '</i>', kb: replKb(o) };
  }
  // старые карточки в чате (до перехода на страницу замен)
  return { text: 'Все замены по заказу № ' + o.id + ' теперь собраны на одной странице — откройте её по кнопке.', kb: { inline_keyboard: [[{ text: '📋 Открыть замены', url: replLink(o) }]] } };
}
const digits = s => String(s || '').replace(/\D/g, '').replace(/^8(?=\d{10}$)/, '7');
for (const k in carts) if (Date.now() - Date.parse(carts[k].updatedAt) > 30 * 864e5) delete carts[k]; // брошенные корзины старше 30 дней убираем
function cartItems(items, fix) { return (Array.isArray(items) ? items.slice(0, 80) : []).map(i => ({ sku: clean(i.sku, 40), name: clean(i.name, 200), qty: Math.max(1, Math.min(999, Math.floor(+i.qty || 1))), price: Math.max(0, fix ? priceOf(clean(i.sku, 40), +i.price || 0) : +i.price || 0) })).map(i => ({ ...i, sum: i.price * i.qty })) }
function cartCalc(c) { // сумма, скидка (вручную перекрывает промокод) и итог
  const sum = c.items.reduce((s, i) => s + i.sum, 0), mv = c.manual && +c.manual.value > 0 ? c.manual : null; let discount = 0, kind = '', state = ''; c.promoInfo = null;
  if (mv) { discount = mv.type === 'pct' ? Math.round(sum * Math.min(100, mv.value) / 100) : Math.min(Math.round(mv.value), sum); kind = 'manual' }
  else if (c.promo) { const pr = findPromo(c.promo); state = !pr ? 'unknown' : promoState(pr); if (pr && state === 'ok') { discount = promoDiscount(pr, sum); kind = 'promo' } c.promoInfo = pr ? { state: state === 'ok' && pr.min > sum ? 'min' : state, type: pr.type, value: pr.value, min: pr.min || 0 } : { state: 'unknown' } } else c.promoInfo = null;
  discount = Math.max(0, Math.min(discount, sum)); c.discount = discount; c.total = sum - discount; c.discountKind = kind; c.promoState = state; return c }
function cartEdit(c, b) { // правки менеджера в брошенной корзине
  if ('name' in b) c.name = clean(b.name, 100) || 'Без имени';
  if ('phone' in b) c.phone = clean(b.phone, 40);
  if ('items' in b) c.items = cartItems(b.items).filter(i => i.name);
  if ('promo' in b) c.promo = clean(b.promo, 60);
  if ('manual' in b) { const t = b.manual && b.manual.type === 'pct' ? 'pct' : 'rub', v = Math.max(0, +(b.manual && b.manual.value) || 0); c.manual = v > 0 ? { type: t, value: t === 'pct' ? Math.min(100, v) : Math.round(v) } : null; if (c.manual) c.promo = '' }
  if ('address' in b) c.address = clean(b.address, 300);
  if ('deliveryDate' in b) c.deliveryDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.deliveryDate || '')) ? String(b.deliveryDate) : '';
  if ('deliveryInterval' in b) c.deliveryInterval = clean(b.deliveryInterval, 20);
  if ('note' in b) c.note = clean(b.note, 300);
  if ('called' in b) c.called = !!b.called;
  if (Object.keys(b).some(k => k !== 'called')) c.edited = true;
  return cartCalc(c) }
function dropCarts(cartId, phone) { // клиент дооформил заказ: корзина больше не брошенная
  const ph = digits(phone); let n = 0;
  for (const k in carts) if (k === cartId || (ph && digits(carts[k].phone) === ph)) { delete carts[k]; n++ }
  if (n) persistC(); return n }

/* ---------- API ---------- */
async function api(req, res, url) {
  const m = req.method, p = url.pathname;

  if (m === 'POST' && p === '/cart') { // сайт: клиент нажал «Далее», заказ пока не оформлен
    if (limit('k' + ipOf(req), 60, 3600e3)) return send(res, 429, { error: 'too many' }, CORS);
    let o; try { o = await body(req) } catch { return send(res, 400, { error: 'bad json' }, CORS) }
    const phone = clean(o.phone, 40), items = cartItems(o.items, true), id = clean(o.cartId, 30).replace(/[^\w-]/g, '');
    if (!id || digits(phone).length < 10 || !items.length) return send(res, 400, { error: 'bad cart' }, CORS);
    const sum = items.reduce((s, i) => s + i.sum, 0), pr0 = findPromo(o.promo), discount = pr0 && promoState(pr0) === 'ok' ? promoDiscount(pr0, sum) : 0, now = new Date().toISOString(), cur = carts[id];
    if (cur && cur.edited) return send(res, 200, { ok: true }, CORS); // менеджер уже редактирует: не затираем
    carts[id] = { id, createdAt: cur ? cur.createdAt : now, updatedAt: now, name: clean(o.name, 100) || 'Без имени', phone, promo: clean(o.promo, 60), items, discount, total: sum - discount, source: clean(o.source, 60) || 'Корзина сайта', consentAt: o.consent === true ? now : (cur ? cur.consentAt || '' : ''), called: cur ? !!cur.called : false, note: cur ? cur.note || '' : '' };
    persistC(); return send(res, 200, { ok: true }, CORS);
  }

  if (m === 'POST' && p === '/order') { // с сайта
    if (limit('o' + ipOf(req), 12, 3600e3)) return send(res, 429, { error: 'too many' }, CORS);
    let o; try { o = await body(req) } catch { return send(res, 400, { error: 'bad json' }, CORS) }
    const phone = clean(o.phone, 40), items = Array.isArray(o.items) ? o.items.slice(0, 80) : [];
    if (phone.replace(/\D/g, '').length < 10 || !items.length) return send(res, 400, { error: 'bad order' }, CORS);
    const its = items.map(i => ({ sku: clean(i.sku, 40), name: clean(i.name, 200), qty: Math.max(1, Math.min(999, Math.floor(+i.qty || 1))), price: Math.max(0, priceOf(clean(i.sku, 40), +i.price || 0)), picked: false }));
    its.forEach(i => i.sum = i.price * i.qty);
    let id = clean(o.id, 20).replace(/[^\w-]/g, '') || 'Z' + Date.now().toString(36).toUpperCase();
    if (orders[id]) id += uid().slice(0, 3).toUpperCase();
    const sumAll = its.reduce((s, i) => s + i.sum, 0), pr0 = findPromo(o.promo), discount = pr0 && promoState(pr0) === 'ok' ? promoDiscount(pr0, sumAll) : 0;
    const now = new Date().toISOString();
    orders[id] = { id, createdAt: now, name: clean(o.name, 100) || 'Без имени', phone, address: clean(o.address, 300), comment: clean(o.comment, 500), promo: clean(o.promo, 60), deliveryDate: /^\d{4}-\d{2}-\d{2}$/.test(String(o.deliveryDate || '')) ? String(o.deliveryDate) : '', deliveryInterval: clean(o.deliveryInterval, 20), source: clean(o.source, 60) || 'Сайт', consentAt: o.consent === true ? now : '', items: its, discount, total: sumAll - discount, status: 'new', paid: false, pay: 'unpaid', courierId: null, history: [{ at: now, by: 'Сайт', role: 'site', from: null, to: 'new', note: '' }], updatedAt: now };
    dropCarts(clean(o.cartId, 30).replace(/[^\w-]/g, ''), phone); // из брошенных — в обычные
    persist(); alertOrder(orders[id]); return send(res, 200, { ok: true, id, total: sumAll - discount, discount, link: orderLink(orders[id]) }, CORS);
  }

  if (p === '/cart/snap') { // сайт: запомнить корзину перед переходом в бота / забрать её по ссылке из бота
    if (limit('cs' + ipOf(req), 120, 60e3)) return send(res, 429, { ok: false }, CORS);
    if (m === 'POST') { let o; try { o = await body(req) } catch { return send(res, 400, { ok: false }, CORS) }
      const k = String(o.sid || '').toLowerCase(); if (!/^[a-f0-9]{16,40}$/.test(k)) return send(res, 400, { ok: false }, CORS);
      SNAPS.set(k, { items: snapCart(o.items), at: Date.now() }); if (SNAPS.size > 20000) for (const [x, v] of SNAPS) if (Date.now() - v.at > 864e5) SNAPS.delete(x);
      return send(res, 200, { ok: true }, CORS) }
    const k = String(url.searchParams.get('sid') || '').toLowerCase(), c = /^[a-f0-9]{16,40}$/.test(k) && SNAPS.get(k);
    return send(res, 200, c && Date.now() - c.at < 864e5 ? { ok: true, items: c.items } : { ok: false }, CORS);
  }
  if (m === 'GET' && p === '/card/claim') { // сайт спрашивает: выдал ли бот карту по его метке (человек нажал «Получить карту» на сайте)
    if (limit('cc' + ipOf(req), 120, 60e3)) return send(res, 429, { ok: false }, CORS);
    const k = String(url.searchParams.get('sid') || '').toLowerCase(), c = /^[a-f0-9]{12,40}$/.test(k) && CLAIMS.get(k);
    return send(res, 200, c && Date.now() - c.at < 36e5 ? { ok: true, code: c.code } : { ok: false }, CORS);
  }
  if (m === 'GET' && p === '/promo/check') { // сайт спрашивает, действует ли код
    if (limit('c' + ipOf(req), 60, 60e3)) return send(res, 429, { ok: false }, CORS);
    const pr = findPromo(url.searchParams.get('code'));
    if (!pr || promoState(pr) !== 'ok') return send(res, 200, { ok: false }, CORS);
    return send(res, 200, { ok: true, kind: pr.kind, type: pr.type, value: pr.value, min: pr.min || 0 }, CORS);
  }

  if (m === 'POST' && p === '/notify') { // клиент выбрал, где получать статус заказа
    if (limit('n' + ipOf(req), 30, 3600e3)) return send(res, 429, { error: 'too many' }, CORS);
    let b; try { b = await body(req) } catch { return send(res, 400, { error: 'bad json' }, CORS) }
    const o = orders[clean(b.orderId, 30)], ch = ['telegram', 'max', 'email'].includes(b.channel) ? b.channel : '';
    if (!o || !ch || digits(o.phone) !== digits(b.phone)) return send(res, 404, { error: 'not found' }, CORS);
    const email = clean(b.email, 100); if (ch === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'Проверьте адрес почты' }, CORS);
    const tok = (o.notify && o.notify.token) || crypto.randomBytes(6).toString('hex');
    o.notify = { channel: ch, email: ch === 'email' ? email : '', token: tok, chatId: o.notify && o.notify.channel === ch ? o.notify.chatId : '', linked: !!(o.notify && o.notify.channel === ch && o.notify.linked) }; persist();
    const link = ch === 'telegram' && TG && TG_BOT ? 'https://t.me/' + TG_BOT + '?start=' + tok : ch === 'max' && MAX_BOT ? 'https://max.ru/' + MAX_BOT + '?start=' + tok : '';
    return send(res, 200, { ok: true, link }, CORS);
  }

  if (m === 'GET' && p === '/catalog') { // сайт: что скрыто и какие цены выставлены в приложении
    if (limit('g' + ipOf(req), 120, 60e3)) return send(res, 429, {}, CORS);
    const o = {}; for (const k in cat) { const v = cat[k], hh = v.h || oosOn(k); if (hh || v.p > 0) o[k] = { ...(v.p > 0 ? { p: v.p } : {}), ...(hh ? { h: 1 } : {}) } }
    refreshFeed(); return send(res, 200, { o, f: { t: FEED.t, im: FEED.im, vd: FEED.vd, du: durMap(), pm: pmMap(), nm: FEED.nm, pr: FEED.pr, hd: FEED.hd, ad: FEED.ad.map(a => { const { fin, ...r } = a; return r }) } }, { ...CORS, 'cache-control': 'no-store' });
  }

  if (m === 'GET' && p === '/api/users') return send(res, 200, users.map(pub)); // для экрана входа, без PIN
  if (m === 'POST' && p === '/api/login') {
    if (limit('l' + ipOf(req), 8, 60e3)) return send(res, 429, { error: 'Слишком много попыток. Подождите минуту.' });
    const b = await body(req).catch(() => ({})); const u = users.find(x => x.id === b.userId);
    if (!u || !checkPin(u, b.pin || '')) return send(res, 401, { error: 'Неверный PIN' });
    const token = crypto.randomBytes(24).toString('hex'); sessions[token] = { uid: u.id, exp: Date.now() + 30 * 864e5 };
    for (const k in sessions) if (sessions[k].exp < Date.now()) delete sessions[k];
    save(F.sessions, sessions); return send(res, 200, { token, user: pub(u) });
  }

  const me = auth(req); if (!me) return send(res, 401, { error: 'auth' });
  const role = me.role, isM = M.includes(role);

  if (m === 'POST' && p === '/api/logout') { delete sessions[me.token]; save(F.sessions, sessions); return send(res, 200, { ok: true }) }
  if (m === 'GET' && p === '/api/me') return send(res, 200, { user: pub(me), statuses: STATUS });

  if (m === 'GET' && p === '/api/orders') {
    const see = SEES[role]; let list = Object.values(orders);
    if (see) list = list.filter(o => see.includes(o.status));
    if (role === 'courier') list = list.filter(o => o.status === 'delivered' ? (o.courierId === me.id && Date.now() - Date.parse(o.updatedAt) < 36 * 3600e3) : (o.status !== 'shipping' || !o.courierId || o.courierId === me.id));
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return send(res, 200, { orders: list.slice(0, 400).map(o => view(o, role)), couriers: isM ? users.filter(u => u.role === 'courier').map(pub) : undefined, now: Date.now() });
  }

  let mm = p.match(/^\/api\/orders\/([^/]+)(?:\/(status|pick|oos|subst))?$/);
  if (mm) {
    const o = orders[decodeURIComponent(mm[1])]; if (!o) return send(res, 404, { error: 'Заказ не найден' });
    if (SEES[role] && !SEES[role].includes(o.status)) return send(res, 403, { error: 'Нет доступа' });
    const b = m === 'GET' ? {} : await body(req).catch(() => ({}));
    if (m === 'GET' && !mm[2]) return send(res, 200, view(o, role));
    if (mm[2] === 'subst' && m === 'GET') { // поиск товара для ручной замены
      if (!isM) return send(res, 403, { error: 'Только менеджер' }); refreshFeed();
      const q = String(url.searchParams.get('q') || '').toLowerCase().trim(); if (q.length < 2) return send(res, 200, []);
      return send(res, 200, BASE.filter(b => visibleNow(b) && (b.name.toLowerCase().includes(q) || b.sku.toLowerCase().includes(q))).slice(0, 15).map(b => ({ sku: b.sku, name: b.name, price: priceOf(b.sku, b.price), img: FEED.im[b.sku] || b.img || '' })));
    }
    if (mm[2] === 'oos' && m === 'POST') { // кнопка «Закончился»
      if (!isM) return send(res, 403, { error: 'Только менеджер' }); refreshFeed();
      const r = startOos(o, clean(b.sku, 40), me.name); return r.error ? send(res, 400, r) : send(res, 200, view(o, role));
    }
    if (mm[2] === 'subst' && m === 'POST') { // действия менеджера по замене
      if (!isM) return send(res, 403, { error: 'Только менеджер' }); refreshFeed();
      if (b.action === 'supcancel') { if (!o.supCancel || o.supCancel.done) return send(res, 400, { error: 'Уведомлять не нужно' }); o.supCancel.done = true; o.supCancel.by = me.name; histAdd(o, me.name, 'Поставщик уведомлён об отмене заказа'); o.updatedAt = new Date().toISOString(); persist(); return send(res, 200, view(o, role)) }
      if (b.action === 'supplierAll') { // одна кнопка на весь список замен заказа
        if (liveCases(o).some(isOpen)) return send(res, 400, { error: 'Сначала подберите замены для всех позиций' });
        const l = (o.subst || []).filter(c => c.sup && !c.supDone); if (!l.length) return send(res, 400, { error: 'Уведомлять не нужно' });
        const at = new Date().toISOString(); l.forEach(c => { c.supDone = true; c.supAt = at; c.supBy = me.name });
        histAdd(o, me.name, 'Поставщик уведомлён о заменах: ' + l.map(c => c.final ? c.final.name : c.name).join(', ')); o.updatedAt = at; persist(); return send(res, 200, view(o, role)) }
      if (b.action === 'acceptAll') { acceptAll(o, me.name); return send(res, 200, view(o, role)) }
      const c = (o.subst || []).find(x => x.id === String(b.case)); if (!c) return send(res, 404, { error: 'Замена не найдена' });
      let r;
      if (b.action === 'accept') r = acceptSubst(o, c, me.name);
      else if (b.action === 'next') r = b.sku ? pickSubst(o, c, clean(b.sku, 40), me.name) : nextSubst(o, c, me.name, '');
      else if (b.action === 'done' || b.action === 'cancel') { if (!isOpen(c)) return send(res, 400, { error: 'Уже обработано' }); c.st = b.action === 'done' ? 'done' : 'cancel'; c.by = me.name; if (c.st === 'done') supNeed(c, 'manual'); histAdd(o, me.name, (b.action === 'done' ? 'Замена решена вручную: ' : 'Замена отменена: ') + c.name); o.updatedAt = new Date().toISOString(); checkDone(o); persist(); r = { ok: true } }
      else if (b.action === 'remove') r = removeItem(o, c, me.name);
      else if (b.action === 'undo') r = undoSubst(o, c, me.name);
      else if (b.action === 'supplier') { if (!c.sup || c.supDone) return send(res, 400, { error: 'Уведомлять не нужно' }); c.supDone = true; c.supAt = new Date().toISOString(); c.supBy = me.name; histAdd(o, me.name, 'Поставщик уведомлён об изменении: ' + c.name); o.updatedAt = c.supAt; persist(); r = { ok: true } }
      else return send(res, 400, { error: 'Неизвестное действие' });
      return r.error ? send(res, 400, r) : send(res, 200, view(o, role));
    }

    if (m === 'POST' && mm[2] === 'status') {
      const to = b.status; if (!STATUS[to] || !(canMove(role, o.status, to) || (b.force === true && role === 'admin' && to !== o.status))) return send(res, 403, { error: 'Этот переход вам недоступен' });
      const note = clean(b.note, 300);
      if (to !== 'cancelled' && to !== 'failed' && (o.subst || []).some(isOpen) && !note) return send(res, 400, { error: 'Есть позиция без утверждённой замены. Решите её или напишите комментарий, чтобы продолжить.' });
      if ((to === 'failed' || to === 'cancelled') && !note) return send(res, 400, { error: 'Укажите причину' });
      if (to === 'packed' && !isM && !o.items.every(i => i.picked)) return send(res, 400, { error: 'Отметьте все позиции собранными' });
      if (to === 'shipping') o.courierId = role === 'courier' ? me.id : (o.courierId || (users.find(u => u.id === b.courierId && u.role === 'courier') || {}).id || null);
      if (to === 'delivered' && PAY[b.pay]) { o.pay = b.pay; o.paid = o.pay === 'paid' }
      if (to === 'confirmed' && o.status === 'picking') o.items.forEach(i => i.picked = false);
      const now = new Date().toISOString();
      o.history.push({ at: now, by: me.name, role, from: o.status, to, note }); o.status = to; o.updatedAt = now; persist(); notifyOrder(o, statusText(o));
      return send(res, 200, view(o, role));
    }
    if (m === 'POST' && mm[2] === 'pick') {
      if (!(isM || role === 'storekeeper') || o.status !== 'picking') return send(res, 403, { error: 'Сборка доступна только в статусе «Сборка»' });
      const it = o.items.find(i => i.sku === b.sku); if (!it) return send(res, 404, { error: 'Нет такой позиции' });
      it.picked = !!b.picked; o.updatedAt = new Date().toISOString(); persist(); return send(res, 200, view(o, role));
    }
    if (m === 'PATCH' && !mm[2]) { // менеджер: курьер, комментарий, оплата
      if (!isM) return send(res, 403, { error: 'Только менеджер' });
      if ('courierId' in b) { const c = users.find(u => u.id === b.courierId && u.role === 'courier'); o.courierId = c ? c.id : null }
      if ('comment' in b) o.comment = clean(b.comment, 500);
      if ('paid' in b) { o.pay = b.paid ? 'paid' : 'unpaid'; o.paid = !!b.paid }
      if (PAY[b.pay]) { const ch = b.pay !== o.pay; o.pay = b.pay; o.paid = o.pay === 'paid'; if (ch) notifyOrder(o, 'Заказ № ' + o.id + ': оплата — ' + PAY[o.pay].toLowerCase() + '.') }
      if ('address' in b) o.address = clean(b.address, 300);
      if ('deliveryDate' in b) o.deliveryDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.deliveryDate || '')) ? String(b.deliveryDate) : '';
      if ('deliveryInterval' in b) o.deliveryInterval = clean(b.deliveryInterval, 20);
      // владелец правит заказ на любой стадии: клиент, состав, цены, скидка
      const edits = [];
      if ('name' in b && clean(b.name, 100) !== o.name) { o.name = clean(b.name, 100) || 'Без имени'; edits.push('имя') }
      if ('phone' in b) { const ph = clean(b.phone, 40); if (ph.replace(/\D/g, '').length < 10) return send(res, 400, { error: 'Телефон: не меньше 10 цифр' }); if (ph !== o.phone) { o.phone = ph; edits.push('телефон') } }
      if (Array.isArray(b.items)) {
        const prev = new Map(o.items.map(i => [i.sku, i])), its = b.items.slice(0, 80).map(i => { const sku = clean(i.sku, 40), old = prev.get(sku) || {}; return { sku, name: clean(i.name, 200) || old.name || sku, qty: Math.max(1, Math.min(999, Math.floor(+i.qty || 1))), price: Math.max(0, Math.round((+i.price || 0) * 100) / 100), picked: !!old.picked } });
        if (!its.length || its.some(i => !i.sku)) return send(res, 400, { error: 'В заказе должна остаться хотя бы одна позиция' });
        its.forEach(i => i.sum = Math.round(i.price * i.qty * 100) / 100);
        if (JSON.stringify(its.map(i => [i.sku, i.qty, i.price])) !== JSON.stringify(o.items.map(i => [i.sku, i.qty, i.price]))) edits.push('состав');
        o.items = its;
      }
      if ('discount' in b) { const d = Math.max(0, Math.round(+b.discount || 0)); if (d !== o.discount) { o.discount = d; if (!o.promo || !d) o.discountNote = d ? 'Скидка вручную: ' + d + ' ₽' : ''; edits.push('скидка') } }
      if (edits.length || Array.isArray(b.items)) {
        const sumAll = o.items.reduce((s, i) => s + i.sum, 0); o.discount = Math.min(o.discount || 0, sumAll); o.total = Math.round((sumAll - o.discount) * 100) / 100;
        if (edits.length) o.history.push({ at: new Date().toISOString(), by: me.name, role, from: o.status, to: o.status, note: 'Правка заказа: ' + edits.join(', ') });
      }
      o.updatedAt = new Date().toISOString(); persist(); return send(res, 200, view(o, role));
    }
  }

  if (p === '/api/carts' || p.startsWith('/api/carts/')) {
    if (!isM) return send(res, 403, { error: 'Только менеджер' });
    if (m === 'GET' && p === '/api/carts') return send(res, 200, Object.values(carts).map(cartCalc).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    const c = carts[decodeURIComponent(p.slice(11))]; if (!c) return send(res, 404, { error: 'Корзина уже оформлена или удалена' });
    if (m === 'GET') return send(res, 200, cartCalc(c));
    if (m === 'DELETE') { delete carts[c.id]; persistC(); return send(res, 200, { ok: true }) }
    const b = await body(req).catch(() => ({}));
    if (m === 'PATCH') { cartEdit(c, b); if (Object.keys(b).some(k => k !== 'called')) c.updatedAt = new Date().toISOString(); persistC(); return send(res, 200, c) }
    if (m === 'POST') { // «Разместить заказ»: из брошенных в обычные со статусом «Новый»
      cartEdit(c, b);
      if (!c.items.length) return send(res, 400, { error: 'В заказе нет товаров' });
      if (digits(c.phone).length < 10) return send(res, 400, { error: 'Укажите телефон клиента' });
      const id = 'Z' + Date.now().toString(36).toUpperCase(), now = new Date().toISOString(), man = c.manual && c.discount > 0;
      orders[id] = { id, createdAt: now, name: c.name, phone: c.phone, address: c.address || '', comment: c.note || '', promo: man ? '' : (c.discountKind === 'promo' ? c.promo : ''), discountNote: man ? 'Скидка вручную: ' + (c.manual.type === 'pct' ? c.manual.value + '%' : c.manual.value + ' ₽') : '', deliveryDate: c.deliveryDate || '', deliveryInterval: c.deliveryInterval || '', source: 'Брошенная корзина', consentAt: c.consentAt || '', items: c.items.map(i => ({ ...i, picked: false })), discount: c.discount, total: c.total, status: 'new', paid: false, pay: 'unpaid', courierId: null, history: [{ at: now, by: me.name, role, from: null, to: 'new', note: 'Из брошенной корзины' }], updatedAt: now };
      delete carts[c.id]; persist(); persistC(); return send(res, 200, { ok: true, id });
    }
  }

  if (p === '/api/defects' || p.startsWith('/api/defects/')) {
    if (!isM) return send(res, 403, { error: 'Только менеджер' });
    refreshFeed();
    const mp = p.match(/^\/api\/defects\/([^/]+)\/(img|vid|ok|reset)$/), sku = mp ? clean(decodeURIComponent(mp[1]), 60) : '';
    if (m === 'GET' && p === '/api/defects') {
      const idx = new Map(BASE.map(b => [b.sku, b])), rows = [];
      for (const k in AUTO) { const b = idx.get(k); if (!b) continue; const o = OWN[k]; if (defectOf(k) || (o && (o.img || o.vid || o.okI || o.okV))) rows.push(defRow(k, b)) }
      rows.sort((a, b) => (b.open - a.open) || a.name.localeCompare(b.name, 'ru'));
      return send(res, 200, { rows, checked: autoM || 0 });
    }
    if (!mp) return send(res, 404, { error: 'not found' });
    const b0 = BASE.find(x => x.sku === sku); if (!b0 || !AUTO[sku]) return send(res, 404, { error: 'Товар не найден среди дефектных' });
    const o = OWN[sku] || (OWN[sku] = {}), now = new Date().toISOString(), tag = crypto.createHash('md5').update(sku).digest('hex').slice(0, 10) + '-' + Date.now().toString(36);
    if (m === 'PUT' && mp[2] === 'img') {
      const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), ext = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[ct];
      if (!ext) return send(res, 400, { error: 'Нужна картинка JPG, PNG или WebP' });
      if (limit('u' + me.id, 60, 3600e3)) return send(res, 429, { error: 'Слишком много загрузок, подождите' });
      const fn = 'own-' + tag + '.' + ext; try { fs.mkdirSync(IMGDIR, { recursive: true }); await saveRaw(req, path.join(IMGDIR, fn), 25e6) } catch (e) { return send(res, e.big ? 413 : 400, { error: e.big ? 'Файл больше 25 МБ' : 'Не удалось принять файл' }) }
      await normImgs(); dropFile(o.img); o.img = '/img/' + fn + '?n=1'; delete o.okI; o.by = me.name; o.at = now; saveOwn();
      return send(res, 200, defRow(sku, b0));
    }
    if (m === 'PUT' && mp[2] === 'vid') {
      const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), ext = { 'video/mp4': 'mp4', 'video/webm': 'webm' }[ct];
      if (!ext) return send(res, 400, { error: 'Нужно видео MP4 или WebM' });
      if (limit('u' + me.id, 60, 3600e3)) return send(res, 429, { error: 'Слишком много загрузок, подождите' });
      const fn = 'own-' + tag + '.' + ext; try { fs.mkdirSync(VIDDIR, { recursive: true }); await saveRaw(req, path.join(VIDDIR, fn), 400e6) } catch (e) { return send(res, e.big ? 413 : 400, { error: e.big ? 'Видео больше 400 МБ' : 'Не удалось принять файл' }) }
      await new Promise(r => require('child_process').execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(VIDDIR, fn), '-c', 'copy', '-movflags', '+faststart', path.join(VIDDIR, fn + '.fast.mp4')], { timeout: 300e3 }, e => { try { if (!e) fs.renameSync(path.join(VIDDIR, fn + '.fast.mp4'), path.join(VIDDIR, fn)); else fs.unlinkSync(path.join(VIDDIR, fn + '.fast.mp4')) } catch {} r() })); // быстрый старт воспроизведения
      require('child_process').execFile('node', [path.join(__dirname, 'video-dur.js')], { env: process.env, timeout: 120e3 }, () => {}); // длина ролика
      dropFile(o.vid); o.vid = '/video/' + fn; delete o.okV; o.by = me.name; o.at = now; saveOwn();
      return send(res, 200, defRow(sku, b0));
    }
    const bd = await body(req).catch(() => ({}));
    if (m === 'POST' && mp[2] === 'ok') { const k = bd.kind === 'v' ? 'okV' : 'okI'; if (bd.value === false) delete o[k]; else o[k] = 1; o.by = me.name; o.at = now; saveOwn(); return send(res, 200, defRow(sku, b0)) }
    if (m === 'POST' && mp[2] === 'reset') { dropFile(o.img); dropFile(o.vid); delete OWN[sku]; saveOwn(); return send(res, 200, defRow(sku, b0)) }
    return send(res, 404, { error: 'not found' });
  }

  if (p === '/api/catalog') { // все товары: видимость на сайте и цена
    refreshFeed();
    if (!isM) return send(res, 403, { error: 'Только менеджер' });
    if (m === 'GET') return send(res, 200, BASE.map(b => { const o = cat[b.sku] || {}; return { sku: b.sku, name: b.name, cats: b.cats, brand: b.brand, img: FEED.im[b.sku] || b.img, vid: FEED.vd[b.sku] || '', v: b.v, defect: defectOf(b.sku) || null, nostock: FEED.hd.includes(b.sku), own: AUTO[b.sku] && OWN[b.sku] ? { img: !!OWN[b.sku].img, vid: !!OWN[b.sku].vid, okI: !!OWN[b.sku].okI, okV: !!OWN[b.sku].okV } : null, base: b.price, price: o.p > 0 ? o.p : b.price, custom: o.p > 0, hidden: !!o.h || oosOn(b.sku), oos: oosOn(b.sku) ? o.oos : '' } }));
    if (m === 'PATCH') {
      const b = await body(req).catch(() => ({})), skus = (Array.isArray(b.skus) ? b.skus : [b.sku]).map(x => clean(x, 40)).filter(x => BASE.some(i => i.sku === x)).slice(0, 800);
      if (!skus.length) return send(res, 404, { error: 'Товар не найден' });
      let price; if ('price' in b) { if (b.price === null || b.price === '') price = 0; else { price = Math.round(+b.price); if (!(price >= 1 && price <= 1e7)) return send(res, 400, { error: 'Цена в рублях, от 1' }) } }
      const now = new Date().toISOString();
      for (const k of skus) { const o = cat[k] || (cat[k] = {}); if (price !== undefined) { if (price > 0) o.p = price; else delete o.p } if ('hidden' in b) { if (b.hidden) o.h = 1; else { delete o.h; delete o.oos } } o.by = me.name; o.at = now; if (!o.p && !o.h && !oosOn(k)) delete cat[k] }
      persistCat(); return send(res, 200, { ok: true, items: skus.map(k => { const bi = BASE.find(x => x.sku === k), o = cat[k] || {}; return { sku: k, base: bi.price, price: o.p > 0 ? o.p : bi.price, custom: o.p > 0, hidden: !!o.h || oosOn(k), oos: oosOn(k) ? o.oos : '' } }) });
    }
  }

  if (m === 'GET' && p === '/api/stats') {
    if (!isM) return send(res, 403, { error: 'Только менеджер' });
    const all = Object.values(orders), counts = {}; Object.keys(STATUS).forEach(k => counts[k] = 0); all.forEach(o => counts[o.status]++);
    const day = d => new Date(Date.now() - d * 864e5 + 8 * 3600e3).toISOString().slice(0, 10); // по иркутскому времени
    const dl = o => new Date(Date.parse(o.createdAt) + 8 * 3600e3).toISOString().slice(0, 10);
    const days = [...Array(7)].map((_, i) => day(6 - i)).map(d => { const l = all.filter(o => dl(o) === d && o.status !== 'cancelled'); return { day: d, orders: l.length, sum: l.reduce((s, o) => s + o.total, 0) } });
    const done = all.filter(o => o.status === 'delivered');
    return send(res, 200, { counts, days, delivered: done.length, deliveredSum: done.reduce((s, o) => s + o.total, 0), openSum: all.filter(o => !['delivered', 'cancelled'].includes(o.status)).reduce((s, o) => s + o.total, 0) });
  }

  if (p.startsWith('/api/subs') || p.startsWith('/api/broadcasts')) { if (!isM) return send(res, 403, { error: 'Только менеджер' }); if (!SUBS) return send(res, 503, { error: 'Подписчики недоступны' }); return SUBS.route(req, res, url, me, send) }
  if (p === '/api/botinfo') { if (!isM) return send(res, 403, { error: 'Только менеджер' }); return send(res, 200, { tg: TG_BOT, max: MAX_BOT }) }
  if (p === '/api/promo-cards') { // общие настройки всех дисконтных карт
    if (!isM) return send(res, 403, { error: 'Только менеджер' });
    if (m === 'GET') return send(res, 200, { cfg: cardCfg, count: promos.filter(x => x.kind === 'card').length });
    if (m === 'PATCH') {
      const b = await body(req).catch(() => ({})), type = ['percent', 'amount', 'tiers'].includes(b.type) ? b.type : cardCfg.type; let value = null;
      if (type === 'percent') { value = Math.round(+b.value); if (!(value >= 1 && value <= 90)) return send(res, 400, { error: 'Процент от 1 до 90' }) }
      if (type === 'amount') { value = Math.round(+b.value); if (!(value >= 1 && value <= 1e6)) return send(res, 400, { error: 'Сумма скидки в рублях, от 1' }) }
      const until = /^\d{4}-\d{2}-\d{2}$/.test(String(b.until || '')) ? String(b.until) : '';
      cardCfg = { type, value, until, active: b.active !== false }; save(F.cardcfg, cardCfg);
      let n = 0; for (const x of promos) if (x.kind === 'card') { x.type = type; x.value = value; x.until = until; x.active = cardCfg.active; n++ }
      save(F.promos, promos); return send(res, 200, { cfg: cardCfg, count: n });
    }
  }
  if (p === '/api/promos') {
    if (!isM) return send(res, 403, { error: 'Только менеджер' });
    if (m === 'GET') return send(res, 200, promos.map(promoPub).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    const b = await body(req).catch(() => ({}));
    const check = (b, cur) => { // общая проверка полей
      const type = ['percent', 'amount', 'tiers'].includes(b.type) ? b.type : (cur ? cur.type : 'percent');
      let value = null;
      if (type === 'percent') { value = Math.round(+b.value); if (!(value >= 1 && value <= 90)) return { error: 'Процент от 1 до 90' } }
      if (type === 'amount') { value = Math.round(+b.value); if (!(value >= 1 && value <= 1e6)) return { error: 'Сумма скидки в рублях, от 1' } }
      const until = b.until == null ? (cur ? cur.until : '') : (/^\d{4}-\d{2}-\d{2}$/.test(String(b.until)) ? String(b.until) : '');
      const min = b.min == null ? (cur ? cur.min || 0 : 0) : Math.round(+b.min);
      if (!(min >= 0 && min <= 1e7)) return { error: 'Сумма «от» — целое число рублей' };
      return { type, value, until, min };
    };
    if (m === 'POST') {
      const code = normCode(b.code);
      if (!/^[A-Z0-9\u0410-\u042f\u0401_-]{2,30}$/.test(code)) return send(res, 400, { error: 'Код: 2–30 символов, буквы, цифры, «-» или «_»' });
      if (promos.some(x => x.code === code || (x.aliases || []).includes(code))) return send(res, 400, { error: 'Такой код уже есть' });
      const c = check(b); if (c.error) return send(res, 400, c);
      const slug = cleanSlug(b.slug); if (slug === null) return send(res, 400, { error: 'Метка для бота: латиница, цифры, «_» или «-», 2–40 символов' }); if (slug && promos.some(x => x.slug === slug)) return send(res, 400, { error: 'Такая метка уже есть' });
      const pr = { code, kind: b.kind === 'card' ? 'card' : 'promo', type: c.type, value: c.value, until: c.until, min: c.min, note: clean(b.note, 200), active: true, createdAt: new Date().toISOString(), by: me.name, ...(slug ? { slug } : {}) };
      promos.push(pr); save(F.promos, promos); return send(res, 200, promoPub(pr));
    }
    const pr = promos.find(x => x.code === normCode(b.code)); if (!pr) return send(res, 404, { error: 'Код не найден' });
    if (m === 'PATCH') {
      if ('active' in b) pr.active = !!b.active;
      if ('note' in b) pr.note = clean(b.note, 200);
      if ('slug' in b) { const sl = cleanSlug(b.slug); if (sl === null) return send(res, 400, { error: 'Метка для бота: латиница, цифры, «_» или «-», 2–40 символов' }); if (sl && promos.some(x => x !== pr && x.slug === sl)) return send(res, 400, { error: 'Такая метка уже есть' }); if (sl) pr.slug = sl; else delete pr.slug }
      if ('type' in b || 'value' in b || 'until' in b || 'min' in b) { const c = check(b, pr); if (c.error) return send(res, 400, c); pr.type = c.type; pr.value = c.value; pr.until = c.until; pr.min = c.min }
      save(F.promos, promos); return send(res, 200, promoPub(pr));
    }
    if (m === 'DELETE') { promos = promos.filter(x => x !== pr); save(F.promos, promos); return send(res, 200, { ok: true }) }
  }

  if (p === '/api/team') {
    if (me.role !== 'admin') return send(res, 403, { error: 'Только владелец' });
    if (m === 'GET') return send(res, 200, users.map(pub));
    const b = await body(req).catch(() => ({}));
    if (m === 'POST') {
      const name = clean(b.name, 40), r = 'admin', pin = String(b.pin || '');
      if (!name || !/^\d{4,8}$/.test(pin)) return send(res, 400, { error: 'Имя и PIN из 4–8 цифр' });
      const u = { id: uid(), name, role: r, ...hashPin(pin) }; users.push(u); save(F.users, users); return send(res, 200, pub(u));
    }
    if (m === 'PATCH') {
      const u = users.find(x => x.id === b.id); if (!u) return send(res, 404, { error: 'Нет сотрудника' });
      if (b.pin != null) { if (!/^\d{4,8}$/.test(String(b.pin))) return send(res, 400, { error: 'PIN из 4–8 цифр' }); Object.assign(u, hashPin(b.pin)); for (const k in sessions) if (sessions[k].uid === u.id) delete sessions[k] }
      if (b.name) u.name = clean(b.name, 40);
      save(F.users, users); save(F.sessions, sessions); return send(res, 200, pub(u));
    }
    if (m === 'DELETE') {
      const u = users.find(x => x.id === b.id); if (!u) return send(res, 404, { error: 'Нет сотрудника' });
      if (u.role === 'admin' && users.filter(x => x.role === 'admin').length < 2) return send(res, 400, { error: 'Нужен хотя бы один владелец' });
      users = users.filter(x => x !== u); for (const k in sessions) if (sessions[k].uid === u.id) delete sessions[k];
      save(F.users, users); save(F.sessions, sessions); return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: 'not found' });
}

/* ---------- статика ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function stat(req, res, url) {
  let f = decodeURIComponent(url.pathname); if (f === '/') f = '/index.html';
  const full = path.join(PUB, path.normalize(f).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(PUB)) return send(res, 403, 'forbidden');
  fs.readFile(full, (e, d) => {
    if (e) return send(res, 404, 'Не найдено');
    const ext = path.extname(full), h = { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.html' || f === '/sw.js' ? 'no-cache' : 'public, max-age=86400' };
    res.writeHead(200, h); res.end(d);
  });
}

/* ---------- страница замен для клиента: /r/<код> ---------- */
const PAGE_H = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' };
const PAGE_CSS = '*{box-sizing:border-box}body{margin:0;background:#F3F5FA;color:#10162a;font:16px/1.4 -apple-system,Segoe UI,Roboto,Arial,sans-serif;padding-bottom:90px}a{color:#1a5fd0}.hh{background:#080C16;color:#fff;padding:14px 18px;font-weight:800;font-size:18px}.hh b{color:#FFD21F}.w{max-width:640px;margin:0 auto;padding:14px}'
  + '.top{background:#fff;border-bottom:1px solid #dfe3ee;padding:12px 16px}.top h1{font-size:20px;margin:0}.pg{height:8px;background:#e4e8f2;border-radius:6px;margin-top:8px;overflow:hidden}.pg i{display:block;height:100%;background:#1F9D55;border-radius:6px}'
  + '.rc{background:#fff;border:1px solid #dfe3ee;border-radius:14px;padding:12px 14px;margin-bottom:10px}.rc.ok{border-color:#bfe3cc;background:#f3fbf6}.rc.rm{background:#f6f7fa;color:#6b7390}.rc.lk{opacity:.85}.lb{font-weight:800;font-size:12px;letter-spacing:.02em}.x{color:#E5121B}.o{color:#1f7a45}small{display:block;color:#7a84a3;font-size:13px;margin:1px 0 6px}'
  + '.a{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}.a button,.a a.b{flex:1 1 30%;border:0;border-radius:10px;padding:11px 6px;font-weight:800;font-size:14px;background:#EEF1F8;color:#10162a;cursor:pointer;text-align:center;text-decoration:none}.a .p,.a a.b.p{background:#FFD21F}.lnk{background:none;border:0;color:#7a84a3;font-size:13px;padding:6px 0 0;cursor:pointer;text-decoration:underline}.lnk.r{color:#b3261e}'
  + '.big{position:fixed;left:0;right:0;bottom:0;padding:10px 14px;background:rgba(243,245,250,.96);border-top:1px solid #dfe3ee}.big button,.big a{display:block;max-width:612px;margin:0 auto;width:100%;background:#FFD21F;border:0;border-radius:14px;padding:15px;font-weight:900;font-size:16px;color:#10162a;text-align:center;text-decoration:none;cursor:pointer}'
  + '.two{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:8px 0}.two>div{background:#fff;border:1px solid #dfe3ee;border-radius:12px;padding:10px;font-size:14px}.two img{width:100%;height:130px;object-fit:contain;background:#fff;border-radius:8px}.two b{display:block;margin:4px 0}.wk{background:#fff4d6;color:#7a4b00;border-radius:10px;padding:8px 10px;font-size:13px;margin:6px 0}'
  + '.sl{display:flex;gap:10px;align-items:center}.sl img{width:64px;height:64px;object-fit:contain;border-radius:8px;background:#fff;flex:none}.sl>div{flex:1;min-width:0}.done{background:#E6F6EC;border:1px solid #bfe3cc;border-radius:14px;padding:16px;text-align:center;font-weight:800;font-size:18px;margin-bottom:10px}.done span{display:block;font-weight:400;font-size:14px;color:#52597a;margin-top:4px}.bk{display:inline-block;margin:4px 0 10px;font-weight:700;text-decoration:none}';
const pA = (name, sku) => '<a href="' + SITE_BASE() + '/#p/' + encodeURIComponent(sku) + '" target="_blank" rel="noopener">«' + hx(name) + '»</a>';
const shortH = (sku, price) => hx(catName(sku)) + (facts(sku) ? ' · ' + facts(sku) : '') + ' · <b>' + money(price) + '</b>';
function replPage(req, res, url) {
  if (limit('r' + ipOf(req), 120, 60e3)) { res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Слишком много запросов') }
  const parts = url.pathname.split('/'), t = String(parts[2] || '').replace(/[^a-f0-9]/gi, ''), o = t.length >= 16 && Object.values(orders).find(x => x.rt === t);
  if (req.method === 'POST' && parts[3] === 'act') return replAct(req, res, o);
  if (!o) { res.writeHead(404, PAGE_H); return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Страница не найдена</title><body style="font-family:sans-serif;padding:30px">Страница замен не найдена. Проверьте ссылку или напишите нам в бота.</body>') }
  refreshFeed();
  const all = (o.subst || []).filter(c => c.st !== 'cancel'), live = liveCases(o), st = replState(o), base = '/r/' + o.rt;
  const cv = url.searchParams.get('c'), sv = url.searchParams.get('s'), cc = all.find(x => x.id === (cv || sv));
  let body = '';
  if (cc && sv && isOpen(cc) && !cc.supDone) { // самостоятельный выбор: вся категория, от цены минус 30% по возрастанию
    const cs = catOf(cc.sku), inO = o.items.map(i => i.sku), lo = cc.price * 0.7;
    const l = BASE.filter(b => b.sku !== cc.sku && !inO.includes(b.sku) && visibleNow(b) && catOf(b.sku).some(x => cs.includes(x))).map(b => ({ b, pr: priceOf(b.sku, b.price) })).filter(x => x.pr > 0);
    const up = l.filter(x => x.pr >= lo).sort((x, y) => x.pr - y.pr), down = l.filter(x => x.pr < lo).sort((x, y) => y.pr - x.pr);
    body = '<a class="bk" href="' + base + '">← Все замены</a><div class="rc"><span class="lb x">❌ ЗАКОНЧИЛСЯ</span> ' + pA(cc.name, cc.sku) + '<small>' + shortH(cc.sku, cc.price) + '</small><div style="font-size:13px;color:#52597a">Выберите замену из категории «' + hx(cs[0] || '') + '». Сначала товары от цены чуть ниже вашей и дороже, в конце — дешевле.</div></div>'
      + (up.concat(down).map(x => '<div class="rc sl">' + (imgUrl(FEED.im[x.b.sku] || x.b.img) ? '<img src="' + hx(imgUrl(FEED.im[x.b.sku] || x.b.img)) + '" alt="" loading="lazy" onerror="this.remove()">' : '') + '<div>' + pA(x.b.name, x.b.sku) + '<small>' + shortH(x.b.sku, x.pr) + '</small><div class="a"><button class="p" data-a="pick" data-c="' + cc.id + '" data-s="' + hx(x.b.sku) + '">Выбрать</button></div></div></div>').join('') || '<div class="rc">В этой категории сейчас нет подходящих товаров. Можно удалить позицию из заказа или написать нам в бота.</div>');
  } else if (cc && cv) { // карточка позиции крупно
    const of = cc.st === 'ok' ? cc.final : cc.offer, img = x => imgUrl(FEED.im[x.sku] || x.img || (BASE.find(b => b.sku === x.sku) || {}).img);
    const box = (lab, cls, x, pr) => '<div><span class="lb ' + cls + '">' + lab + '</span>' + (img(x) ? '<img src="' + hx(img(x)) + '" alt="" onerror="this.remove()">' : '') + '<b>' + pA(x.name, x.sku) + '</b>' + hx(catName(x.sku)) + (facts(x.sku) ? '<br>' + facts(x.sku).split(' · ').join('<br>') : '') + '<br><b>' + money(pr) + '</b></div>';
    body = '<a class="bk" href="' + base + '">← Все замены</a><div class="two">' + box('❌ ЗАКОНЧИЛСЯ', 'x', cc, cc.price) + (of ? box(cc.st === 'ok' ? '✅ ЗАМЕНА' : '✅ ПРЕДЛОЖЕНИЕ', 'o', of, of.price) : '<div style="display:flex;align-items:center;color:#7a84a3">Автоподбор закончился — выберите товар самостоятельно</div>') + '</div>'
      + (of && of.weaker && cc.st !== 'ok' ? '<div class="wk">Товаров с такими же или лучшими характеристиками сейчас нет — это ближайший вариант.</div>' : '') + caseActs(cc, base, true);
  } else {
    const fin = st.all > 0 && !st.open;
    body = (fin ? '<div class="done">✅ Все замены согласованы<span>Спасибо! Мы передали решение в работу. Пока заказ не передан поставщику, решение можно изменить.</span></div>' : '')
      + all.map(c => caseCard(c, base)).join('') + (fin ? '<div class="a"><a class="b p" href="' + orderLink(o) + '">📄 Состав заказа</a></div>' : '');
  }
  const n = live.filter(canAll).length, bar = !cv && !sv && n ? '<div class="big"><button data-a="all">✅ Утвердить все предложенные (' + n + ')</button></div>' : '';
  const js = '<script>const B=' + JSON.stringify(base) + ';document.addEventListener("click",async e=>{const b=e.target.closest("[data-a]");if(!b)return;const a=b.dataset.a;'
    + 'if(a==="del"&&!confirm("Удалить позицию из заказа?"))return;if(a==="all"&&!confirm("Утвердить все предложенные замены?"))return;b.disabled=true;'
    + 'try{const r=await fetch(B+"/act",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({a,c:b.dataset.c||"",s:b.dataset.s||""})});const j=await r.json().catch(()=>({}));if(!r.ok){alert(j.error||"Не получилось, попробуйте ещё раз");b.disabled=false;return}location.href=B}catch(x){alert("Нет связи, попробуйте ещё раз");b.disabled=false}})</script>';
  const html = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Замены · заказ № ' + hx(o.id) + '</title><style>' + PAGE_CSS + '</style></head><body><div class="hh">Байкал <b>Салют</b></div>'
    + '<div class="top"><h1>Заказ № ' + hx(o.id) + '</h1>Решено <b>' + st.done + ' из ' + st.all + '</b><div class="pg"><i style="width:' + (st.all ? Math.round(st.done / st.all * 100) : 100) + '%"></i></div></div><div class="w">' + body + '</div>' + bar + js + '</body></html>';
  res.writeHead(200, PAGE_H); res.end(html);
}
function caseActs(c, base, big) {
  if (c.supDone) return '<div style="color:#7a84a3;font-size:13px;margin-top:6px">Передано в работу — изменить можно только через оператора.</div>';
  if (c.st === 'ok') return '<button class="lnk" data-a="undo" data-c="' + c.id + '">Изменить решение</button>';
  if (c.st === 'removed') return '<button class="lnk" data-a="undo" data-c="' + c.id + '">Вернуть позицию</button>';
  if (c.st === 'done') return '';
  const self = '<a class="b" href="' + base + '?s=' + c.id + '">🔍 Выбрать самостоятельно</a>', del = '<button class="lnk r" data-a="del" data-c="' + c.id + '">✖ Удалить из заказа</button>';
  if (!c.offer || c.autoOff) return '<div class="a">' + self.replace('class="b"', 'class="b p"') + '</div>' + del;
  return '<div class="a"><button class="p" data-a="ok" data-c="' + c.id + '">✅ Утвердить</button><button data-a="next" data-c="' + c.id + '">🔄 Другой вариант</button>' + self + '</div>' + del + (big ? '' : ' &nbsp; <a class="lnk" href="' + base + '?c=' + c.id + '">Подробнее</a>');
}
function caseCard(c, base) {
  const head = '<span class="lb x">❌ ЗАКОНЧИЛСЯ</span> ' + pA(c.name, c.sku) + '<small>' + shortH(c.sku, c.price) + '</small>';
  if (c.st === 'ok' && c.final) return '<div class="rc ok' + (c.supDone ? ' lk' : '') + '">' + head + '<span class="lb o">✅ ЗАМЕНА УТВЕРЖДЕНА</span> ' + pA(c.final.name, c.final.sku) + '<small>' + shortH(c.final.sku, c.final.price) + '</small>' + caseActs(c, base) + '</div>';
  if (c.st === 'removed') return '<div class="rc rm">' + head + '<b>✖ Удалено из заказа</b><br>' + caseActs(c, base) + '</div>';
  if (c.st === 'done') return '<div class="rc ok">' + head + '<b>✅ Решено с оператором</b></div>';
  const of = c.offer && !c.autoOff ? '<span class="lb o">✅ ПРЕДЛОЖЕНИЕ АВТОЗАМЕНЫ</span> ' + pA(c.offer.name, c.offer.sku) + '<small>' + shortH(c.offer.sku, c.offer.price) + '</small>' + (c.offer.weaker ? '<div class="wk">Товаров с такими же или лучшими характеристиками сейчас нет — это ближайший вариант.</div>' : '') : '<div style="font-size:14px;color:#52597a;margin-bottom:4px">Автоматический подбор закончился. Выберите товар самостоятельно или удалите позицию.</div>';
  return '<div class="rc">' + head + of + caseActs(c, base) + '</div>';
}
async function replAct(req, res, o) {
  if (!o) return send(res, 404, { error: 'Страница не найдена' });
  if (limit('ra' + ipOf(req), 40, 60e3)) return send(res, 429, { error: 'Слишком много нажатий, подождите минуту' });
  const b = await body(req).catch(() => ({})), a = String(b.a || ''); refreshFeed();
  if (a === 'all') { acceptAll(o, 'клиент'); return send(res, 200, { ok: true }) }
  const c = (o.subst || []).find(x => x.id === String(b.c || '')); if (!c) return send(res, 404, { error: 'Позиция не найдена' });
  if (c.supDone) return send(res, 400, { error: 'Эта позиция уже передана в работу. Изменить можно через оператора — напишите нам в бота.' });
  let r;
  if (a === 'ok') r = acceptSubst(o, c, 'клиент');
  else if (a === 'next') r = nextSubst(o, c, 'клиент');
  else if (a === 'pick') { const sku = clean(b.s, 40); if (!catOf(sku).some(x => catOf(c.sku).includes(x))) return send(res, 400, { error: 'Выберите товар из той же категории' }); r = pickSubst(o, c, sku, 'клиент') }
  else if (a === 'del') r = removeItem(o, c, 'клиент');
  else if (a === 'undo') r = undoSubst(o, c, 'клиент');
  else return send(res, 400, { error: 'Неизвестное действие' });
  return r && r.error ? send(res, 400, r) : send(res, 200, { ok: true });
}
function orderPage(req, res, url) { // публичная страница состава заказа по длинной ссылке: /o/<код>
  if (limit('o' + ipOf(req), 60, 60e3)) { res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Слишком много запросов') }
  const t = decodeURIComponent(url.pathname.slice(3)).replace(/[^a-f0-9]/gi, ''), o = t.length >= 16 && Object.values(orders).find(x => x.vt === t);
  const H = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' };
  if (!o) { res.writeHead(404, H); return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Заказ не найден</title><body style="font-family:sans-serif;padding:30px">Заказ не найден. Проверьте ссылку или напишите нам в бота.</body>') }
  const repl = new Set((o.subst || []).filter(c => c.st === 'ok' && c.final).map(c => c.final.sku));
  const rows = o.items.map(i => '<div class="it"><div><b>' + hx(i.name) + '</b>' + (repl.has(i.sku) ? '<span class="ch">замена</span>' : '') + '<small>' + hx(catOf(i.sku)[0] || '') + ' · ' + hx(i.sku) + '</small></div><u>' + money(i.price) + ' × ' + i.qty + '</u></div>').join('');
  const disc = o.discount > 0 ? '<div class="it"><div>' + (o.discountNote ? hx(o.discountNote) : 'Скидка по промокоду<small>' + hx(o.promo || '') + '</small>') + '</div><u>−' + money(o.discount) + '</u></div>' : '';
  const dd = o.deliveryDate ? String(o.deliveryDate).split('-').reverse().join('.') + (o.deliveryInterval ? ', ' + hx(o.deliveryInterval) : '') : '';
  const pay = { unpaid: 'оплата при получении', partial: 'частично оплачен', paid: 'оплачен' }[o.pay] || '';
  const html = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Заказ № ' + hx(o.id) + '</title><style>*{box-sizing:border-box}body{margin:0;background:#F3F5FA;color:#10162a;font:16px/1.4 -apple-system,Segoe UI,Roboto,Arial,sans-serif}.hh{background:#080C16;color:#fff;padding:14px 18px;font-weight:800;font-size:18px}.hh b{color:#FFD21F}.w{max-width:640px;margin:0 auto;padding:18px}h1{font-size:24px;margin:4px 0}.st{display:inline-block;background:#FFD21F;border-radius:8px;padding:4px 10px;font-weight:800;font-size:13px;margin:4px 0 14px}.it{background:#fff;border:1px solid #dfe3ee;border-radius:12px;padding:11px 14px;margin-bottom:8px;display:flex;justify-content:space-between;gap:10px}.it small{display:block;color:#7a84a3;font-size:12px;margin-top:2px}.it u{text-decoration:none;font-weight:700;white-space:nowrap}.ch{font-size:11px;background:#E6F6EC;color:#1f7a45;border-radius:6px;padding:2px 7px;font-weight:700;margin-left:6px}.tt{display:flex;justify-content:space-between;font-weight:900;font-size:20px;margin:14px 2px}.meta{color:#52597a;margin:4px 2px}.dl{display:block;width:100%;background:#FFD21F;border:0;border-radius:14px;padding:15px;font-weight:900;font-size:16px;margin-top:14px;cursor:pointer}.nt{font-size:12px;color:#7a84a3;text-align:center;margin-top:10px}@media print{body{background:#fff}.dl,.nt{display:none}.it{break-inside:avoid}}</style></head><body><div class="hh">Байкал <b>Салют</b></div><div class="w"><h1>Заказ № ' + hx(o.id) + '</h1><span class="st">' + hx(NOTE[o.status] || o.status).replace(/^./, m => m.toUpperCase()) + '</span>' + rows + disc + '<div class="tt"><span>Итого</span><span>' + money(o.total) + '</span></div>' + (dd ? '<div class="meta">Доставка: ' + dd + '</div>' : '') + (o.address ? '<div class="meta">Адрес: ' + hx(o.address) + '</div>' : '') + (pay ? '<div class="meta">Оплата: ' + pay + '</div>' : '') + '<button class="dl" onclick="window.print()">⬇ Сохранить в PDF</button><div class="nt">В окне печати выберите «Сохранить как PDF». Вопросы по заказу — напишите нам в Telegram-боте.</div></div></body></html>';
  res.writeHead(200, H); res.end(html);
}
http.createServer({ requestTimeout: 0, headersTimeout: 60e3 }, async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end() }
  try {
    if (url.pathname === '/order' || url.pathname === '/cart' || url.pathname === '/catalog' || url.pathname === '/notify' || url.pathname === '/promo/check' || url.pathname === '/card/claim' || url.pathname === '/cart/snap' || url.pathname.startsWith('/api/')) {
      const orig = res.writeHead.bind(res); res.writeHead = (c, h) => orig(c, { ...CORS, ...h });
      return await api(req, res, url);
    }
    if (url.pathname.startsWith('/o/') && req.method === 'GET') return orderPage(req, res, url);
    if (url.pathname.startsWith('/r/')) return await replPage(req, res, url);
    stat(req, res, url);
  } catch (e) { console.error(e); if (!res.headersSent) send(res, 500, { error: 'server' }) }
}).listen(PORT, () => { console.log('Байкал Салют: сервер заказов на порту ' + PORT); const ownerOf = o => { // чей заказ (id в Telegram): по привязке статусов или по личной карте клиента
    if (o.notify && o.notify.channel === 'telegram' && o.notify.chatId) return String(o.notify.chatId);
    const pr = o.promo ? findPromo(o.promo) : null; return pr && pr.owner && pr.owner.ch === 'telegram' ? String(pr.owner.id) : '';
  };
  SUBS = require('./subs')({ DATA, alert: alertText, orders: () => orders, ownerOf, testers: () => String(process.env.ALERT_CHAT || '').split(',').map(x => x.trim()).filter(Boolean) }); SUBS.start();
  BOT = require('./cardbot')({ subs: SUBS, promos: () => promos, savePromos: () => save(F.promos, promos), cardDefaults: () => cardCfg, orders: () => orders, persist, statusText, irkToday, substAnswer, claimCard }); BOT.start() });

if (process.env.BS_TEST) module.exports = { view, orders, BASE, orderLink, startOos, substAnswer, remindSubst, flushRepl, replLink, acceptAll, claimCard, setBot: b => { BOT = b }, cat };
