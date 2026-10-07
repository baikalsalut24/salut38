'use strict';
// Бот дисконтных карт и статусов заказов: Telegram и MAX. Без внешних библиотек.
// Клиент пишет боту /start — получает личную карту (один клиент = одна карта). Номер карты вводится в корзине на сайте.
// Переменные (/etc/bs.env): TG_TOKEN, TG_BOT | MAX_TOKEN, MAX_BOT | SITE_URL, CARD_IMG
const crypto = require('crypto');
const E = process.env;
const TG = E.TG_TOKEN || '', TG_API = E.TG_API || 'https://api.telegram.org';
const MAXT = E.MAX_TOKEN || '', MAX_API = E.MAX_API || 'https://platform-api.max.ru';
const SITE = (E.SITE_URL || '').replace(/\/$/, ''), CARD_IMG = E.CARD_IMG || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jpost = (url, body, headers) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(r => r.json().catch(() => ({}))).catch(e => { console.error('bot', e.message); return {} });

async function send(ch, chat, text, photo) {
  if (!chat) return;
  if (ch === 'telegram' && TG) {
    if (photo) { const r = await jpost(TG_API + '/bot' + TG + '/sendPhoto', { chat_id: chat, photo, caption: text }); if (r.ok) return }
    return jpost(TG_API + '/bot' + TG + '/sendMessage', { chat_id: chat, text });
  }
  if (ch === 'max' && MAXT) return jpost(MAX_API + '/messages?chat_id=' + encodeURIComponent(chat), { text }, { authorization: MAXT });
}

module.exports = function init(ctx) { // ctx: promos(), savePromos(), orders(), persist(), statusText(o), irkToday()
  const last = new Map();
  const newCode = () => { const promos = ctx.promos(); for (;;) { const n = String(crypto.randomInt(0, 1e6)).padStart(6, '0'), code = '38-' + n; if (!promos.some(p => p.code === code || (p.aliases || []).includes('38' + n))) return { code, alias: '38' + n } } };
  function cardFor(ch, id, name) {
    const promos = ctx.promos(); let c = promos.find(p => p.owner && p.owner.ch === ch && p.owner.id === String(id));
    if (!c) { const k = newCode(); c = { code: k.code, aliases: [k.alias], kind: 'card', type: 'tiers', value: null, until: '', note: 'Бот ' + ch + (name ? ': ' + String(name).slice(0, 40) : ''), active: true, createdAt: new Date().toISOString(), by: 'бот', owner: { ch, id: String(id) } }; promos.push(c); ctx.savePromos() }
    return c;
  }
  const cardText = c => 'Ваша дисконтная карта «Байкал Салют»\n№ ' + c.code + '\n\nСкидка от 5% до 30% — чем больше заказ, тем больше скидка. Введите номер карты в корзине, в поле «Промокод или номер дисконтной карты».' + (SITE ? '\n\nСайт: ' + SITE : '') + '\n\nКарта личная, хранится у нас: если потеряете, напишите боту /start — пришлём снова.';
  async function handle(ch, u) { // u: { chatId, userId, name, text }
    const t = Date.now(); if (t - (last.get(u.chatId) || 0) < 1500) return; last.set(u.chatId, t); if (last.size > 5000) last.clear();
    const key = (String(u.text || '').match(/^\/start\s+(\S+)/) || [])[1];
    const o = key && Object.values(ctx.orders()).find(x => x.notify && x.notify.token === key && x.notify.channel === ch);
    if (o) { o.notify.chatId = String(u.chatId); o.notify.linked = true; ctx.persist(); await send(ch, u.chatId, 'Готово! Будем сообщать о статусе заказа здесь.\n' + ctx.statusText(o)) }
    await send(ch, u.chatId, cardText(cardFor(ch, u.userId || u.chatId, u.name)), ch === 'telegram' ? CARD_IMG : '');
  }
  async function tgPoll() {
    let off = 0;
    for (;;) {
      try {
        const r = await (await fetch(TG_API + '/bot' + TG + '/getUpdates?timeout=25&offset=' + off)).json();
        for (const u of r.result || []) { off = u.update_id + 1; const m = u.message; if (!m || m.chat.type !== 'private') continue; await handle('telegram', { chatId: m.chat.id, userId: m.from && m.from.id, name: m.from && m.from.first_name, text: m.text || '' }) }
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
