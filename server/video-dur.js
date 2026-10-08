// Длина роликов в секундах -> DATA/video-dur.json {файл: секунды}. Считается один раз на файл (ffprobe).
// Запуск: node video-dur.js   (VIDEO_DIR, DATA_DIR как у sync.js)
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const VID = process.env.VIDEO_DIR || '/var/www/salut38/video', DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const F = path.join(DATA, 'video-dur.json');
let d = {}; try { d = JSON.parse(fs.readFileSync(F, 'utf8')) } catch {}
const files = fs.existsSync(VID) ? fs.readdirSync(VID).filter(f => /\.mp4$/i.test(f) && !f.endsWith('.fast.mp4')) : [];
let n = 0, bad = 0;
for (const f of files) {
  const fp = path.join(VID, f), sz = fs.statSync(fp).size;
  if (d[f] && d[f].s === sz) continue;
  try {
    const o = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', fp], { timeout: 30e3 }).toString().trim();
    const sec = Math.round(parseFloat(o)); if (!(sec > 0)) throw 0;
    d[f] = { s: sz, d: sec }; n++;
  } catch { d[f] = { s: sz, d: 0 }; bad++ }
}
for (const k in d) if (!files.includes(k)) delete d[k];
fs.writeFileSync(F, JSON.stringify(d));
console.log('Длина видео: посчитано', n, '| не удалось', bad, '| всего', files.length);
