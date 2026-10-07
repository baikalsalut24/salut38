// Показывает по 5 новых и скрытых товаров из последней синхронизации (для проверки глазами)
const fs = require('fs'), path = require('path');
const DATA = process.env.DATA_DIR || '/var/lib/bs-data';
const feed = JSON.parse(fs.readFileSync(path.join(DATA, 'feed.json'), 'utf8'));
const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8')), by = new Map(base.map(b => [b.sku, b]));
const pick = (a, n) => { const s = [...a].sort(() => Math.random() - .5).slice(0, n); return s; };
console.log('Синхронизация:', new Date(feed.t).toLocaleString('ru-RU', { timeZone: 'Asia/Irkutsk' }), '| новых:', feed.ad.length, '| скрыто:', feed.hd.length, '| цен обновлено:', Object.keys(feed.pr).length);
console.log('\n=== 5 НОВЫХ (появились на сайте) ===');
pick(feed.ad, 5).forEach(a => console.log(a.sku + ' | ' + a.name + ' | ' + a.price + ' ₽ | ' + a.cats[0] + ' | ' + (a.brand || '') + '\n   картинка: ' + a.img + (feed.vd[a.sku] ? '\n   видео: ' + feed.vd[a.sku] : '')));
console.log('\n=== 5 СКРЫТЫХ (нет у поставщика) ===');
pick(feed.hd, 5).forEach(s => { const b = by.get(s) || {}; console.log(s + ' | ' + (b.name || '?') + ' | было ' + (b.price || '?') + ' ₽ | ' + ((b.cats || [])[0] || '')); });
