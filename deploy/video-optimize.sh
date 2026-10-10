#!/usr/bin/env bash
# Пережатие роликов для быстрой загрузки на телефоне: не больше 720 px, поток ≈1 Мбит/с, «быстрый старт» (+faststart).
# Имя файла не меняется — сайт и синхронизация с поставщиком продолжают работать как раньше.
# Оригиналы складываются в /var/lib/bs-data/video-orig (можно удалить, когда убедитесь в качестве).
#   bash video-optimize.sh --test    — пережать один самый большой ролик и показать «было/стало»
#   bash video-optimize.sh           — пережать все ещё не обработанные (можно прерывать и запускать снова)
#   bash video-optimize.sh --limit 50 — обработать не больше 50 роликов за запуск
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "Запустите от root"; exit 1; }
command -v ffmpeg >/dev/null || apt-get install -y ffmpeg >/dev/null
DIR=${VDIR:-/var/www/salut38/video}; ORIG=${VORIG:-/var/lib/bs-data/video-orig}; DONE=${VDONE:-/var/lib/bs-data/video-opt.txt}
mkdir -p "$ORIG"; touch "$DONE"
LIMIT=100000; TEST=0
[ "${1:-}" = "--test" ] && { TEST=1; LIMIT=1; }
[ "${1:-}" = "--limit" ] && LIMIT="${2:-50}"
n=0; before=0; after=0; last=""
for f in $(ls -S "$DIR"/*.mp4 2>/dev/null); do
  b=$(basename "$f")
  [ "$TEST" = 0 ] && grep -qx "$b" "$DONE" && continue
  [ $n -ge $LIMIT ] && break
  n=$((n+1)); s0=$(stat -c %s "$f")
  br=$(ffprobe -v error -show_entries format=bit_rate -of default=nw=1:nk=1 "$f" 2>/dev/null || echo 0)
  tmp="$DIR/.opt-$b"
  if [ "${br:-0}" -gt 1300000 ] 2>/dev/null; then
    nice -n 19 ionice -c3 ffmpeg -nostdin -v error -y -i "$f" -vf "scale='min(720,iw)':-2" -c:v libx264 -preset medium -crf 27 -maxrate 1100k -bufsize 2200k -pix_fmt yuv420p -c:a aac -b:a 96k -ac 2 -movflags +faststart "$tmp"
  else
    nice -n 19 ffmpeg -nostdin -v error -y -i "$f" -c copy -movflags +faststart "$tmp"   # поток и так небольшой: только быстрый старт
  fi
  if [ -s "$tmp" ]; then
    s1=$(stat -c %s "$tmp")
    if [ "$s1" -lt "$s0" ] || [ "${br:-0}" -le 1300000 ] 2>/dev/null; then
      [ -f "$ORIG/$b" ] || cp -p "$f" "$ORIG/$b"
      chown --reference="$f" "$tmp"; chmod 644 "$tmp"; mv -f "$tmp" "$f"
    else s1=$s0; rm -f "$tmp"; fi
  else s1=$s0; rm -f "$tmp"; echo "не удалось: $b"; fi
  echo "$b" >> "$DONE"; last="$b"; before=$((before+s0)); after=$((after+s1))
  printf '%4d. %s  %s МБ → %s МБ\n' "$n" "$b" "$((s0/1048576))" "$((s1/1048576))"
done
[ $n -gt 0 ] && echo "Готово: $n роликов, было $((before/1048576)) МБ, стало $((after/1048576)) МБ" || echo "Новых роликов нет"
[ "$TEST" = 1 ] && [ -n "${last:-}" ] && echo "Проверьте ролик на сайте (обновите страницу). Оригинал сохранён: $ORIG/$last. Если качество устраивает — запускайте без --test."
exit 0
