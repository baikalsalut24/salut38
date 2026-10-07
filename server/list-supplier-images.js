// Список товаров, у которых картинка от поставщика (новые карточки). У остальных — ваши прежние картинки из InSales.
const fs = require('fs'), path = require('path');
const DATA = process.env.DATA_DIR || '/var/lib/bs-data';
const feed = JSON.parse(fs.readFileSync(path.join(DATA, 'feed.json'), 'utf8'));
const rows = feed.ad.map(a => [a.sku, a.name, a.cats[0], a.price, a.img.split('?')[0], a.src || '']);
console.log('Картинки от поставщика (новые карточки):', rows.length, '| у остальных товаров — прежние картинки (InSales)\n');
rows.forEach((r, i) => console.log((i + 1) + '. ' + r[0] + ' | ' + r[1] + ' | ' + r[2] + ' | ' + r[3] + ' ₽'));
const csv = '﻿Артикул;Название;Категория;Цена;Наша картинка;Картинка поставщика\n' + rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(';')).join('\n');
try { fs.writeFileSync('/root/supplier-images.csv', csv); console.log('\nТаблица для Excel сохранена: /root/supplier-images.csv'); } catch {}
