// Перепаковка видео «для быстрого старта» (moov в начало файла), без перекодирования: ffmpeg -c copy -movflags +faststart.
// Без этого телефон качает почти весь файл, прежде чем начнёт показывать. Уже обработанные файлы запоминаются.
// Запуск: node faststart.js   (VIDEO_DIR, DATA_DIR как у sync.js)
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const VID = process.env.VIDEO_DIR || '/var/www/salut38/video', DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MARK = path.join(DATA, 'video-fast.json');
let done = {}; try { done = JSON.parse(fs.readFileSync(MARK, 'utf8')); } catch {}
let n = 0, bad = 0, skipped = 0;
const files = fs.existsSync(VID) ? fs.readdirSync(VID).filter(f => /\.mp4$/i.test(f)) : [];
for (const f of files) {
  const fp = path.join(VID, f), st = fs.statSync(fp);
  if (done[f] === st.size) { skipped++; continue; }
  const tmp = fp + '.fast.mp4';
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', fp, '-c', 'copy', '-movflags', '+faststart', tmp], { timeout: 300e3 });
    if (fs.statSync(tmp).size < 1000) throw new Error('пустой файл');
    fs.renameSync(tmp, fp); done[f] = fs.statSync(fp).size; n++;
  } catch (e) { bad++; try { fs.unlinkSync(tmp); } catch {} done[f] = st.size; /* битый файл не мучаем повторно */ }
  if ((n + bad) % 50 === 0) { fs.writeFileSync(MARK, JSON.stringify(done)); console.log('...видео обработано', n + bad, 'из', files.length - skipped); }
}
fs.writeFileSync(MARK, JSON.stringify(done));
console.log('Видео: перепаковано', n, '| уже было готово', skipped, '| не удалось', bad);
