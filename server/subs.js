'use strict';
// Подписчики бота и рассылки. Без внешних библиотек.
// Подписчик = человек, нажавший Start у бота (Telegram id). Рассылать можно только тем, кто писал именно этому боту.
// Правила: после оформленного заказа 30 дней не рассылаем; тем, кто заказ получает прямо сейчас — тоже; /stop = отписка.
// Переменные (/etc/bs.env): SUB_TOKEN — токен бота для рассылок (если пусто — TG_TOKEN), TG_API, ALERT_CHAT (тестовые получатели).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const E = process.env;
const DAY = 864e5, COOL_DAYS = +E.SUB_COOLDOWN_DAYS || 30, RATE = +E.SUB_RATE || 20; // сообщений в секунду (лимит Telegram около 30)
const HINT_FROM = Date.parse('2024-08-08'); // записи BotHelp после этой даты принадлежат нынешнему боту (подсказка, истину покажет проверка)
const FINAL = new Set(['delivered', 'cancelled']);
const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = function init(ctx) { // ctx: DATA, orders(), ownerOf(order), testers(), tgToken
  const TOKEN = E.SUB_TOKEN || E.TG_TOKEN || '', API = (E.TG_API || 'https://api.telegram.org').replace(/\/$/, '');
  const F = { subs: path.join(ctx.DATA, 'subscribers.json'), bc: path.join(ctx.DATA, 'broadcasts.json') }, IMGD = path.join(ctx.DATA, 'bcast-img');
  const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } };
  const save = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f) };
  let subs = load(F.subs, {}), bcs = load(F.bc, []), dirty = false, bot = null, hold = 0;
  const saveSubs = () => { try { save(F.subs, subs) } catch (e) { console.error('subs', e.message) } dirty = false };
  setInterval(() => { if (dirty) saveSubs() }, 5000).unref();
  try { fs.mkdirSync(IMGD, { recursive: true }) } catch {}

  async function tg(method, payload, form) {
    if (!TOKEN) return { ok: false, description: 'токен бота не задан (SUB_TOKEN / TG_TOKEN)' };
    try {
      const r = await fetch(API + '/bot' + TOKEN + '/' + method, form ? { method: 'POST', body: form } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) });
      return await r.json().catch(() => ({ ok: false, description: 'ответ не JSON' }));
    } catch (e) { return { ok: false, description: 'нет связи: ' + e.message } }
  }
  async function botInfo() { if (bot) return bot; const r = await tg('getMe'); if (r.ok) bot = { name: r.result.username, id: r.result.id }; return bot }

  // ---------- подписчики ----------
  const sameBot = t => !t || !TOKEN || t === TOKEN; // события бота учитываем, только если это тот же бот, что и для рассылок
  function touch(id, info, botToken) { // человек написал боту
    if (!sameBot(botToken)) return; id = String(id); const now = Date.now(); let s = subs[id];
    if (!s) s = subs[id] = { id, name: '', tags: [], src: 'bot', first: now, last: now, st: 'live' };
    s.last = now; if (s.st !== 'unsub' || (info && info.start)) s.st = 'live'; if (info && info.name) s.name = String(info.name).slice(0, 60);
    if (info && info.tag && !s.tags.includes(info.tag)) s.tags.push(info.tag);
    dirty = true;
  }
  function setSt(id, st, botToken) { if (!sameBot(botToken)) return; const s = subs[String(id)]; if (s && s.st !== st) { s.st = st; dirty = true } }

  function parseCsv(text) { // разделитель ; или , ; кавычки "…"
    text = String(text || '').replace(/^﻿/, ''); const d = (text.split('\n', 1)[0].match(/;/g) || []).length >= (text.split('\n', 1)[0].match(/,/g) || []).length ? ';' : ',';
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++ } else q = false } else cur += c }
      else if (c === '"') q = true; else if (c === d) { row.push(cur); cur = '' }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.length > 1 || row[0]) rows.push(row); row = [] }
      else cur += c;
    }
    if (cur || row.length) { row.push(cur); rows.push(row) }
    return rows;
  }
  function importCsv(text) { // выгрузка BotHelp: id, name, first_name, last_name, first_contact_at, last_contact_at, User tags, utm_source
    const rows = parseCsv(text); if (rows.length < 2) return { error: 'Файл пустой или не похож на выгрузку' };
    const H = rows[0].map(h => h.trim()), ix = n => H.indexOf(n); const iId = ix('id');
    if (iId < 0) return { error: 'В файле нет столбца id' };
    const iN = ix('name'), iF = ix('first_name'), iL = ix('last_name'), iA = ix('first_contact_at'), iB = ix('last_contact_at'), iT = ix('User tags'), iU = ix('utm_source');
    let added = 0, merged = 0, bad = 0; const seen = new Set();
    for (const r of rows.slice(1)) {
      const id = String(r[iId] || '').trim(); if (!/^\d{5,12}$/.test(id)) { bad++; continue }
      const a = (+r[iA] || 0) * 1000, b = (+r[iB] || 0) * 1000, tags = String(iT >= 0 ? r[iT] || '' : '').split(/[;,]/).map(x => x.trim()).filter(Boolean);
      const name = (iN >= 0 && r[iN]) || [iF >= 0 && r[iF], iL >= 0 && r[iL]].filter(Boolean).join(' ');
      let s = subs[id];
      if (!s) { s = subs[id] = { id, name: '', tags: [], src: 'bothelp', first: a || Date.now(), last: b || a || Date.now(), st: 'new' }; added++ }
      else if (!seen.has(id)) merged++;
      seen.add(id);
      if (a && a < s.first) s.first = a; if (b && b > s.last) s.last = b; if (name && !s.name) s.name = String(name).slice(0, 60);
      for (const t of tags) if (!s.tags.includes(t)) s.tags.push(t);
      if (iU >= 0 && r[iU] && !s.u) s.u = String(r[iU]).slice(0, 40);
      s.h = s.last >= HINT_FROM ? 1 : 0; // подсказка «похож на живого»
    }
    saveSubs(); return { ok: true, rows: rows.length - 1, added, merged, bad, total: Object.keys(subs).length };
  }

  // ---------- заказы по подписчикам ----------
  function agg() { // id -> {n, sum, first, last, active}
    const m = new Map();
    for (const o of Object.values(ctx.orders())) {
      if (o.status === 'cancelled') continue; const id = ctx.ownerOf(o); if (!id) continue;
      const t = Date.parse(o.createdAt) || 0; let a = m.get(id); if (!a) m.set(id, a = { n: 0, sum: 0, first: t, last: t, active: false });
      a.n++; a.sum += +o.total || 0; if (t < a.first) a.first = t; if (t > a.last) a.last = t; if (!FINAL.has(o.status)) a.active = true;
    }
    return m;
  }
  const cooling = (a, now) => !!a && (a.active || now - a.last < COOL_DAYS * DAY);

  function pick(f, A, now) { // подходящие под фильтр; f: {q, st, tag, seg, days, minSum}
    f = f || {}; const q = String(f.q || '').toLowerCase().trim(), days = +f.days || 0, minSum = +f.minSum || 0, tags = Array.isArray(f.tags) ? f.tags : (f.tag ? [f.tag] : []);
    return Object.values(subs).filter(s => {
      if (f.st && s.st !== f.st) return false;
      if (tags.length && !tags.some(t => s.tags.includes(t))) return false;
      if (q && !(s.id.includes(q) || (s.name || '').toLowerCase().includes(q) || s.tags.some(t => t.toLowerCase().includes(q)))) return false;
      const a = A.get(s.id);
      if (f.seg === 'ordered' && !a) return false; if (f.seg === 'never' && a) return false;
      if (f.seg === 'lapsed' && !(a && now - a.last > (days || 90) * DAY)) return false; // давно не заказывали
      if (f.seg === 'recent' && !(a && cooling(a, now))) return false;
      if (minSum && !(a && a.sum >= minSum)) return false;
      return true;
    });
  }
  function row(s, A) { const a = A.get(s.id); return { id: s.id, name: s.name, tags: s.tags, st: s.st, first: s.first, last: s.last, h: s.h || 0, n: a ? a.n : 0, sum: a ? Math.round(a.sum) : 0, lastOrder: a ? a.last : 0, cool: cooling(a, Date.now()) } }
  function list(f) {
    const A = agg(), now = Date.now(), all = Object.values(subs), st = {};
    all.forEach(s => { st[s.st] = (st[s.st] || 0) + 1 });
    const tg = {}; all.forEach(s => s.tags.forEach(t => { tg[t] = (tg[t] || 0) + 1 }));
    const rows = pick(f, A, now).sort((a, b) => b.last - a.last), off = +(f && f.off) || 0;
    const live = all.filter(s => s.st === 'live'), ready = live.filter(s => !cooling(A.get(s.id), now)).length;
    return { total: all.length, st, tags: Object.entries(tg).sort((a, b) => b[1] - a[1]).slice(0, 40), match: rows.length, rows: rows.slice(off, off + 100).map(s => row(s, A)),
      buyers: [...A.keys()].filter(id => subs[id]).length, cooling: live.length - ready, ready, cool: COOL_DAYS, job, bot };
  }

  // ---------- проверка «кто живой» ----------
  let job = { running: false, total: 0, done: 0, live: 0, dead: 0, blocked: 0, err: 0, msg: '' };
  async function check(force) {
    if (job.running) return job; const b = await botInfo();
    if (!b) return (job = { ...job, running: false, msg: 'Нет связи с Telegram или неверный токен бота' });
    const ids = Object.values(subs).filter(s => force ? s.st !== 'unsub' : s.st === 'new').map(s => s.id);
    job = { running: true, total: ids.length, done: 0, live: 0, dead: 0, blocked: 0, err: 0, msg: 'Проверка идёт', bot: b.name };
    (async () => {
      let bad = 0;
      for (const id of ids) {
        const s = subs[id]; const r = await tg('getChat', { chat_id: +id });
        if (r.ok) { s.st = 'live'; job.live++; bad = 0 }
        else if (r.error_code === 429) { await sleep(((r.parameters && r.parameters.retry_after) || 5) * 1000 + 500); ids.push(id); continue }
        else if (r.error_code === 403) { s.st = 'blocked'; job.blocked++; bad = 0 }
        else if (r.error_code === 400 && /chat not found/i.test(r.description || '')) { s.st = 'dead'; job.dead++; bad = 0 }
        else if (r.error_code === 401) { job.msg = 'Токен бота не принят Telegram'; break }
        else { job.err++; if (++bad >= 25) { job.msg = 'Много ошибок подряд: ' + (r.description || ''); break } }
        s.chk = Date.now(); job.done++; if (job.done % 100 === 0) saveSubs(); await sleep(1000 / RATE);
      }
      saveSubs(); job.running = false; if (job.msg === 'Проверка идёт') job.msg = 'Готово';
    })();
    return job;
  }

  // ---------- рассылки ----------
  const footer = '\n\nЧтобы отписаться от рассылок, отправьте /stop';
  async function sendTo(id, bc) {
    const text = String(bc.text || '') + (bc.nofooter ? '' : footer), kb = bc.btn && bc.btn.t && /^https?:\/\//.test(bc.btn.u || '') ? { inline_keyboard: [[{ text: bc.btn.t, url: bc.btn.u }]] } : undefined;
    if (bc.img) {
      const file = path.join(IMGD, path.basename(bc.img)); let buf; try { buf = fs.readFileSync(file) } catch { buf = null }
      if (buf) {
        const fd = new FormData(); fd.append('chat_id', String(id)); const cap = text.length <= 1000; if (cap) fd.append('caption', text);
        if (kb && cap) fd.append('reply_markup', JSON.stringify(kb)); fd.append('photo', new Blob([buf]), 'a.jpg');
        const r = await tg('sendPhoto', null, fd); if (!r.ok || cap) return r;
      }
    }
    return tg('sendMessage', { chat_id: +id, text, disable_web_page_preview: false, ...(kb ? { reply_markup: kb } : {}) });
  }
  function audience(f) { const A = agg(), now = Date.now(); const all = pick({ ...f, st: 'live' }, A, now); const ok = all.filter(s => !cooling(A.get(s.id), now)); return { ids: ok.map(s => s.id), skipped: all.length - ok.length } }
  function bcPub(b) { const { ids, ...r } = b; return { ...r, total: ids.length } }
  async function createBc(b, by) {
    const text = String(b.text || '').trim(); if (text.length < 2) return { error: 'Введите текст рассылки' }; if (text.length > 3500) return { error: 'Текст слишком длинный' };
    const btn = b.btn && b.btn.t ? { t: String(b.btn.t).slice(0, 40), u: String(b.btn.u || '').slice(0, 300) } : null; if (btn && !/^https?:\/\//.test(btn.u)) return { error: 'Ссылка кнопки должна начинаться с https://' };
    const img = b.img ? path.basename(String(b.img)) : '', a = audience(b.filter || {});
    if (b.dry) return { ok: true, count: a.ids.length, skipped: a.skipped };
    if (b.test) { const t = ctx.testers(); if (!t.length) return { error: 'Тестовые получатели не заданы (ALERT_CHAT)' }; let ok = 0, last = ''; for (const id of t) { const r = await sendTo(id, { text, btn, img, nofooter: b.nofooter }); if (r.ok) ok++; else last = r.description || '' } return { ok: ok > 0, sent: ok, of: t.length, error: ok ? '' : 'Не отправилось: ' + last } }
    if (!a.ids.length) return { error: 'Некому отправлять' };
    const bc = { id: crypto.randomBytes(4).toString('hex'), at: Date.now(), by, text, btn, img, nofooter: !!b.nofooter, filter: b.filter || {}, ids: a.ids, i: 0, st: 'running', n: { sent: 0, blocked: 0, dead: 0, failed: 0 }, skipped: a.skipped };
    bcs.unshift(bc); bcs = bcs.slice(0, 60); save(F.bc, bcs); return { ok: true, id: bc.id, count: a.ids.length, skipped: a.skipped };
  }
  let busy = false;
  async function tick() {
    if (busy || Date.now() < hold) return; const bc = bcs.find(b => b.st === 'running'); if (!bc) return; busy = true;
    try {
      const A = agg(), now = Date.now(); const batch = []; // перед каждой отправкой заново проверяем: подписан ли, не оформил ли заказ только что
      while (bc.i < bc.ids.length && batch.length < RATE) { const id = bc.ids[bc.i++], s = subs[id]; if (s && s.st === 'live' && !cooling(A.get(id), now)) batch.push(id); else bc.skip = (bc.skip || 0) + 1 }
      let hard = 0;
      await Promise.all(batch.map(async id => {
        const r = await sendTo(id, bc), s = subs[id];
        if (r.ok) bc.n.sent++;
        else if (r.error_code === 429) { hold = Date.now() + (((r.parameters && r.parameters.retry_after) || 5) + 1) * 1000; bc.ids.push(id) } // вернём в конец очереди
        else if (r.error_code === 403) { bc.n.blocked++; if (s) { s.st = 'blocked'; dirty = true } }
        else if (r.error_code === 400 && /chat not found/i.test(r.description || '')) { bc.n.dead++; if (s) { s.st = 'dead'; dirty = true } }
        else { bc.n.failed++; hard++; bc.err = r.description || ''; }
      }));
      if (hard >= Math.max(10, batch.length * 0.8)) { bc.st = 'paused'; bc.err = 'Остановлено: много ошибок подряд. ' + (bc.err || '') }
      if (bc.i >= bc.ids.length) { bc.st = 'done'; bc.doneAt = Date.now() }
      save(F.bc, bcs);
    } catch (e) { console.error('bc', e.message) } finally { busy = false }
  }

  // ---------- HTTP ----------
  const readRaw = (req, max) => new Promise((ok, no) => { const c = []; let n = 0; req.on('data', d => { n += d.length; if (n > max) { req.destroy(); no(new Error('big')) } else c.push(d) }); req.on('end', () => ok(Buffer.concat(c))); req.on('error', no) });
  async function route(req, res, url, me, send) {
    const p = url.pathname, m = req.method, J = async max => { try { return JSON.parse((await readRaw(req, max || 200e3)).toString('utf8') || '{}') } catch { return null } };
    if (p === '/api/subs' && m === 'GET') { await botInfo(); const f = Object.fromEntries(url.searchParams); if (f.tags) f.tags = String(f.tags).split('|').filter(Boolean); return send(res, 200, list(f)) }
    if (p === '/api/subs/import' && m === 'POST') { const b = await J(8e6); if (!b || !b.csv) return send(res, 400, { error: 'Нет файла' }); const r = importCsv(b.csv); return send(res, r.error ? 400 : 200, r) }
    if (p === '/api/subs/check' && m === 'POST') { const b = await J() || {}; return send(res, 200, await check(!!b.force)) }
    if (p === '/api/subs/check' && m === 'GET') return send(res, 200, job);
    if (p === '/api/broadcasts/image' && m === 'POST') {
      let buf; try { buf = await readRaw(req, 8e6) } catch { return send(res, 413, { error: 'Файл больше 8 МБ' }) }
      const jpg = buf[0] === 0xff && buf[1] === 0xd8, png = buf[0] === 0x89 && buf[1] === 0x50; if (!jpg && !png) return send(res, 400, { error: 'Нужна картинка JPG или PNG' });
      const name = crypto.randomBytes(6).toString('hex') + (png ? '.png' : '.jpg'); fs.writeFileSync(path.join(IMGD, name), buf); return send(res, 200, { name });
    }
    if (p === '/api/broadcasts' && m === 'GET') return send(res, 200, { list: bcs.map(bcPub), cool: COOL_DAYS, rate: RATE, bot: await botInfo() });
    if (p === '/api/broadcasts' && m === 'POST') { const b = await J(); if (!b) return send(res, 400, { error: 'Некорректные данные' }); const r = await createBc(b, me.name); return send(res, r.error ? 400 : 200, r) }
    if (p === '/api/broadcasts' && m === 'PATCH') {
      const b = await J() || {}, bc = bcs.find(x => x.id === b.id); if (!bc) return send(res, 404, { error: 'Рассылка не найдена' });
      if (b.action === 'pause' && bc.st === 'running') bc.st = 'paused'; else if (b.action === 'resume' && bc.st === 'paused') { bc.st = 'running'; bc.err = '' } else if (b.action === 'cancel' && (bc.st === 'running' || bc.st === 'paused')) bc.st = 'canceled';
      save(F.bc, bcs); return send(res, 200, bcPub(bc));
    }
    return send(res, 404, { error: 'нет такого метода' });
  }
  return { touch, setSt, route, importCsv, list, start() { setInterval(tick, 1000).unref(); for (const b of bcs) if (b.st === 'running') console.log('Рассылка продолжается:', b.id, b.i + '/' + b.ids.length) }, token: TOKEN };
};
