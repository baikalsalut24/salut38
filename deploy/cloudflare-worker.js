// Cloudflare Worker: пересылает запросы к Telegram Bot API. Закрыт секретным префиксом в адресе.
// Адрес для сервера (TG_API): https://<имя>.workers.dev/<SECRET>
// SECRET задаётся в Cloudflare: Worker -> Settings -> Variables and Secrets -> SECRET (длинная случайная строка).
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const pre = '/' + (env.SECRET || '\u0000') + '/';
    if (!env.SECRET || !u.pathname.startsWith(pre) || !u.pathname.slice(pre.length).startsWith('bot')) return new Response('not found', { status: 404 });
    const target = 'https://api.telegram.org/' + u.pathname.slice(pre.length) + u.search;
    return fetch(target, { method: req.method, headers: { 'content-type': req.headers.get('content-type') || 'application/json' }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body });
  }
};
