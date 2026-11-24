// Servidor do Pintor ao Vivo (fica no Render). Rotas:
//   GET /status                 -> {ok:true}
//   GET /events?usuario=fulano  -> fluxo (SSE) de comentarios e presentes da live de @fulano
//   GET /avatar?u=<url>         -> foto de perfil (proxy)
//   GET /corrida?u=fulano       -> jogo Corrida Maluca da Live (overlay)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TikTokLiveConnection, WebcastEvent } from 'tiktok-live-connector';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORTA = process.env.PORT || 3000;
const CHAVE_EULER = process.env.EULER_API_KEY || '';
const LIMITE_GIGANTE = 5; // 5 diamantes ou mais = foto gigante
const GIGANTES = new Set(['5487']); // 5487 = finger heart
const COOLDOWN_COMENTARIO = 120000; // 1 foto por pessoa a cada 2 minutos de comentario
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
const salas = new Map();

process.on('uncaughtException', (e) => console.error('Erro:', (e && e.message) || e));
process.on('unhandledRejection', (e) => console.error('Erro:', (e && e.message) || e));

function lerGigantes() {
  const set = new Set(GIGANTES);
  try {
    fs.readFileSync(path.join(__dirname, 'gigantes.txt'), 'utf8').split(/\r?\n/).forEach((l) => {
      const n = l.split('#')[0].trim();
      if (/^\d+$/.test(n)) set.add(n);
    });
  } catch {}
  return set;
}

function coletarFotos(u) {
  const cand = [];
  const add = (v) => {
    if (typeof v === 'string' && v.startsWith('http')) cand.push(v);
    else if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v === 'object') { add(v.urls); add(v.url); add(v.urlList); add(v.url_list); }
  };
  add(u.profilePicture); add(u.avatarThumb); add(u.avatarMedium); add(u.avatarLarger); add(u.profilePictureUrl);
  const pref = (x) => (/\.jpe?g(\?|$)/i.test(x) ? 0 : /\.(png|webp)(\?|$)/i.test(x) ? 1 : /\.heic/i.test(x) ? 3 : 2);
  const ampliar = (x) => x.replace(/(cropcenter:)\d+:\d+/, '$1720:720').replace(/([_~])(\d{2,3})x\2(?=[.~?])/, '$1720x720');
  const ordenadas = [...new Set(cand)].sort((a, b) => pref(a) - pref(b)).slice(0, 3);
  const lista = [];
  ordenadas.forEach((x) => { const g = ampliar(x); if (g !== x) lista.push(g); lista.push(x); });
  return [...new Set(lista)].slice(0, 6);
}

function sala(usuario) {
  let s = salas.get(usuario);
  if (s) return s;
  s = { usuario, clientes: new Set(), ultimos: new Map(), conn: null, tmr: null, fim: null, ativa: true, estado: 'conectando', msg: '' };
  s.emit = (obj) => { const m = `data: ${JSON.stringify(obj)}\n\n`; for (const c of s.clientes) c.write(m); };
  // so para o jogo da Corrida (clientes com modo=corrida): todo comentario e as curtidas
  s.emitCorrida = (obj) => { const m = `data: ${JSON.stringify(obj)}\n\n`; for (const c of s.clientes) if (c._corrida) c.write(m); };
  s.status = (estado, msg) => { s.estado = estado; s.msg = msg || ''; s.emit({ tipo: 'status', estado, msg: s.msg }); console.log(`[${usuario}]`, estado, msg || ''); };
  salas.set(usuario, s);
  conectar(s);
  return s;
}

function fechar(s) {
  s.ativa = false; clearTimeout(s.tmr);
  try { if (s.conn) { s.conn.removeAllListeners(); s.conn.disconnect(); } } catch {}
  salas.delete(s.usuario);
  console.log(`[${s.usuario}] sala fechada`);
}

function conectar(s) {
  if (!s.ativa) return;
  clearTimeout(s.tmr);
  try { if (s.conn) { s.conn.removeAllListeners(); s.conn.disconnect(); s.conn = null; } } catch {}
  const op = { processInitialData: false };
  if (CHAVE_EULER) op.signApiKey = CHAVE_EULER;
  const c = new TikTokLiveConnection(s.usuario, op);
  s.conn = c;
  const tentarDeNovo = (ms) => { if (s.ativa) s.tmr = setTimeout(() => conectar(s), ms); };

  c.on(WebcastEvent.GIFT, (data) => {
    const u = data.user || {};
    const nome = u.nickname || u.uniqueId || data.nickname || data.uniqueId || 'Espectador';
    const fotos = coletarFotos(u);
    const unit = data.giftDetails?.diamondCount ?? data.diamondCount ?? (String(data.giftId) === '5655' ? 1 : null);
    const idP = String(data.giftId);
    const lista = lerGigantes();
    let nivel; // 5 = gigante (muro todo), 4 = lendaria (rosa)
    if (lista.has(idP) || (unit != null && unit >= LIMITE_GIGANTE)) nivel = 5;
    else if (idP === '5655') nivel = 4;
    else nivel = (unit == null && lista.size === 0) ? 5 : 4;
    const chave = nome + '|' + idP;
    if (Date.now() - (s.ultimos.get(chave) || 0) < 4000) return; // evita repeticao do mesmo presente
    s.ultimos.set(chave, Date.now());
    console.log(`[${s.usuario}] Presente: ${nome} | id ${idP} | diamantes ${unit ?? '?'} | nivel ${nivel}`);
    s.emit({ nome, fotos, nivel, id: u.uniqueId || nome });
  });
  c.on(WebcastEvent.CHAT || 'chat', (data) => {
    const u = data.user || {};
    const nome = u.nickname || u.uniqueId || data.nickname || data.uniqueId || 'Espectador';
    const chaveC = 'corrida|' + (u.uniqueId || nome);
    if (Date.now() - (s.ultimos.get(chaveC) || 0) >= 800) {
      s.ultimos.set(chaveC, Date.now());
      s.emitCorrida({ tipo: 'chat', nome, fotos: coletarFotos(u), id: u.uniqueId || nome });
    }
    const chave = 'chat|' + (u.uniqueId || nome);
    if (Date.now() - (s.ultimos.get(chave) || 0) < COOLDOWN_COMENTARIO) return;
    s.ultimos.set(chave, Date.now());
    s.emit({ nome, fotos: coletarFotos(u), nivel: 1, id: u.uniqueId || nome });
  });
  c.on(WebcastEvent.LIKE || 'like', (data) => {
    const u = data.user || {};
    const n = Number(data.likeCount ?? data.count ?? 1) || 1;
    s.emitCorrida({ tipo: 'curtida', n: Math.min(n, 50), nome: u.nickname || u.uniqueId || '' });
  });
  c.on('error', (e) => console.log(`[${s.usuario}] aviso:`, (e && e.message) || e));
  c.on('disconnected', () => { if (!s.ativa) return; s.status('reconectando', 'A live caiu ou terminou. Tentando de novo...'); tentarDeNovo(8000); });

  s.status('conectando', `Procurando a live de @${s.usuario}...`);
  c.connect().then(() => s.status('conectado', `Conectado na live de @${s.usuario}`)).catch((e) => {
    const m = String((e && e.message) || e);
    const off = /isn't online|not online|offline|LIVE has ended|Room ID/i.test(m);
    s.status('erro', off ? `A live de @${s.usuario} não está no ar. Tentando de novo...` : `Não consegui conectar: ${m}. Tentando de novo...`);
    tentarDeNovo(15000);
  });
}

// ---------- o proprio jogo (para usar como link de overlay no TikTok LIVE Studio / OBS) ----------
const SITE = path.join(__dirname, 'site');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
function estatico(req, res, rota) {
  let nome; try { nome = decodeURIComponent(rota); } catch { res.writeHead(400); return res.end(); }
  const arq = path.join(SITE, nome);
  if (!arq.startsWith(SITE + path.sep) || !fs.existsSync(arq) || !fs.statSync(arq).isFile()) { res.writeHead(404, CORS); return res.end(); }
  const tam = fs.statSync(arq).size, tipo = TIPOS[path.extname(arq).toLowerCase()] || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const ini = m[1] ? +m[1] : 0, fim = m[2] ? Math.min(+m[2], tam - 1) : tam - 1;
    if (ini > fim || ini >= tam) { res.writeHead(416, { 'Content-Range': `bytes */${tam}`, ...CORS }); return res.end(); }
    res.writeHead(206, { 'Content-Type': tipo, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${ini}-${fim}/${tam}`, 'Content-Length': fim - ini + 1, ...CORS });
    return fs.createReadStream(arq, { start: ini, end: fim }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': tipo, 'Accept-Ranges': 'bytes', 'Content-Length': tam, 'Cache-Control': 'max-age=3600', ...CORS });
  fs.createReadStream(arq).pipe(res);
}

const fotos = new Map();
async function foto(res, u) {
  try {
    const h = new URL(u).hostname;
    if (!/(tiktok|byteoversea|ibyteimg|ibytedtos|muscdn)/.test(h)) throw 0;
    let c = fotos.get(u);
    if (!c) {
      const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw 0;
      c = { tipo: r.headers.get('content-type') || 'image/jpeg', buf: Buffer.from(await r.arrayBuffer()) };
      if (fotos.size > 300) fotos.clear();
      fotos.set(u, c);
    }
    res.writeHead(200, { 'Content-Type': c.tipo, 'Cache-Control': 'max-age=3600', ...CORS });
    res.end(c.buf);
  } catch { res.writeHead(404, CORS); res.end(); }
}

http.createServer((req, res) => {
  let u; try { u = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  const r = u.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (r === '/' || r === '/status') { res.writeHead(200, { 'Content-Type': 'application/json', ...CORS }); return res.end(JSON.stringify({ ok: true, salas: salas.size })); }
  if (r === '/jogo' || r === '/jogo.html' || r.startsWith('/musicas')) return estatico(req, res, r === '/jogo' ? '/jogo.html' : r);
  if (r === '/corrida' || r === '/corrida.html') return estatico(req, res, '/corrida.html');
  if (r === '/avatar') return foto(res, u.searchParams.get('u') || '');
  if (r === '/events') {
    const usuario = (u.searchParams.get('usuario') || '').replace(/^@/, '').trim().replace(/\s+/g, '');
    if (!/^[\w.]{1,40}$/.test(usuario)) { res.writeHead(400, CORS); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...CORS });
    res.write(':ok\n\n');
    const s = sala(usuario);
    if (u.searchParams.get('modo') === 'corrida') res._corrida = true;
    clearTimeout(s.fim); s.clientes.add(res);
    const bate = setInterval(() => res.write(':bip\n\n'), 20000);
    req.on('close', () => {
      clearInterval(bate); s.clientes.delete(res);
      if (!s.clientes.size) s.fim = setTimeout(() => { if (!s.clientes.size) fechar(s); }, 120000);
    });
    return;
  }
  res.writeHead(404, CORS); res.end();
}).listen(PORTA, () => console.log('Servidor do Pintor ao Vivo na porta ' + PORTA));
