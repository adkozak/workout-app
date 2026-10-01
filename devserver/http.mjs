// HTTP face of the fake backend: /exec behaves like an Apps Script web app,
// including the 302 to a one-time /echo URL that real deployments answer with.

const echoes = new Map();
let echoId = 0;

export async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

export function send(res, status, text, type = 'application/json', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(text);
}

/**
 * Handles /exec and /echo; returns false for other paths.
 * @param {{ backend: () => ReturnType<import('./gas.mjs').createBackend>, redirect?: boolean, onPost?: (out: any) => void }} opts
 */
export async function handleExec(req, res, { backend, redirect = true, onPost }) {
  const url = new URL(req.url, 'http://x');
  const reply = (out) => {
    const text = JSON.stringify(out);
    if (!redirect) return send(res, 200, text);
    const id = String(++echoId);
    echoes.set(id, text);
    setTimeout(() => echoes.delete(id), 60000).unref();
    send(res, 302, '', 'text/html', { Location: `/echo?id=${id}` });
  };
  if (url.pathname === '/exec' && req.method === 'GET') {
    reply(backend().doGet(Object.fromEntries(url.searchParams)));
    return true;
  }
  if (url.pathname === '/exec' && req.method === 'POST') {
    const out = backend().doPost(await readBody(req));
    onPost?.(out);
    reply(out);
    return true;
  }
  if (url.pathname === '/echo') {
    const text = echoes.get(url.searchParams.get('id'));
    echoes.delete(url.searchParams.get('id'));
    if (text) send(res, 200, text);
    else send(res, 404, JSON.stringify({ ok: false, error: 'echo expired' }));
    return true;
  }
  return false;
}
