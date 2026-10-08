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
const F = { orders: path.join(DATA, 'orders.json'), users: path.join(DATA, 'users.json'), sessions: path.join(DATA, 'sessions.json'), promos: path.join(DATA, 'promos.json'), carts: path.join(DATA, 'carts.json'), catalog: path.join(DATA, 'catalog.json') };
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const save = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };
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
function durMap() { // sku -> секунды работы (длина ролика минус 2 с заставки)
  let m = 0; try { m = fs.statSync(path.join(DATA, 'video-dur.json')).mtimeMs } catch {}
  if (m !== DURC.m) { DURC = { m, d: load(path.join(DATA, 'video-dur.json'), {}) || {} } }
  const out = {};
  for (const k in FEED.vd) { const e = DURC.d[String(FEED.vd[k]).split('/').pop()]; if (e && e.d > 2) out[k] = Math.max(1, e.d - 2) }
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
  users = [mk('Владелец', 'admin', '0000'), mk('Менеджер', 'manager', '1111'), mk('Кладовщик', 'storekeeper', '2222'), mk('Экспедитор', 'courier', '3333')];
  save(F.users, users);
  console.log('Созданы сотрудники с PIN по умолчанию: Владелец 0000, Менеджер 1111, Кладовщик 2222, Экспедитор 3333. Смените PIN в приложении (вкладка «Команда»).');
}

/* ---------- роли и статусы ---------- */
const ROLES = { admin: 'Владелец', manager: 'Менеджер', storekeeper: 'Кладовщик', courier: 'Экспедитор' };
const STATUS = {
  new: 'Новый', confirmed: 'В обработке', picking: 'Размещён', packed: 'Собран',
  shipping: 'В доставке', delivered: 'Отгружен', failed: 'Не доставлен', cancelled: 'Отменён'
};
const PAY = { unpaid: 'Не оплачен', partial: 'Частично оплачен', paid: 'Оплачен' }; // статус оплаты — отдельно от статуса заказа
const M = ['manager', 'admin'];
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
const SEES = { admin: null, manager: null, storekeeper: ['confirmed', 'picking', 'packed'], courier: ['packed', 'shipping', 'failed', 'delivered'] };

/* ---------- промокоды и дисконтные карты ---------- */
const normCode = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\s]/g, '').toUpperCase().slice(0, 30);
const TIER = t => t < 5000 ? 5 : t < 20000 ? 10 : t < 50000 ? 15 : t < 100000 ? 20 : t < 500000 ? 25 : 30; // система скидок по сумме заказа
const promoDiscount = (p, total) => p.type === 'percent' ? Math.round(total * p.value / 100) : p.type === 'amount' ? Math.min(Math.round(p.value), total) : Math.round(total * TIER(total) / 100);
const irkToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const promoState = p => !p.active ? 'paused' : (p.until && p.until < irkToday() ? 'expired' : 'ok');
const findPromo = code => { const c = normCode(code); return c ? promos.find(p => p.code === c || (p.aliases || []).includes(c)) : null };
const promoPub = p => { const used = Object.values(orders).filter(o => o.status !== 'cancelled' && [p.code, ...(p.aliases || [])].includes(normCode(o.promo))); return { ...p, state: promoState(p), uses: used.length, sum: used.reduce((s, o) => s + o.total, 0), disc: used.reduce((s, o) => s + (o.discount || 0), 0) } };

function view(o, role) {
  const v = { ...o, next: nextFor(role, o.status) };
  if (o.notify) v.notify = { channel: o.notify.channel, email: o.notify.email || '', linked: !!o.notify.linked };
  if (M.includes(role) && o.promo) { const p = findPromo(o.promo), base = o.items.reduce((s, i) => s + i.sum, 0); v.promoInfo = p ? { state: o.discount > 0 ? 'applied' : promoState(p), kind: p.kind, type: p.type, value: p.value, discount: o.discount > 0 ? o.discount : promoDiscount(p, base) } : { state: 'unknown' } }
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
let BOT = null;
// Уведомление о новом заказе в служебный бот (ALERT_TOKEN, ALERT_CHAT в /etc/bs.env) — только для владельца
const ALERT_TOKEN = process.env.ALERT_TOKEN || '', ALERT_CHAT = process.env.ALERT_CHAT || '', ALERT_CH = process.env.ALERT_CHANNEL || 'telegram', MAX_API_A = process.env.MAX_API || 'https://platform-api.max.ru';
function alertOrder(o) {
  if (!ALERT_TOKEN || !ALERT_CHAT) return;
  const rub = n => Math.round(n).toString().replace(/\B(?=(\d{3})+$)/g, ' ') + ' ₽';
  const d = o.deliveryDate ? o.deliveryDate.split('-').reverse().join('.') : 'не указана';
  const text = '🛒 Новый заказ № ' + o.id + '\nСумма: ' + rub(o.total) + '\nДоставка: ' + d + (o.deliveryInterval ? ', ' + o.deliveryInterval : '') + '\nАдрес: ' + (o.address || 'не указан') + '\nКлиент: ' + o.name + '\nТелефон: ' + o.phone;
  const req = ALERT_CH === 'max'
    ? fetch(MAX_API_A + '/messages?chat_id=' + encodeURIComponent(ALERT_CHAT), { method: 'POST', headers: { 'content-type': 'application/json', authorization: ALERT_TOKEN }, body: JSON.stringify({ text }) })
    : fetch(TG_API + '/bot' + ALERT_TOKEN + '/sendMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: ALERT_CHAT, text }) });
  req.catch(e => console.error('alert', e.message));
}
function notifyOrder(o, text) { const n = o.notify; if (!n || !n.chatId || !BOT) return; if (n.channel === 'telegram' || n.channel === 'max') BOT.send(n.channel, n.chatId, text) }
const statusText = o => 'Заказ № ' + o.id + ': ' + (NOTE[o.status] || o.status) + (o.status === 'shipping' && o.deliveryInterval ? '. Доставка: ' + o.deliveryInterval : '').replace(/([^.!])$/, '$1.');
const priceOf = (sku, p) => { const o = cat[sku]; return o && o.p > 0 ? o.p : p }; // цена, выставленная менеджером, главнее цены с сайта
const digits = s => String(s || '').replace(/\D/g, '').replace(/^8(?=\d{10}$)/, '7');
for (const k in carts) if (Date.now() - Date.parse(carts[k].updatedAt) > 30 * 864e5) delete carts[k]; // брошенные корзины старше 30 дней убираем
function cartItems(items, fix) { return (Array.isArray(items) ? items.slice(0, 80) : []).map(i => ({ sku: clean(i.sku, 40), name: clean(i.name, 200), qty: Math.max(1, Math.min(999, Math.floor(+i.qty || 1))), price: Math.max(0, fix ? priceOf(clean(i.sku, 40), +i.price || 0) : +i.price || 0) })).map(i => ({ ...i, sum: i.price * i.qty })) }
function cartCalc(c) { // сумма, скидка (вручную перекрывает промокод) и итог
  const sum = c.items.reduce((s, i) => s + i.sum, 0), mv = c.manual && +c.manual.value > 0 ? c.manual : null; let discount = 0, kind = '', state = ''; c.promoInfo = null;
  if (mv) { discount = mv.type === 'pct' ? Math.round(sum * Math.min(100, mv.value) / 100) : Math.min(Math.round(mv.value), sum); kind = 'manual' }
  else if (c.promo) { const pr = findPromo(c.promo); state = !pr ? 'unknown' : promoState(pr); if (pr && state === 'ok') { discount = promoDiscount(pr, sum); kind = 'promo' } c.promoInfo = pr ? { state, type: pr.type, value: pr.value } : { state: 'unknown' } } else c.promoInfo = null;
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
    persist(); alertOrder(orders[id]); return send(res, 200, { ok: true, id, total: sumAll - discount, discount }, CORS);
  }

  if (m === 'GET' && p === '/promo/check') { // сайт спрашивает, действует ли код
    if (limit('c' + ipOf(req), 60, 60e3)) return send(res, 429, { ok: false }, CORS);
    const pr = findPromo(url.searchParams.get('code'));
    if (!pr || promoState(pr) !== 'ok') return send(res, 200, { ok: false }, CORS);
    return send(res, 200, { ok: true, kind: pr.kind, type: pr.type, value: pr.value }, CORS);
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
    const o = {}; for (const k in cat) { const v = cat[k]; if (v.h || v.p > 0) o[k] = { ...(v.p > 0 ? { p: v.p } : {}), ...(v.h ? { h: 1 } : {}) } }
    refreshFeed(); return send(res, 200, { o, f: { t: FEED.t, im: FEED.im, vd: FEED.vd, du: durMap(), nm: FEED.nm, pr: FEED.pr, hd: FEED.hd, ad: FEED.ad.map(a => { const { fin, ...r } = a; return r }) } }, { ...CORS, 'cache-control': 'no-store' });
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

  let mm = p.match(/^\/api\/orders\/([^/]+)(?:\/(status|pick))?$/);
  if (mm) {
    const o = orders[decodeURIComponent(mm[1])]; if (!o) return send(res, 404, { error: 'Заказ не найден' });
    if (SEES[role] && !SEES[role].includes(o.status)) return send(res, 403, { error: 'Нет доступа' });
    const b = m === 'GET' ? {} : await body(req).catch(() => ({}));
    if (m === 'GET' && !mm[2]) return send(res, 200, view(o, role));

    if (m === 'POST' && mm[2] === 'status') {
      const to = b.status; if (!STATUS[to] || !canMove(role, o.status, to)) return send(res, 403, { error: 'Этот переход вам недоступен' });
      const note = clean(b.note, 300);
      if ((to === 'failed' || to === 'cancelled') && !note) return send(res, 400, { error: 'Укажите причину' });
      if (to === 'packed' && !isM && !o.items.every(i => i.picked)) return send(res, 400, { error: 'Отметьте все позиции собранными' });
      if (to === 'packed' && isM && !o.items.every(i => i.picked) && !note) return send(res, 400, { error: 'Не все позиции отмечены собранными. Напишите комментарий, чтобы продолжить.' });
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
    if (m === 'GET') return send(res, 200, BASE.map(b => { const o = cat[b.sku] || {}; return { sku: b.sku, name: b.name, cats: b.cats, brand: b.brand, img: FEED.im[b.sku] || b.img, vid: FEED.vd[b.sku] || '', v: b.v, defect: defectOf(b.sku) || null, nostock: FEED.hd.includes(b.sku), own: AUTO[b.sku] && OWN[b.sku] ? { img: !!OWN[b.sku].img, vid: !!OWN[b.sku].vid, okI: !!OWN[b.sku].okI, okV: !!OWN[b.sku].okV } : null, base: b.price, price: o.p > 0 ? o.p : b.price, custom: o.p > 0, hidden: !!o.h } }));
    if (m === 'PATCH') {
      const b = await body(req).catch(() => ({})), skus = (Array.isArray(b.skus) ? b.skus : [b.sku]).map(x => clean(x, 40)).filter(x => BASE.some(i => i.sku === x)).slice(0, 800);
      if (!skus.length) return send(res, 404, { error: 'Товар не найден' });
      let price; if ('price' in b) { if (b.price === null || b.price === '') price = 0; else { price = Math.round(+b.price); if (!(price >= 1 && price <= 1e7)) return send(res, 400, { error: 'Цена в рублях, от 1' }) } }
      const now = new Date().toISOString();
      for (const k of skus) { const o = cat[k] || (cat[k] = {}); if (price !== undefined) { if (price > 0) o.p = price; else delete o.p } if ('hidden' in b) { if (b.hidden) o.h = 1; else delete o.h } o.by = me.name; o.at = now; if (!o.p && !o.h) delete cat[k] }
      persistCat(); return send(res, 200, { ok: true, items: skus.map(k => { const bi = BASE.find(x => x.sku === k), o = cat[k] || {}; return { sku: k, base: bi.price, price: o.p > 0 ? o.p : bi.price, custom: o.p > 0, hidden: !!o.h } }) });
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
      return { type, value, until };
    };
    if (m === 'POST') {
      const code = normCode(b.code);
      if (!/^[A-Z0-9\u0410-\u042f\u0401_-]{3,30}$/.test(code)) return send(res, 400, { error: 'Код: 3–30 символов, буквы, цифры, «-» или «_»' });
      if (promos.some(x => x.code === code || (x.aliases || []).includes(code))) return send(res, 400, { error: 'Такой код уже есть' });
      const c = check(b); if (c.error) return send(res, 400, c);
      const pr = { code, kind: b.kind === 'card' ? 'card' : 'promo', type: c.type, value: c.value, until: c.until, note: clean(b.note, 200), active: true, createdAt: new Date().toISOString(), by: me.name };
      promos.push(pr); save(F.promos, promos); return send(res, 200, promoPub(pr));
    }
    const pr = promos.find(x => x.code === normCode(b.code)); if (!pr) return send(res, 404, { error: 'Код не найден' });
    if (m === 'PATCH') {
      if ('active' in b) pr.active = !!b.active;
      if ('note' in b) pr.note = clean(b.note, 200);
      if ('type' in b || 'value' in b || 'until' in b) { const c = check(b, pr); if (c.error) return send(res, 400, c); pr.type = c.type; pr.value = c.value; pr.until = c.until }
      save(F.promos, promos); return send(res, 200, promoPub(pr));
    }
    if (m === 'DELETE') { promos = promos.filter(x => x !== pr); save(F.promos, promos); return send(res, 200, { ok: true }) }
  }

  if (p === '/api/team') {
    if (me.role !== 'admin') return send(res, 403, { error: 'Только владелец' });
    if (m === 'GET') return send(res, 200, users.map(pub));
    const b = await body(req).catch(() => ({}));
    if (m === 'POST') {
      const name = clean(b.name, 40), r = b.role, pin = String(b.pin || '');
      if (!name || !ROLES[r] || !/^\d{4,8}$/.test(pin)) return send(res, 400, { error: 'Имя, роль и PIN из 4–8 цифр' });
      const u = { id: uid(), name, role: r, ...hashPin(pin) }; users.push(u); save(F.users, users); return send(res, 200, pub(u));
    }
    if (m === 'PATCH') {
      const u = users.find(x => x.id === b.id); if (!u) return send(res, 404, { error: 'Нет сотрудника' });
      if (b.pin != null) { if (!/^\d{4,8}$/.test(String(b.pin))) return send(res, 400, { error: 'PIN из 4–8 цифр' }); Object.assign(u, hashPin(b.pin)); for (const k in sessions) if (sessions[k].uid === u.id) delete sessions[k] }
      if (b.name) u.name = clean(b.name, 40);
      if (b.role && ROLES[b.role]) { if (u.role === 'admin' && b.role !== 'admin' && users.filter(x => x.role === 'admin').length < 2) return send(res, 400, { error: 'Нужен хотя бы один владелец' }); u.role = b.role }
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

http.createServer({ requestTimeout: 0, headersTimeout: 60e3 }, async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end() }
  try {
    if (url.pathname === '/order' || url.pathname === '/cart' || url.pathname === '/catalog' || url.pathname === '/notify' || url.pathname === '/promo/check' || url.pathname.startsWith('/api/')) {
      const orig = res.writeHead.bind(res); res.writeHead = (c, h) => orig(c, { ...CORS, ...h });
      return await api(req, res, url);
    }
    stat(req, res, url);
  } catch (e) { console.error(e); if (!res.headersSent) send(res, 500, { error: 'server' }) }
}).listen(PORT, () => { console.log('Байкал Салют: сервер заказов на порту ' + PORT); BOT = require('./cardbot')({ promos: () => promos, savePromos: () => save(F.promos, promos), orders: () => orders, persist, statusText, irkToday }); BOT.start() });
