'use strict';
// Бот дисконтных карт и статусов заказов: Telegram и MAX. Без внешних библиотек.
// Клиент пишет боту /start — получает личную карту (один клиент = одна карта). Номер карты вводится в корзине на сайте.
// Переменные (/etc/bs.env): TG_TOKEN, TG_BOT, SHOP_URL | MAX_TOKEN, MAX_BOT | SITE_URL, CARD_IMG
const crypto = require('crypto');
const E = process.env;
const TG = E.TG_TOKEN || '', TG_API = E.TG_API || 'https://api.telegram.org';
const MAXT = E.MAX_TOKEN || '', MAX_API = E.MAX_API || 'https://platform-api.max.ru';
const SITE = (E.SITE_URL || '').replace(/\/$/, ''), CARD_IMG = E.CARD_IMG || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fs = require('fs'), path = require('path');
const SUPPORT = E.SUPPORT_URL || 'https://t.me/baikalsalut', WELCOME_IMG = E.WELCOME_IMG || CARD_IMG;
const LEGACY = E.LEGACY_MENU !== '0'; // меню как в BotHelp (скидки / оплата, доставка / поддержка). После переезда: LEGACY_MENU=0
const DISC_IMG = path.join(__dirname, 'assets', 'discounts.png');
async function sendPhotoFile(chat, file, caption, kb, fname) { // картинка с диска; если не вышло — просто текст
  try {
    const fd = new FormData(); fd.append('chat_id', String(chat)); fd.append('caption', caption); if (kb) fd.append('reply_markup', JSON.stringify(kb)); fd.append('photo', new Blob([fs.readFileSync(file)]), fname || 'a.png');
    const r = await (await fetch(TG_API + '/bot' + TG + '/sendPhoto', { method: 'POST', body: fd })).json(); if (r.ok) return r;
  } catch (e) { console.error('bot photo', e.message) }
  return jpost(TG_API + '/bot' + TG + '/sendMessage', { chat_id: chat, text: caption, ...(kb ? { reply_markup: kb } : {}) });
}
const CARDDIR = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'cards');
function cardPic(code) { // красивая картинка карты с номером (python3 + Pillow), один раз на карту — дальше из папки
  const f = path.join(CARDDIR, String(code).replace(/[^0-9A-Za-z-]/g, '') + '.png');
  if (fs.existsSync(f)) return Promise.resolve(f);
  try { fs.mkdirSync(CARDDIR, { recursive: true }) } catch {}
  return new Promise(ok => require('child_process').execFile('python3', [path.join(__dirname, 'cardimg.py'), String(code), f], { timeout: 30e3 }, e => ok(!e && fs.existsSync(f) ? f : '')));
}
const IK = rows => ({ inline_keyboard: rows }), URLB = (t, u) => ({ text: t, url: u });
const SHOP_URL = (E.SHOP_URL || 'https://salut38.shop').replace(/\/$/, ''), WELCOME_FILE = path.join(__dirname, 'assets', 'welcome.jpg'); // SHOP_URL — куда ведут кнопки «выбрать салют / в магазин» (пока старый сайт)
const SHOP = SHOP_URL ? [URLB('в магазин', SHOP_URL)] : [];
const sendWelcome = chat => fs.existsSync(WELCOME_FILE) ? sendPhotoFile(chat, WELCOME_FILE, HOME_TXT, HOME_KB, 'welcome.jpg') : send('telegram', chat, HOME_TXT, WELCOME_IMG, HOME_KB);
const HOME_KB = IK([[{ text: 'скидки', callback_data: 'disc' }, ...(SHOP_URL ? [URLB('выбрать салют', SHOP_URL)] : [])], [{ text: 'оплата, доставка', callback_data: 'pay' }], [URLB('обратиться в поддержку', SUPPORT)]]);
const HOME_TXT = '🎁 Байкал Салют поддержка, рады поделиться с вами списком актуальных промокодов на скидки от 5% до 30%.\n\n🧐 Есть вопросы? Напишите нам в телеграм по ссылке: ' + SUPPORT + '\n\n👇 Нажмите кнопку "скидки", чтобы получить список промокодов 👇';
const DISC_TXT = '👉 Промокоды вводятся после добавления товаров в корзину перед нажатием на кнопку "Оформить заказ".\n🛒 Приятных вам покупок)';
const PAY_TXT = '🚚 По городу Иркутску бесплатная доставка до ваших дверей.\n👋 Дату и время доставки вы выбираете сами\n💰 Вы оплачиваете заказ только после его получения';
const jpost = (url, body, headers) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(r => r.json().catch(() => ({}))).catch(e => { console.error('bot', e.message); return {} });

async function send(ch, chat, text, photo, kb, html) {
  if (!chat) return;
  if (ch === 'telegram' && TG) {
    if (photo) { const r = await jpost(TG_API + '/bot' + TG + '/sendPhoto', { chat_id: chat, photo, caption: text, ...(html ? { parse_mode: 'HTML' } : {}), ...(kb ? { reply_markup: kb } : {}) }); if (r.ok) return }
    return jpost(TG_API + '/bot' + TG + '/sendMessage', { chat_id: chat, text, ...(html ? { parse_mode: 'HTML', disable_web_page_preview: true } : {}), ...(kb ? { reply_markup: kb } : {}) });
  }
  if (ch === 'max' && MAXT) return jpost(MAX_API + '/messages?chat_id=' + encodeURIComponent(chat), { text }, { authorization: MAXT });
}

module.exports = function init(ctx) { // ctx: promos(), savePromos(), orders(), persist(), statusText(o), irkToday()
  const last = new Map();
  const newCode = () => { const promos = ctx.promos(); for (;;) { const n = String(crypto.randomInt(0, 1e6)).padStart(6, '0'), code = '38-' + n; if (!promos.some(p => p.code === code || (p.aliases || []).includes('38' + n))) return { code, alias: '38' + n } } };
  function cardFor(ch, id, name) {
    const promos = ctx.promos(); let c = promos.find(p => p.owner && p.owner.ch === ch && p.owner.id === String(id));
    if (!c) { const k = newCode(); c = { code: k.code, aliases: [k.alias], kind: 'card', ...(ctx.cardDefaults ? (({ type, value, until, active }) => ({ type, value, until, active }))(ctx.cardDefaults()) : { type: 'tiers', value: null, until: '', active: true }), note: 'Бот ' + ch + (name ? ': ' + String(name).slice(0, 40) : ''), createdAt: new Date().toISOString(), by: 'бот', owner: { ch, id: String(id) } }; promos.push(c); ctx.savePromos() }
    return c;
  }
  const cardText = c => 'Ваша дисконтная карта «Байкал Салют»\n№ ' + c.code + '\n\nСкидка от 5% до 30% — чем больше заказ, тем больше скидка. Введите номер карты в корзине, в поле «Промокод или номер дисконтной карты».' + (SHOP_URL ? '\n\nСайт: ' + SHOP_URL : '') + '\n\nКарта личная, хранится у нас: если потеряете, напишите боту /card — пришлём снова.';
  const KB = { keyboard: [[{ text: '💳 Моя карта' }, { text: '📦 Мой заказ' }]], resize_keyboard: true };
  const dLabel = p => p.type === 'percent' ? 'Скидка ' + p.value + '%' : p.type === 'amount' ? 'Скидка ' + p.value + ' ₽' : 'Скидка от 5% до 30% (зависит от суммы заказа)';
  const fmtD = d => String(d).split('-').reverse().join('.');
  const promoText = p => 'Ваш промокод: ' + p.code + '\n' + dLabel(p) + (p.until ? '\nДействует до ' + fmtD(p.until) : '') + '\n\nВведите его в корзине на сайте, в поле «Промокод или номер дисконтной карты».' + (SHOP_URL ? '\n\nСайт: ' + SHOP_URL : '');
  const welcome = 'Здравствуйте! Это бот магазина «Байкал Салют».\n\n💳 Моя карта — личная дисконтная карта\n📦 Мой заказ — статус заказа (напишите номер заказа и последние 4 цифры телефона, например: 1234 5678)\n\nПромокоды выдаются по ссылкам из акций и рекламы.' + (SHOP_URL ? '\n\nСайт: ' + SHOP_URL : '');
  const fails = new Map(); // защита от подбора заказов: не больше 5 неудач в час с одного чата
  const failOk = id => { const f = (fails.get(id) || []).filter(t => Date.now() - t < 36e5); fails.set(id, f); if (fails.size > 5000) fails.clear(); return f.length < 5 };
  const failAdd = id => { const f = fails.get(id) || []; f.push(Date.now()); fails.set(id, f) };
  async function handle(ch, u) { // u: { chatId, userId, name, text }
    const text0 = String(u.text || '').trim(), t = Date.now();
    if (t - (last.get(u.chatId) || 0) < 1500) { // быстрые подряд сообщения: команды игнорируем, а живой текст не теряем — он уходит в «Сообщения»
      if (u.ch !== 'max' && ch === 'telegram' && ctx.subs && text0 && !text0.startsWith('/')) ctx.subs.inMsg(u.userId || u.chatId, u.name, text0, TG);
      return;
    }
    last.set(u.chatId, t); if (last.size > 5000) last.clear();
    const text = text0, sm = text.match(/^\/start(?:\s+(\S+))?/), key = sm && sm[1];
    const sid = u.userId || u.chatId;
    if (ch === 'telegram' && /^\/stop\b/i.test(text)) { ctx.subs && ctx.subs.setSt(sid, 'unsub', TG); return send(ch, u.chatId, 'Вы отписались от рассылок. Заказы и статусы это не затрагивает. Чтобы вернуться, нажмите /start.') }
    if (ch === 'telegram' && ctx.subs) ctx.subs.touch(sid, { start: !!sm, name: u.name, tag: key && /^card(_|$)/.test(key) ? 'бот:карта' : key && key.startsWith('promo_') ? 'бот:' + key : '' }, TG);
    const kb = ch === 'telegram' && !LEGACY ? KB : undefined, say = (x, photo) => send(ch, u.chatId, x, photo, kb);
    const home = () => ch === 'telegram' && LEGACY ? sendWelcome(u.chatId) : say(welcome);
    const card = cs => { const c = cardFor(ch, u.userId || u.chatId, u.name); if (cs && ctx.claimCard) ctx.claimCard(cs, c.code); if (ch === 'telegram') { const kb = (SITE || SHOP_URL) ? { inline_keyboard: [[{ text: '🛒 Вернуться в магазин', url: (SITE || SHOP_URL) + '/#card/' + encodeURIComponent(c.code) }]] } : undefined; return cardPic(c.code).then(f => f ? sendPhotoFile(u.chatId, f, cardText(c), kb, 'card.png') : send(ch, u.chatId, cardText(c), CARD_IMG, kb)) } return say(cardText(c), ch === 'telegram' ? CARD_IMG : '') }; // кнопка ведёт на сайт с номером карты — скидка применится сама // cs — метка сайта: сайт сам подхватит номер карты
    if (sm) { // переход по ссылке: параметр после start решает, что показать
      if (key === 'card') return card();
      if (key && /^card_[a-f0-9]{12,40}$/.test(key)) return card(key.slice(5));
      if (key === 'discounts' && ch === 'telegram') return sendPhotoFile(u.chatId, DISC_IMG, DISC_TXT, IK([[{ text: 'назад', callback_data: 'home' }, ...SHOP]])); // то же, что кнопка «скидки» в меню: список промокодов 5–30%
      if (key && key.startsWith('promo_')) {
        const slug = key.slice(6).toLowerCase(), p = ctx.promos().find(x => x.kind === 'promo' && x.slug === slug);
        if (p && p.active && !(p.until && p.until < ctx.irkToday())) {
          const pf = path.join(__dirname, 'assets', 'promo-' + slug + '.jpg'); // своя картинка к промокоду: assets/promo-<метка>.jpg
          if (ch === 'telegram' && fs.existsSync(pf)) return sendPhotoFile(u.chatId, pf, promoText(p), kb, 'promo.jpg');
          return say(promoText(p));
        }
        return say('К сожалению, этот промокод уже не действует.' + (SHOP_URL ? '\nАктуальные предложения: ' + SHOP_URL : ''));
      }
      const o = key && Object.values(ctx.orders()).find(x => x.notify && x.notify.token === key && x.notify.channel === ch);
      if (o) { o.notify.chatId = String(u.chatId); o.notify.linked = true; ctx.persist(); return say('Готово! Будем сообщать о статусе заказа здесь.\n' + ctx.statusText(o)) }
      return home(); // просто /start — человек нашёл бота сам или ему его переслали
    }
    if (/^\/card\b/i.test(text) || /моя карта/i.test(text)) return card();
    if (/^\/order\b/i.test(text) || /мой заказ/i.test(text)) {
      const mine = Object.values(ctx.orders()).filter(x => x.notify && x.notify.chatId === String(u.chatId) && x.notify.channel === ch).slice(-3);
      if (mine.length) return say(mine.map(ctx.statusText).join('\n'));
      return say('Напишите номер заказа и последние 4 цифры телефона, например: 1234 5678');
    }
    const m = text.match(/^№?\s*(\S+)\s+(\d{4})$/);
    if (m) {
      if (!failOk(u.chatId)) return say('Слишком много попыток. Попробуйте позже или позвоните нам.');
      const o = ctx.orders()[m[1]];
      if (o && String(o.phone || '').replace(/\D/g, '').endsWith(m[2])) return say(ctx.statusText(o));
      failAdd(u.chatId); return say('Заказ не найден. Проверьте номер заказа и последние 4 цифры телефона.');
    }
    if (ch === 'telegram' && ctx.subs && text) { // обычное сообщение человека — не команда меню: передаём сотрудникам
      const ack = ctx.subs.inMsg(sid, u.name, text, TG);
      return ack ? say('Спасибо, сообщение получено! Ответим здесь в ближайшее время.') : undefined;
    }
    return home();
  }
  async function onCallback(q) { // нажатия кнопок меню
    const chat = q.message && q.message.chat && q.message.chat.id; if (!chat) return;
    jpost(TG_API + '/bot' + TG + '/answerCallbackQuery', { callback_query_id: q.id });
    if (ctx.subs) ctx.subs.touch(q.from && q.from.id || chat, { name: q.from && q.from.first_name }, TG);
    const d = q.data;
    if (/^s[onfpcydzabr]:/.test(d) && ctx.substAnswer) { // замена товара: so утвердить, sn следующая, sf/sp список, sc выбор, sy подтвердить, sd/sz удаление
      const [k, oid, cid, arg] = d.split(':'), act = { so: 'ok', sn: 'next', sf: 'self', sp: 'list', sc: 'pick', sy: 'yes', sd: 'del', sz: 'delyes', sa: 'all', sb: 'allyes', sr: 'back' }[k];
      const res = ctx.substAnswer(act, oid, cid, chat, arg), mid = q.message && q.message.message_id, ed = (m, b) => mid && jpost(TG_API + '/bot' + TG + '/' + m, { chat_id: chat, message_id: mid, ...b });
      if (res && typeof res === 'object' && res.list && q.message.text !== undefined && !q.message.photo) return ed('editMessageText', { text: res.text, ...(res.html ? { parse_mode: 'HTML', disable_web_page_preview: true } : {}), reply_markup: res.kb });
      if (mid) ed('editMessageReplyMarkup', { reply_markup: { inline_keyboard: [] } });
      if (!res) return;
      return typeof res === 'string' ? send('telegram', chat, res) : send('telegram', chat, res.text, res.photo || '', res.kb, res.html);
    }
    if (d === 'disc') return sendPhotoFile(chat, DISC_IMG, DISC_TXT, IK([[{ text: 'назад', callback_data: 'home' }, ...SHOP]]));
    if (d === 'pay') return send('telegram', chat, PAY_TXT, '', IK([[{ text: 'назад', callback_data: 'home' }, ...SHOP], [URLB('обратиться в поддержку', SUPPORT)]]));
    if (d === 'home') return sendWelcome(chat);
  }
  async function tgPoll() {
    let off = 0;
    for (;;) {
      try {
        const r = await (await fetch(TG_API + '/bot' + TG + '/getUpdates?timeout=25&offset=' + off)).json();
        for (const u of r.result || []) {
          off = u.update_id + 1;
          if (u.callback_query) { await onCallback(u.callback_query); continue }
          if (u.my_chat_member && u.my_chat_member.chat && u.my_chat_member.chat.type === 'private' && ctx.subs) { const s = u.my_chat_member.new_chat_member && u.my_chat_member.new_chat_member.status; if (s === 'kicked' || s === 'left') ctx.subs.setSt(u.my_chat_member.chat.id, 'blocked', TG); continue }
          const m = u.message; if (!m || m.chat.type !== 'private') continue; await handle('telegram', { chatId: m.chat.id, userId: m.from && m.from.id, name: m.from && m.from.first_name, text: m.text || m.caption || (m.photo ? '[фото]' : m.voice ? '[голосовое сообщение]' : m.video || m.video_note ? '[видео]' : m.document ? '[файл]' : m.sticker ? '[стикер]' : m.location ? '[геопозиция]' : m.contact ? '[контакт]' : '') }) }
      } catch (e) { await sleep(5000) }
    }
  }
  async function maxPoll() {
    let marker = '';
    for (;;) {
      try {
        const r = await (await fetch(MAX_API + '/updates?timeout=25&types=message_created,bot_started' + (marker ? '&marker=' + marker : ''), { headers: { authorization: MAXT } })).json();
        if (r.marker != null) marker = r.marker;
        for (const u of r.updates || []) {
          if (u.update_type === 'bot_started') await handle('max', { chatId: u.chat_id, userId: u.user && u.user.user_id, name: u.user && (u.user.first_name || u.user.name), text: '/start ' + (u.payload || '') });
          else if (u.update_type === 'message_created' && u.message) { const m = u.message, id = m.recipient && m.recipient.chat_id; await handle('max', { chatId: id, userId: m.sender && m.sender.user_id, name: m.sender && (m.sender.first_name || m.sender.name), text: (m.body && m.body.text) || '' }) }
        }
      } catch (e) { await sleep(5000) }
    }
  }
  return { send, start() { if (TG) { tgPoll(); console.log('Telegram-бот подключён') } if (MAXT) { maxPoll(); console.log('MAX-бот подключён') } } };
};
