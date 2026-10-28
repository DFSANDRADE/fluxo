'use strict';
/*
 * Fluxo — servidor proxy (Node puro, sem dependências).
 * - Esconde as credenciais do provedor (ficam só aqui, nunca no navegador).
 * - Repassa a API Xtream (player_api.php) e os streams (seguindo redirects pro CDN).
 * - Resolve CORS e mixed-content servindo tudo na mesma origem.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL, URLSearchParams } = require('url');
const os = require('os');

// buffer dos últimos logs (pro diagnóstico "travou ou tá ruim")
const LOGBUF = [];
['log', 'error', 'warn'].forEach(k => { const orig = console[k].bind(console); console[k] = (...a) => { try { LOGBUF.push(new Date().toISOString().slice(11, 19) + ' ' + a.map(String).join(' ')); if (LOGBUF.length > 120) LOGBUF.shift(); } catch {} orig(...a); }; });
let transcodeCount = 0;   // transcodes ffmpeg ativos agora

const CONFIG_PATH = path.join(__dirname, 'config.json');
let CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const UA = CONFIG.userAgent || 'okhttp/4.9';
const PORT = CONFIG.port || 8085;

// ---- provedores: lista de provedores; resolvido por requisição (migra do formato antigo { provider }) ----
let PROVIDERS = {}, DEFAULT_PV = 'principal';
function loadProviders() {
  const raw = (CONFIG.providers && CONFIG.providers.length)
    ? CONFIG.providers
    : [Object.assign({ id: 'principal', name: 'Principal' }, CONFIG.provider || {})];
  PROVIDERS = {};
  raw.forEach(p => { if (p && p.host) PROVIDERS[p.id] = { id: p.id, name: p.name || p.id, host: p.host, username: p.username, password: p.password, ua: p.userAgent || UA, base: `http://${p.host}` }; });
  DEFAULT_PV = (raw[0] && raw[0].id) || 'principal';
}
function saveConfig() { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2)); } catch (e) { console.log('erro ao salvar config:', e.message); } }
// migra o formato antigo pro novo (lista de provedores + perfis), gravando em disco 1x
function migrateConfig() {
  let changed = false;
  if (!Array.isArray(CONFIG.providers) || !CONFIG.providers.length) {
    const old = CONFIG.provider || {};
    CONFIG.providers = [{ id: 'principal', name: 'Principal', host: old.host, username: old.username, password: old.password, userAgent: old.userAgent || CONFIG.userAgent }];
    delete CONFIG.provider;
    changed = true;
  }
  if (!Array.isArray(CONFIG.profiles) || !CONFIG.profiles.length) {
    CONFIG.profiles = [{ id: 'eu', name: 'Eu', kid: false, providers: CONFIG.providers.map(p => p.id), color: '#7c9cff' }];
    changed = true;
  }
  if (changed) saveConfig();
}
migrateConfig();
loadProviders();
const pinOk = (given) => !CONFIG.adminPin || String(given || '') === String(CONFIG.adminPin);
const slugify = (s) => String(s || '').normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || ('pv' + Date.now());
function readJSON(req, cb) {   // lê corpo POST como JSON (limite 1MB)
  let body = ''; req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(body || '{}')); } catch { cb(null); } });
}
const getPv = (id) => PROVIDERS[id] || PROVIDERS[DEFAULT_PV];
function cookieVal(req, name) { const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec((req && req.headers.cookie) || ''); try { return m ? decodeURIComponent(m[1]) : ''; } catch { return m ? m[1] : ''; } }
function pvOf(q, req) {                       // provedor da requisição: ?pv= ou cookie fluxo_pv, senão o padrão
  return getPv((q && q.get('pv')) || cookieVal(req, 'fluxo_pv'));
}
const isKid = (q, req) => (q && q.get('kid') === '1') || cookieVal(req, 'fluxo_kid') === '1';   // perfil Kid (query ou cookie)
const JK = CONFIG.jackett || null;
const TM = CONFIG.transmission || { host: '127.0.0.1', port: 9091 };
const TORRENT_DIR = CONFIG.torrentDir || '/dados/midia/torrents';

let trackerCache = { at: 0, list: [] };      // saúde dos trackers: [{name,ok,error}]
let trackerBusy = false;
let indexerList = [];                        // [{id,name}] aprendido do Jackett e cacheado em disco
const TRK_TTL = 5 * 60 * 1000;               // cache da saúde (5 min); revalida em 2º plano
const IDX_FILE = '/dados/.fluxo-indexers.json';
const PER_TRACKER_TIMEOUT = 12000;           // tempo-limite POR tracker: quem passar disso é pulado (não trava os outros)
try { indexerList = JSON.parse(fs.readFileSync(IDX_FILE, 'utf8')) || []; } catch {}
const cleanErr = (s) => String(s || '').replace(/Jackett\.Common\.IndexerException:\s*/g, '').replace(/\s+/g, ' ').slice(0, 160);

// descobre a lista de indexadores (id+nome) via query agregada — só pra APRENDER os ids (roda em 2º plano, cacheado)
function fetchIndexerList(cb) {
  if (!JK) { if (cb) cb(); return; }
  fetchBuffer(`${JK.url}/api/v2.0/indexers/all/results?apikey=${JK.apikey}&Query=matrix`, (e, b) => {
    if (!e) {
      try {
        const list = (JSON.parse(b.toString()).Indexers || []).filter(i => i.ID).map(i => ({ id: i.ID, name: i.Name }));
        if (list.length) { indexerList = list; try { fs.writeFileSync(IDX_FILE, JSON.stringify(list)); } catch {} }
      } catch {}
    }
    if (cb) cb();
  }, 60000);
}

// consulta CADA indexador em paralelo com timeout individual; tracker lento/morto é pulado (os demais entregam).
// overallTimeout (opcional): teto geral — devolve o que já chegou e marca o resto como pulado (busca rápida).
function jackettParallel(query, perTimeout, done, overallTimeout) {
  if (!JK || !indexerList.length) return done({ results: [], health: [] });
  const ids = indexerList.slice();
  const results = [], health = [], seen = {};
  let finished = false, pending = ids.length;
  const finish = () => {
    if (finished) return; finished = true;
    ids.forEach(ix => { if (!seen[ix.id]) health.push({ name: ix.name, ok: false, error: 'sem resposta no tempo (pulado)' }); });
    health.sort((a, c) => (a.ok === c.ok) ? a.name.localeCompare(c.name) : (a.ok ? 1 : -1));
    done({ results, health });
  };
  const cap = overallTimeout ? setTimeout(finish, overallTimeout) : null;
  ids.forEach(ix => {
    const url = `${JK.url}/api/v2.0/indexers/${encodeURIComponent(ix.id)}/results?apikey=${JK.apikey}&Query=${encodeURIComponent(query)}`;
    fetchBuffer(url, (e, b) => {
      if (finished) return;
      seen[ix.id] = true;
      let ok = false, error = '';
      if (e) error = 'sem resposta no tempo (pulado)';
      else {
        try {
          const d = JSON.parse(b.toString());
          const ierr = (d.Indexers && d.Indexers[0] && d.Indexers[0].Error) || null;
          if (ierr) error = cleanErr(ierr);
          else { ok = true; (d.Results || []).forEach(r => results.push(r)); }
        } catch { error = 'resposta inválida'; }
      }
      health.push({ name: ix.name, ok, error });
      if (--pending === 0) { if (cap) clearTimeout(cap); finish(); }
    }, perTimeout);
  });
}

// atualiza a saúde dos trackers usando a consulta paralela resiliente
function refreshTrackers(cb) {
  if (!JK || trackerBusy) { if (cb) cb(); return; }
  trackerBusy = true;
  const run = () => jackettParallel('matrix', PER_TRACKER_TIMEOUT, ({ health }) => {
    trackerBusy = false;
    if (health.length) trackerCache = { at: Date.now(), list: health };
    if (cb) cb();
  });
  if (!indexerList.length) fetchIndexerList(run); else run();
}
// RPC do transmission (faz o handshake do X-Transmission-Session-Id)
let tmSession = '';
function transmissionRPC(method, args, cb, retried) {
  const body = JSON.stringify({ method, arguments: args || {} });
  const req = http.request({ host: TM.host, port: TM.port, path: '/transmission/rpc', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Transmission-Session-Id': tmSession } },
    (resp) => {
      if (resp.statusCode === 409 && !retried) { tmSession = resp.headers['x-transmission-session-id'] || ''; resp.resume(); return transmissionRPC(method, args, cb, true); }
      const ch = []; resp.on('data', c => ch.push(c)); resp.on('end', () => { try { cb(null, JSON.parse(Buffer.concat(ch).toString())); } catch (e) { cb(e); } });
    });
  req.on('error', cb); req.end(body);
}

// Resolve o link /dl/ do Jackett (que dá 302) pro magnet/torrent real
function resolveTorrent(link, cb) {
  let u, done = false; const fin = (v) => { if (!done) { done = true; cb(v); } };
  try { u = new URL(link); } catch { return fin(link); }
  const r = clientFor(u).get(u, { headers: { 'User-Agent': UA }, agent: u.protocol === 'https:' ? httpsAgent : httpAgent }, (resp) => {
    resp.resume();
    const loc = resp.headers.location;
    if ([301, 302, 303, 307, 308].includes(resp.statusCode) && loc) return fin(loc);
    fin(link);
  });
  r.on('error', () => fin(link));
  r.setTimeout(12000, () => { try { r.destroy(); } catch {} fin(link); });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

const clientFor = (u) => (u.protocol === 'https:' ? https : http);
// keep-alive: reaproveita conexões (segmentos de live chegam mais rápido = menos engasgo)
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 15000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 15000 });

// Abre um GET no upstream seguindo redirects; entrega o IncomingMessage "vivo".
function openUpstream(rawUrl, headers, cb, hops = 0, timeoutMs = 30000) {
  let u;
  try { u = new URL(rawUrl); } catch (e) { return cb(e); }
  const opts = { headers: Object.assign({ 'User-Agent': UA }, headers || {}), agent: u.protocol === 'https:' ? httpsAgent : httpAgent };
  const req = clientFor(u).get(u, opts, (resp) => {
    const sc = resp.statusCode;
    if ([301, 302, 303, 307, 308].includes(sc) && resp.headers.location && hops < 6) {
      resp.resume();
      return openUpstream(new URL(resp.headers.location, u).toString(), headers, cb, hops + 1, timeoutMs);
    }
    cb(null, resp, u.toString());
  });
  req.on('error', cb);
  req.setTimeout(timeoutMs, () => req.destroy(new Error('upstream timeout')));
}

// Baixa o upstream inteiro (usado pra respostas JSON e playlists). Devolve a URL final (pós-redirect).
function fetchBuffer(rawUrl, cb, timeoutMs) {
  openUpstream(rawUrl, {}, (err, resp, finalUrl) => {
    if (err) return cb(err);
    const chunks = [];
    resp.on('data', (c) => chunks.push(c));
    resp.on('end', () => cb(null, Buffer.concat(chunks), finalUrl));
    resp.on('error', cb);
  }, 0, timeoutMs);
}

// Reescreve uma playlist HLS pra que segmentos e sub-playlists passem pelo nosso proxy.
function rewriteHls(text, baseUrl) {
  return text.split('\n').map((line) => {
    const t = line.trim();
    if (!t || t[0] === '#') return line;
    let abs; try { abs = new URL(t, baseUrl).toString(); } catch { return line; }
    return (/\.m3u8(\?|$)/i.test(abs) ? '/hls/p?u=' : '/hls/seg?u=') + encodeURIComponent(abs);
  }).join('\n');
}
function serveHls(res, upstreamUrl) {
  fetchBuffer(upstreamUrl, (err, buf, finalUrl) => {
    if (err) { res.writeHead(502); return res.end('hls error'); }
    const body = Buffer.from(rewriteHls(buf.toString('utf8'), finalUrl || upstreamUrl));
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.end(body);
  });
}

const apiUrl = (pv, params) =>
  `${pv.base}/player_api.php?${new URLSearchParams(Object.assign({ username: pv.username, password: pv.password }, params))}`;

function sendJSON(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}
function passThroughJSON(res, buf) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=120' });
  res.end(buf);
}

// Repassa um stream (com suporte a Range pra seek em filmes).
function proxyStream(req, res, upstreamUrl, opts) {
  opts = opts || {};
  const headers = {};
  if (req.headers.range) headers['Range'] = req.headers.range;
  openUpstream(upstreamUrl, headers, (err, up) => {
    if (err) { res.writeHead(502); return res.end('upstream error'); }
    const out = {};
    ['content-type', 'content-length', 'accept-ranges', 'content-range'].forEach((k) => {
      if (up.headers[k]) out[k] = up.headers[k];
    });
    out['Cache-Control'] = 'no-store';
    if (opts.filename) out['Content-Disposition'] = `attachment; filename="${opts.filename.replace(/"/g, '')}"`;
    res.writeHead(up.statusCode || 200, out);
    up.pipe(res);
    req.on('close', () => up.destroy());
  });
}

// ---- downloads no servidor (ficam em /dados/downloads, visíveis também no Samba/Jellyfin) ----
const DLDIR = CONFIG.downloadDir || '/dados/downloads';
try { fs.mkdirSync(DLDIR, { recursive: true }); } catch {}
const DOWNLOADS = {};
const dlKey = (type, id) => `${type}:${id}`;
const sanitize = (s) => String(s || '').replace(/[^\w\-.() ]+/g, '_').slice(0, 120).trim() || 'video';
function saveDLIndex() { try { fs.writeFileSync(path.join(DLDIR, '_index.json'), JSON.stringify(DOWNLOADS)); } catch {} }
function loadDLIndex() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DLDIR, '_index.json'), 'utf8'));
    for (const k in j) {
      const r = j[k];
      if (r.status === 'done' && !fs.existsSync(r.file)) continue; // sumiu
      if (r.status === 'downloading') r.status = 'error'; // interrompido no reboot
      DOWNLOADS[k] = r;
    }
  } catch {}
}
const AUTO_TTL = 24 * 3600 * 1000;   // cache temporário (auto, de assistir) dura 24h e é apagado sozinho
function startDownload({ type, id, ext, name, icon, pv, auto }) {
  pv = pv || getPv(DEFAULT_PV);
  const key = dlKey(type, id);
  const existing = DOWNLOADS[key];
  if (existing && existing.status !== 'error') {
    if (!auto && existing.auto) { existing.auto = false; delete existing.expireAt; saveDLIndex(); }  // download manual promove a permanente
    return existing;
  }
  ext = (ext || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4';
  const subdir = type === 'series' ? 'series' : 'filmes';
  const dir = path.join('/dados/midia', subdir);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const abs = path.join(dir, `${sanitize(name)}.${ext}`);
  const rec = DOWNLOADS[key] = { key, type, id, ext, name, icon, file: abs, status: 'downloading', received: 0, total: 0, at: Date.now(), auto: !!auto };
  if (auto) rec.expireAt = Date.now() + AUTO_TTL;
  const url = `${pv.base}/${type === 'series' ? 'series' : 'movie'}/${pv.username}/${pv.password}/${id}.${ext}`;
  openUpstream(url, {}, (err, up) => {
    if (err) { rec.status = 'error'; saveDLIndex(); return; }
    rec.total = parseInt(up.headers['content-length'] || '0', 10) || 0;
    const tmp = abs + '.part';
    const ws = fs.createWriteStream(tmp);
    rec._abort = () => { try { up.destroy(); ws.destroy(); } catch {} };
    up.on('data', (c) => { rec.received += c.length; });
    up.pipe(ws);
    ws.on('finish', () => { try { fs.renameSync(tmp, abs); rec.status = 'done'; } catch { rec.status = 'error'; } saveDLIndex(); });
    ws.on('error', () => { rec.status = 'error'; saveDLIndex(); });
    up.on('error', () => { rec.status = 'error'; saveDLIndex(); });
  });
  saveDLIndex();
  return rec;
}
function removeDownload(key) {
  const r = DOWNLOADS[key]; if (!r) return;
  if (r._abort) r._abort();
  try { fs.unlinkSync(r.file); } catch {}
  try { fs.unlinkSync(r.file + '.part'); } catch {}
  delete DOWNLOADS[key]; saveDLIndex();
}
const cleanRec = (r) => ({ key: r.key, type: r.type, id: r.id, name: r.name, icon: r.icon, ext: r.ext, file: r.file, status: r.status, received: r.received, total: r.total, auto: !!r.auto, expireAt: r.expireAt || 0 });
// apaga os caches temporários (auto) vencidos — não toca nos downloads que o usuário pediu
function cleanupAutoDownloads() {
  const now = Date.now(); let removed = 0;
  for (const k in DOWNLOADS) {
    const r = DOWNLOADS[k];
    if (r.auto && r.expireAt && now > r.expireAt) {
      try { if (r._abort) r._abort(); } catch {}
      try { fs.unlinkSync(r.file); } catch {}
      try { fs.unlinkSync(r.file + '.part'); } catch {}
      delete DOWNLOADS[k]; removed++;
    }
  }
  if (removed) { saveDLIndex(); console.log(`Cache temporário: ${removed} item(ns) vencido(s) apagado(s)`); }
}

// ---- Mídia Local: vídeos que o usuário põe na pasta + filmes/séries baixados ----
const MEDIA_ROOTS = CONFIG.mediaRoots || ['/dados/midia', DLDIR];
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.ts', '.flv', '.wmv']);
function scanDir(dir, out, depth) {
  if (depth > 6) return;
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'lost+found') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) scanDir(full, out, (depth || 0) + 1);
    else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) {
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (full.endsWith('.part')) continue;
      out.push({
        name: e.name.replace(/\.[^.]+$/, '').replace(/^(movie|series)-\d+-/, '').replace(/[._]/g, ' '),
        file: full, size: st.size, ext: path.extname(e.name).slice(1).toLowerCase(), mtime: st.mtimeMs
      });
    }
  }
}
function listLocal() { const out = []; for (const r of MEDIA_ROOTS) scanDir(r, out, 0); out.sort((a, b) => b.mtime - a.mtime); return out; }
const insideRoots = (abs) => MEDIA_ROOTS.some(r => { const R = path.resolve(r); return abs === R || abs.startsWith(R + path.sep); });

// Serve um arquivo local com suporte a Range (seek).
function serveLocal(req, res, abs) {
  fs.stat(abs, (err, st) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const type = MIME[path.extname(abs).toLowerCase()] || 'video/mp4';
    const range = req.headers.range;
    if (range) {
      const mm = /bytes=(\d*)-(\d*)/.exec(range) || [];
      let start = parseInt(mm[1] || '0', 10); let end = mm[2] ? parseInt(mm[2], 10) : st.size - 1;
      if (isNaN(start)) start = 0; if (isNaN(end) || end >= st.size) end = st.size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      fs.createReadStream(abs, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(abs).pipe(res);
    }
  });
}

// ---- cache de imagens (disco + navegador) + encolhimento de pôster TMDb ----
const IMGDIR = CONFIG.cacheDir || '/dados/cache-img';
try { fs.mkdirSync(IMGDIR, { recursive: true }); } catch {}
function imgType(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xFF && b[1] === 0xD8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x52 && b[8] === 0x57) return 'image/webp';
  return 'image/jpeg';
}
function serveImg(res, url) {
  url = url.replace(/\/t\/p\/(w780|w1280|original)\//, '/t/p/w342/'); // TMDb menor p/ card
  const file = path.join(IMGDIR, crypto.createHash('sha1').update(url).digest('hex'));
  const headers = (b) => ({ 'Content-Type': imgType(b), 'Content-Length': b.length, 'Cache-Control': 'public, max-age=1209600, immutable' });
  fs.readFile(file, (err, data) => {
    if (!err && data && data.length) { res.writeHead(200, headers(data)); return res.end(data); }
    fetchBuffer(url, (e, buf) => {
      if (e || !buf || !buf.length) { res.writeHead(502); return res.end(); }
      fs.writeFile(file, buf, () => {});
      res.writeHead(200, headers(buf)); res.end(buf);
    }, 12000);
  });
}

// ---- pré-aquecer o cache: baixa TODAS as capas 1x (incremental: pula as já em cache) ----
let warmState = { running: false, total: 0, done: 0, at: 0 };
function warmOne(url, cb) {
  const u = url.replace(/\/t\/p\/(w780|w1280|original)\//, '/t/p/w342/');
  const file = path.join(IMGDIR, crypto.createHash('sha1').update(u).digest('hex'));
  fs.access(file, (err) => {
    if (!err) return cb();
    fetchBuffer(u, (e, buf) => { if (!e && buf && buf.length) fs.writeFile(file, buf, cb); else cb(); }, 6000);
  });
}
async function warmCache(pv) {
  pv = pv || getPv(DEFAULT_PV);
  if (warmState.running) return;
  if (!sIndex(pv.id).at) await buildIndex(pv);
  const S = sIndex(pv.id);
  const urls = new Set();
  for (const t of ['vod', 'series', 'live']) for (const it of S[t]) if (it.icon) urls.add(it.icon);
  const list = [...urls];
  warmState = { running: true, total: list.length, done: 0, at: Date.now() };
  let i = 0;
  await Promise.all(Array.from({ length: 24 }, () => (async () => {
    while (i < list.length) { const url = list[i++]; await new Promise(r => warmOne(url, r)); warmState.done++; }
  })()));
  warmState.running = false;
}

function serveStatic(res, p) {
  if (p === '/') p = '/index.html';
  const safe = path.normalize(p).replace(/^(\.\.(\/|\\|$))+/, '');
  const file = path.join(__dirname, 'public', safe);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    const h = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // html/js/css sempre revalidam (deploy aplica na hora); logo/ícones podem cachear
    h['Cache-Control'] = /\.(html|js|css)$/.test(ext) ? 'no-cache' : 'public, max-age=86400';
    res.writeHead(200, h);
    res.end(data);
  });
}

const CAT_ACTIONS = { live: 'get_live_categories', vod: 'get_vod_categories', series: 'get_series_categories' };
const STREAM_ACTIONS = { live: 'get_live_streams', vod: 'get_vod_streams', series: 'get_series' };

// categorias "premium" (reconhecíveis) pro Destaque / top avaliados
const PREMIUM_RE = /cinema|lan[çc]amento|4k|uhd|netflix|marvel|disney|hbo|\bmax\b|prime|apple|paramount|star|dc\b|destaque|cl[áa]ssico|top/i;
const premiumCats = {};   // "pvId:type" -> { set, at }
function getPremiumCats(pv, type, cb) {
  const k = pv.id + ':' + type; const c = premiumCats[k];
  if (c && Date.now() - c.at < 3600000) return cb(c.set);
  fetchBuffer(apiUrl(pv, { action: CAT_ACTIONS[type] }), (e, b) => {
    const set = new Set();
    if (!e) { try { const a = JSON.parse(b.toString()); if (Array.isArray(a)) a.forEach(c => { if (PREMIUM_RE.test(c.category_name)) set.add(String(c.category_id)); }); } catch {} }
    premiumCats[k] = { set, at: Date.now() }; cb(set);
  });
}

// perfil Kid = LISTA BRANCA: mostra só categorias infantis (mais seguro que esconder as adultas uma a uma)
const KID_RE = /infantil|infantis|\bkids?\b|desenho|anima[cç][aã]o|crian[cç]|cartoon|gloob|\bnick\b|discovery\s*kid|\bbaby\b|\bjunior\b|\bturma\b|pixar|dreamworks/i;
const kidCatsCache = {};   // "pvId:type" -> { set, at }
function getKidCats(pv, type, cb) {
  const k = pv.id + ':' + type; const c = kidCatsCache[k];
  if (c && Date.now() - c.at < 3600000) return cb(c.set);
  fetchBuffer(apiUrl(pv, { action: CAT_ACTIONS[type] }), (e, b) => {
    const set = new Set();
    if (!e) { try { const a = JSON.parse(b.toString()); if (Array.isArray(a)) a.forEach(cc => { if (KID_RE.test(cc.category_name)) set.add(String(cc.category_id)); }); } catch {} }
    kidCatsCache[k] = { set, at: Date.now() }; cb(set);
  });
}

// ---- índice de busca: catálogo inteiro em memória (nomes normalizados) ----
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const INDEX_TTL = 6 * 3600 * 1000;
const SEARCHES = {};   // pvId -> { live, vod, series, at }  (índice por provedor)
const BUILDING = {};   // pvId -> promise
function sIndex(pvId) { return SEARCHES[pvId] || (SEARCHES[pvId] = { live: [], vod: [], series: [], at: 0 }); }

const minItem = (it, t) => ({
  t, id: it.stream_id ?? it.series_id, name: it.name, icon: it.stream_icon || it.cover,
  rating: it.rating, ext: it.container_extension, cat: it.category_id, _n: norm(it.name)
});

function buildIndex(pv) {
  pv = pv || getPv(DEFAULT_PV);
  if (BUILDING[pv.id]) return BUILDING[pv.id];
  BUILDING[pv.id] = (async () => {
    const out = { live: [], vod: [], series: [], at: Date.now() };
    await Promise.all(['live', 'vod', 'series'].map((t) => new Promise((resolve) => {
      fetchBuffer(apiUrl(pv, { action: STREAM_ACTIONS[t] }), (e, b) => {
        if (!e) { try { const a = JSON.parse(b.toString()); if (Array.isArray(a)) out[t] = a.map((x) => minItem(x, t)); } catch {} }
        resolve();
      });
    })));
    SEARCHES[pv.id] = out; BUILDING[pv.id] = null;
    console.log(`Índice[${pv.id}] pronto: ${out.vod.length} filmes, ${out.series.length} séries, ${out.live.length} canais`);
    return out;
  })();
  return BUILDING[pv.id];
}

function runSearch(res, pv, q, type, limit, onlyCats) {
  const S = sIndex(pv.id);
  const types = type && S[type] ? [type] : ['vod', 'series', 'live'];
  const hits = [];
  for (const t of types) for (const it of S[t]) {
    if (onlyCats && !onlyCats.has(String(it.cat))) continue;   // perfil Kid: só categorias infantis
    if (it._n.includes(q)) { hits.push(it); if (hits.length >= limit * 3) break; }
  }
  hits.sort((a, b) => (b._n.startsWith(q) ? 1 : 0) - (a._n.startsWith(q) ? 1 : 0));
  sendJSON(res, 200, { ready: true, results: hits.slice(0, limit).map(({ _n, ...r }) => r) });
}

// ---- EPG (guia): parseia o XMLTV do provedor e guarda agora/depois por canal ----
const EPGS = {};           // pvId -> { at, byCh }
const EPG_BUILDING = {};   // pvId -> promise
function eIndex(pvId) { return EPGS[pvId] || (EPGS[pvId] = { at: 0, byCh: {} }); }
const decodeEnt = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
function parseXmltvTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/.exec(s || '');
  if (!m) return 0;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (m[7]) { const sign = m[7][0] === '-' ? 1 : -1; t += sign * ((+m[7].slice(1, 3)) * 60 + (+m[7].slice(3, 5))) * 60000; }
  return t;
}
function buildEPG(pv) {
  pv = pv || getPv(DEFAULT_PV);
  if (EPG_BUILDING[pv.id]) return EPG_BUILDING[pv.id];
  EPG_BUILDING[pv.id] = new Promise((resolve) => {
    fetchBuffer(`${pv.base}/xmltv.php?username=${pv.username}&password=${pv.password}`, (e, b) => {
      if (e) { EPG_BUILDING[pv.id] = null; return resolve(eIndex(pv.id)); }
      const xml = b.toString('utf8'); const byCh = {};
      const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
      let m;
      while ((m = re.exec(xml))) {
        const attrs = m[1];
        const chM = /channel="([^"]+)"/.exec(attrs); if (!chM) continue;
        const sts = /start_timestamp="(\d+)"/.exec(attrs);
        const ets = /stop_timestamp="(\d+)"/.exec(attrs);
        const sM = /\bstart="([^"]+)"/.exec(attrs);
        const eM = /\bstop="([^"]+)"/.exec(attrs);
        const s = sts ? +sts[1] * 1000 : (sM ? parseXmltvTime(sM[1]) : 0);
        const e = ets ? +ets[1] * 1000 : (eM ? parseXmltvTime(eM[1]) : 0);
        const tt = /<title[^>]*>([\s\S]*?)<\/title>/.exec(m[2]);
        (byCh[decodeEnt(chM[1])] || (byCh[decodeEnt(chM[1])] = [])).push({ s, e, t: tt ? decodeEnt(tt[1].trim()) : '' });
      }
      for (const ch in byCh) byCh[ch].sort((a, b) => a.s - b.s);
      EPGS[pv.id] = { at: Date.now(), byCh }; EPG_BUILDING[pv.id] = null;
      console.log(`EPG[${pv.id}] pronto: ${Object.keys(byCh).length} canais`);
      resolve(EPGS[pv.id]);
    });
  });
  return EPG_BUILDING[pv.id];
}
const ensureEPG = (pv) => { const c = eIndex(pv.id); return (c.at && Date.now() - c.at < 2 * 3600 * 1000) ? Promise.resolve(c) : buildEPG(pv); };
function epgFor(pvId, ch, now) {
  const list = eIndex(pvId).byCh[ch]; if (!list) return { now: null, upcoming: [] };
  let cur = null, nextIdx = list.length;
  for (let i = 0; i < list.length; i++) {
    if (list[i].s <= now && now < list[i].e) { cur = list[i]; nextIdx = i + 1; break; }
    if (list[i].s > now) { nextIdx = i; break; }
  }
  return { now: cur, upcoming: list.slice(nextIdx, nextIdx + 6) };
}

/* ---------- diagnóstico "travou ou tá ruim" ---------- */
// baixa uns MB do provedor e mede a velocidade real servidor→provedor (MB/s)
function measureSpeed(url, maxBytes, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now(); let got = 0, done = false;
    const finish = (up) => { if (done) return; done = true; try { up && up.destroy(); } catch {} const s = (Date.now() - t0) / 1000; resolve(s > 0.05 ? +((got / 1048576) / s).toFixed(2) : 0); };
    openUpstream(url, { Range: `bytes=0-${maxBytes - 1}` }, (err, up) => {
      if (err) return resolve(0);
      up.on('data', (c) => { got += c.length; if (got >= maxBytes) finish(up); });
      up.on('end', () => finish(up)); up.on('error', () => finish(up));
    }, 0, timeoutMs);
  });
}
// regras: do relatório (cliente + servidor) deduz o gargalo e a correção recomendada. ESSAS REGRAS A GENTE EVOLUI.
function analyzeBottleneck(r) {
  const s = r.server || {}, c = r.client || {};
  const hasAlt = (c.providerCount || 0) > 1;   // perfil tem outro provedor p/ failover?
  const A = {
    reconnect: { id: 'reconnect', label: '🔄 Reconectar o vídeo', auto: true },
    compat: { id: 'compat', label: '⚙ Ligar compatibilidade (transcode)', auto: true },
    switchpv: { id: 'switchpv', label: '📡 Trocar de provedor', auto: false },
    reload: { id: 'reload', label: '🧹 Limpar cache e recarregar', auto: false },
    restart: { id: 'restart', label: '♻️ Reiniciar o servidor', auto: false },
    clean: { id: 'reload', label: '🧹 Recarregar a página', auto: false },
  };
  let cause, verdict, actions;
  if (s.diskFreeGB != null && s.diskFreeGB < 1) {
    cause = 'disk'; verdict = 'Disco do servidor quase cheio — downloads/cache travam.'; actions = [A.reload];
  } else if (s.providerApiMs != null && s.providerApiMs > 6000) {
    cause = 'provider_api'; verdict = 'O provedor está demorando MUITO pra responder (pode estar instável/fora do ar).'; actions = hasAlt ? [A.switchpv, A.reconnect] : [A.reconnect, A.reload];
  } else if (s.providerSpeedMBs != null && s.providerSpeedMBs > 0 && s.providerSpeedMBs < 1.2) {
    cause = 'provider_slow'; verdict = `O provedor está lento (${s.providerSpeedMBs} MB/s do servidor). O gargalo é o provedor/CDN.`; actions = hasAlt ? [A.switchpv, A.reconnect] : [A.reconnect];
  } else if (s.transcodes > 0 && s.loadPerCore > 2.5) {
    cause = 'transcode'; verdict = `O transcode de ${s.transcodes} canal(is) H265 está pesando o servidor. Tente um canal normal (sem [H265]).`; actions = [A.reconnect, A.restart];
  } else if (s.activeDownloads >= 3) {
    cause = 'downloads'; verdict = `${s.activeDownloads} downloads ao mesmo tempo estão saturando a banda.`; actions = [A.reconnect];
  } else if (s.loadPerCore > 3) {
    cause = 'server_load'; verdict = 'O servidor (ou o host Proxmox) está sobrecarregado — pode ser outra VM/backup rodando, não necessariamente o Fluxo. Reiniciar o Fluxo só ajuda se o peso for dele.'; actions = [A.reconnect, A.restart];
  } else if ((s.providerSpeedMBs == null || s.providerSpeedMBs >= 2) && (c.stalls > 0 || c.bufferedAhead < 2 || c.videoErr)) {
    cause = 'client'; verdict = 'O servidor puxa bem do provedor, então o gargalo é a SUA rede (wifi/Tailscale) ou o aparelho.'; actions = c.liveTC ? [A.reconnect, A.clean] : [A.reconnect, A.compat, A.clean];
  } else {
    cause = 'unclear'; verdict = 'Não achei um gargalo claro. Vou religar a conexão — se persistir, tente recarregar.'; actions = [A.reconnect, A.reload];
  }
  return { cause, verdict, actions, server: s };
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  const q = u.searchParams;
  const pv = pvOf(q, req);              // provedor desta requisição (?pv= ou cookie, senão o padrão)

  // ---- configuração pública (SEM segredos: nunca devolve usuário/senha) ----
  if (p === '/api/config') {
    return sendJSON(res, 200, {
      providers: (CONFIG.providers || []).map(x => ({ id: x.id, name: x.name, host: x.host })),
      profiles: CONFIG.profiles || [],
      hasPin: !!CONFIG.adminPin,
      defaultPv: DEFAULT_PV
    });
  }
  // ---- admin (tudo protegido por PIN quando houver) ----
  if (p === '/api/admin/auth') return readJSON(req, d => sendJSON(res, 200, { ok: pinOk(d && d.pin) }));
  if (p === '/api/admin/provider') return readJSON(req, d => {
    if (!d || !pinOk(d.pin)) return sendJSON(res, 403, { error: 'pin' });
    const inp = d.provider || {};
    if (!inp.host) return sendJSON(res, 400, { error: 'falta o host' });
    CONFIG.providers = CONFIG.providers || [];
    let id = inp.id;
    if (id && CONFIG.providers.some(x => x.id === id)) {   // edição: usuário/senha em branco mantêm os atuais
      const cur = CONFIG.providers.find(x => x.id === id);
      cur.name = inp.name || cur.name; cur.host = inp.host;
      if (inp.username) cur.username = inp.username;
      if (inp.password) cur.password = inp.password;
      if (inp.userAgent !== undefined) cur.userAgent = inp.userAgent || undefined;
    } else {                                               // novo: precisa de usuário e senha
      if (!inp.username || !inp.password) return sendJSON(res, 400, { error: 'novo provedor precisa de usuário e senha' });
      id = slugify(inp.name || inp.host); while (CONFIG.providers.some(x => x.id === id)) id += '2';
      CONFIG.providers.push({ id, name: inp.name || inp.host, host: inp.host, username: inp.username, password: inp.password, userAgent: inp.userAgent || undefined });
    }
    saveConfig(); loadProviders();
    delete SEARCHES[id]; delete EPGS[id];   // novas credenciais -> reconstrói índice/EPG
    sendJSON(res, 200, { ok: true, id });
  });
  if (p === '/api/admin/provider/delete') return readJSON(req, d => {
    if (!d || !pinOk(d.pin)) return sendJSON(res, 403, { error: 'pin' });
    if ((CONFIG.providers || []).length <= 1) return sendJSON(res, 400, { error: 'precisa de ao menos 1 provedor' });
    CONFIG.providers = CONFIG.providers.filter(x => x.id !== d.id);
    (CONFIG.profiles || []).forEach(pf => { pf.providers = (pf.providers || []).filter(x => x !== d.id); if (!pf.providers.length) pf.providers = [CONFIG.providers[0].id]; });
    saveConfig(); loadProviders(); sendJSON(res, 200, { ok: true });
  });
  if (p === '/api/admin/provider/test') return readJSON(req, d => {
    if (!d || !pinOk(d.pin)) return sendJSON(res, 403, { error: 'pin' });
    const inp = d.provider || {};
    if (!inp.host) return sendJSON(res, 400, { ok: false, error: 'sem host' });
    const tpv = { base: `http://${inp.host}`, username: inp.username, password: inp.password };
    fetchBuffer(apiUrl(tpv, {}), (e, b) => {
      if (e) return sendJSON(res, 200, { ok: false, error: 'não respondeu' });
      try { const ui = (JSON.parse(b.toString()).user_info) || {}; sendJSON(res, 200, { ok: ui.auth === 1 || ui.status === 'Active', status: ui.status, exp: ui.exp_date, active: ui.active_cons, max: ui.max_connections }); }
      catch { sendJSON(res, 200, { ok: false, error: 'resposta inválida' }); }
    }, 12000);
  });
  if (p === '/api/admin/profile') return readJSON(req, d => {
    if (!d || !pinOk(d.pin)) return sendJSON(res, 403, { error: 'pin' });
    const inp = d.profile || {};
    if (!inp.name) return sendJSON(res, 400, { error: 'sem nome' });
    const provs = (inp.providers && inp.providers.length ? inp.providers : [DEFAULT_PV]).filter(x => PROVIDERS[x]);
    CONFIG.profiles = CONFIG.profiles || [];
    let id = inp.id;
    if (id && CONFIG.profiles.some(x => x.id === id)) {
      Object.assign(CONFIG.profiles.find(x => x.id === id), { name: inp.name, kid: !!inp.kid, providers: provs.length ? provs : [DEFAULT_PV], color: inp.color || '#7c9cff' });
    } else {
      id = slugify(inp.name); while (CONFIG.profiles.some(x => x.id === id)) id += '2';
      CONFIG.profiles.push({ id, name: inp.name, kid: !!inp.kid, providers: provs.length ? provs : [DEFAULT_PV], color: inp.color || '#7c9cff' });
    }
    saveConfig(); sendJSON(res, 200, { ok: true, id });
  });
  if (p === '/api/admin/profile/delete') return readJSON(req, d => {
    if (!d || !pinOk(d.pin)) return sendJSON(res, 403, { error: 'pin' });
    if ((CONFIG.profiles || []).length <= 1) return sendJSON(res, 400, { error: 'precisa de ao menos 1 perfil' });
    CONFIG.profiles = CONFIG.profiles.filter(x => x.id !== d.id);
    saveConfig(); sendJSON(res, 200, { ok: true });
  });
  if (p === '/api/admin/pin') return readJSON(req, d => {
    if (!d || !pinOk(d.pin)) return sendJSON(res, 403, { error: 'pin' });
    const np = (d.newPin || '').toString().trim();
    if (np) CONFIG.adminPin = np; else delete CONFIG.adminPin;
    saveConfig(); sendJSON(res, 200, { ok: true });
  });

  // ---- diagnóstico "travou ou tá ruim": coleta cliente+servidor, acha o gargalo, grava e recomenda ----
  if (p === '/api/diag') return readJSON(req, async (client) => {
    client = client || {};
    const S = {};
    S.loadPerCore = +(os.loadavg()[0] / (os.cpus().length || 1)).toFixed(2);
    S.memFreePct = Math.round(os.freemem() / os.totalmem() * 100);
    try { const st = fs.statfsSync('/dados'); S.diskFreeGB = +((st.bavail * st.bsize) / 1e9).toFixed(1); } catch {}
    S.activeDownloads = Object.values(DOWNLOADS).filter(d => d.status === 'downloading').length;
    S.transcodes = transcodeCount;
    S.logTail = LOGBUF.slice(-15);
    const t0 = Date.now();
    await new Promise(r => fetchBuffer(apiUrl(pv, {}), () => { S.providerApiMs = Date.now() - t0; r(); }, 8000));
    if (client.ctx && (client.ctx.type === 'movie' || client.ctx.type === 'series')) {
      const kind = client.ctx.type === 'movie' ? 'movie' : 'series';
      const url = `${pv.base}/${kind}/${pv.username}/${pv.password}/${client.ctx.id}.${client.ctx.ext || 'mp4'}`;
      S.providerSpeedMBs = await measureSpeed(url, 6 * 1048576, 10000);
    }
    const diag = analyzeBottleneck({ client, server: S });
    try { fs.appendFileSync('/dados/fluxo-diag.jsonl', JSON.stringify({ at: Date.now(), client, server: S, cause: diag.cause, verdict: diag.verdict }) + '\n'); } catch {}
    sendJSON(res, 200, diag);
  });
  if (p === '/api/diag/restart') {   // reinício pedido pelo usuário (systemd Restart=always sobe de novo)
    sendJSON(res, 200, { ok: true });
    console.log('Reinício solicitado pelo diagnóstico');
    setTimeout(() => process.exit(0), 400);
    return;
  }
  if (p === '/api/diag/history') {   // últimas linhas do diagnóstico (pra análise)
    let lines = [];
    try { lines = fs.readFileSync('/dados/fluxo-diag.jsonl', 'utf8').trim().split('\n').slice(-50).map(l => JSON.parse(l)); } catch {}
    return sendJSON(res, 200, { reports: lines });
  }

  if (p === '/api/categories') {
    const type = q.get('type'); const action = CAT_ACTIONS[type];
    if (!action) return sendJSON(res, 400, { error: 'bad type' });
    const kid = isKid(q, req);
    return fetchBuffer(apiUrl(pv, { action }), (e, b) => {
      if (e) return sendJSON(res, 502, { error: 'upstream' });
      if (!kid) return passThroughJSON(res, b);
      let a = []; try { a = JSON.parse(b.toString()); } catch {}
      if (Array.isArray(a)) a = a.filter(c => KID_RE.test(c.category_name));   // perfil Kid: SÓ categorias infantis
      sendJSON(res, 200, a);
    });
  }
  if (p === '/api/streams') {
    const type = q.get('type'); const action = STREAM_ACTIONS[type];
    if (!action) return sendJSON(res, 400, { error: 'bad type' });
    const params = { action };
    if (q.get('category_id')) params.category_id = q.get('category_id');
    const kid = isKid(q, req);
    return fetchBuffer(apiUrl(pv, params), (e, b) => {
      if (e) return sendJSON(res, 502, { error: 'upstream' });
      if (!kid) return passThroughJSON(res, b);
      getKidCats(pv, type, (good) => {                                           // perfil Kid: SÓ itens de categoria infantil
        let a = []; try { a = JSON.parse(b.toString()); } catch {}
        if (Array.isArray(a)) a = a.filter(it => good.has(String(it.category_id)));
        sendJSON(res, 200, a);
      });
    });
  }
  if (p === '/api/vod') {
    return fetchBuffer(apiUrl(pv, { action: 'get_vod_info', vod_id: q.get('id') || '' }), (e, b) => e ? sendJSON(res, 502, { error: 'upstream' }) : passThroughJSON(res, b));
  }
  if (p === '/api/series') {
    return fetchBuffer(apiUrl(pv, { action: 'get_series_info', series_id: q.get('id') || '' }), (e, b) => e ? sendJSON(res, 502, { error: 'upstream' }) : passThroughJSON(res, b));
  }
  if (p === '/api/search') {
    const term = norm(q.get('q'));
    const type = q.get('type');
    const limit = Math.min(parseInt(q.get('limit') || '60', 10) || 60, 120);
    if (term.length < 2) return sendJSON(res, 200, { ready: true, results: [] });
    const kid = isKid(q, req);
    const go = () => {
      if (!kid) return runSearch(res, pv, term, type, limit, null);
      const types = type ? [type] : ['vod', 'series', 'live'];
      let left = types.length; const good = new Set();
      types.forEach(t => getKidCats(pv, t, s => { s.forEach(x => good.add(x)); if (--left === 0) runSearch(res, pv, term, type, limit, good); }));
    };
    const S = sIndex(pv.id);
    if (S.at && Date.now() - S.at < INDEX_TTL) return go();
    return buildIndex(pv).then(go).catch(() => sendJSON(res, 200, { ready: false, results: [] }));
  }
  if (p === '/api/download') {
    const rec = startDownload({ type: q.get('type') || 'movie', id: q.get('id'), ext: q.get('ext'), name: q.get('name'), icon: q.get('icon'), pv, auto: q.get('auto') === '1' });
    return sendJSON(res, 200, { ok: true, item: cleanRec(rec) });
  }
  if (p === '/api/downloads') {
    return sendJSON(res, 200, { items: Object.values(DOWNLOADS).map(cleanRec) });
  }
  if (p === '/api/download/delete') {
    removeDownload(q.get('key')); return sendJSON(res, 200, { ok: true });
  }
  if (p === '/api/epg') {
    return ensureEPG(pv).then(() => sendJSON(res, 200, epgFor(pv.id, q.get('ch'), Date.now())));
  }
  if (p === '/api/epg/now') {
    return ensureEPG(pv).then(() => {
      const now = Date.now(); const out = {}; const E = eIndex(pv.id);
      for (const ch in E.byCh) { const f = epgFor(pv.id, ch, now); if (f.now) out[ch] = { t: f.now.t, s: f.now.s, e: f.now.e, n: (f.upcoming[0] && f.upcoming[0].t) || '' }; }
      sendJSON(res, 200, { at: E.at, ch: out });
    });
  }
  if (p === '/api/cache/warm') { warmCache(pv); return sendJSON(res, 200, { ok: true }); }
  if (p === '/api/cache/status') { return sendJSON(res, 200, warmState); }
  if (p === '/api/top') {
    const type = q.get('type') === 'series' ? 'series' : 'vod';
    const limit = Math.min(parseInt(q.get('limit') || '24', 10) || 24, 60);
    const kid = isKid(q, req);
    const run = () => getPremiumCats(pv, type, (prem) => getKidCats(pv, type, (good) => {
      const arr = (sIndex(pv.id)[type] || [])
        .filter(it => it.icon && it.rating && parseFloat(it.rating) >= 7 && parseFloat(it.rating) <= 9.6 && (prem.size === 0 || prem.has(String(it.cat))))
        .filter(it => !kid || good.has(String(it.cat)))   // perfil Kid: só categorias infantis
        .sort((a, b) => parseFloat(b.rating) - parseFloat(a.rating))
        .slice(0, limit).map(({ _n, ...r }) => r);
      sendJSON(res, 200, { results: arr });
    }));
    if (sIndex(pv.id).at) return run();
    return buildIndex(pv).then(run);
  }
  if (p === '/api/local') {
    return sendJSON(res, 200, { items: listLocal().map(x => ({ name: x.name, file: x.file, size: x.size, ext: x.ext })) });
  }
  if (p === '/local') {
    const abs = path.resolve(q.get('f') || '');
    if (!insideRoots(abs)) { res.writeHead(403); return res.end(); }
    return serveLocal(req, res, abs);
  }
  if (p === '/api/state') {
    const firstProfile = (CONFIG.profiles && CONFIG.profiles[0] && CONFIG.profiles[0].id) || 'eu';
    const prof = ((q.get('profile') || cookieVal(req, 'fluxo_prof') || firstProfile).replace(/[^\w-]/g, '').slice(0, 40)) || firstProfile;
    // perfil principal fica no arquivo legado (preserva favoritos existentes); outros ganham o seu
    const STATE_FILE = prof === firstProfile ? '/dados/.fluxo-state.json' : `/dados/.fluxo-state-${prof}.json`;
    if (req.method === 'POST') {
      let body = ''; req.on('data', c => { body += c; if (body.length > 4e6) req.destroy(); });
      req.on('end', () => { try { JSON.parse(body); fs.writeFileSync(STATE_FILE, body); } catch {} sendJSON(res, 200, { ok: true }); });
      return;
    }
    let data = {};
    try { data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
    return sendJSON(res, 200, data);
  }
  if (p === '/api/torrent/search') {
    if (!JK) return sendJSON(res, 200, { results: [], noJackett: true });
    const fixLink = (l) => l ? l.replace('http://127.0.0.1:9117', JK.url).replace('http://localhost:9117', JK.url) : '';
    const run = () => jackettParallel(q.get('q') || '', PER_TRACKER_TIMEOUT, ({ results, health }) => {
      const out = results.map(r => ({ title: r.Title, size: r.Size, seeders: r.Seeders, peers: r.Peers, tracker: r.Tracker, magnet: r.MagnetUri || fixLink(r.Link) }))
        .filter(r => r.magnet && (r.seeders || 0) < 30000)   // corta spam de seeds falsos (int16 max)
        .sort((a, c) => (c.seeders || 0) - (a.seeders || 0)).slice(0, 80);
      sendJSON(res, 200, { results: out, skipped: health.filter(h => !h.ok).map(h => h.name) });
    }, 8000);   // teto geral: no máximo ~8s, mesmo se algum tracker pendurar
    if (!indexerList.length) return fetchIndexerList(run);   // aprende os ids na 1ª vez
    return run();
  }
  if (p === '/api/torrent/add') {
    const magnet = q.get('magnet') || '';
    if (!magnet) return sendJSON(res, 400, { error: 'sem magnet' });
    const addToTm = (filename) => transmissionRPC('torrent-add', { filename, 'download-dir': TORRENT_DIR }, (e, r) => {
      const a = r && r.arguments;
      const ok = !e && a && (a['torrent-added'] || a['torrent-duplicate']);
      sendJSON(res, 200, { ok: !!ok, result: ok ? 'success' : ((r && r.result) || 'falha ao adicionar') });
    });
    if (/^https?:/i.test(magnet)) return resolveTorrent(magnet, addToTm);
    return addToTm(magnet);
  }
  if (p === '/api/torrent/list') {
    return transmissionRPC('torrent-get', { fields: ['id', 'name', 'percentDone', 'status', 'rateDownload', 'eta', 'totalSize'] }, (e, r) => {
      sendJSON(res, 200, { torrents: (!e && r && r.arguments && r.arguments.torrents) || [] });
    });
  }
  if (p === '/api/torrent/delete') {
    return transmissionRPC('torrent-remove', { ids: [parseInt(q.get('id') || '0', 10)], 'delete-local-data': q.get('trash') === '1' }, () => sendJSON(res, 200, { ok: true }));
  }
  if (p === '/api/torrent/trackers') {
    if (!JK) return sendJSON(res, 200, { trackers: [] });
    const fresh = Date.now() - trackerCache.at < TRK_TTL;
    if (trackerCache.list.length) {              // tem cache: responde na hora
      if (!fresh) refreshTrackers();             // e revalida em 2º plano se estiver velho
      return sendJSON(res, 200, { trackers: trackerCache.list });
    }
    refreshTrackers();                           // cache vazio (esquentando): não trava o usuário
    return sendJSON(res, 200, { trackers: [], warming: true });
  }
  if (p === '/img') {
    const src = q.get('u');
    if (!src) { res.writeHead(400); return res.end(); }
    return serveImg(res, src);
  }

  let m;
  // HLS ao vivo (toca nativo no Safari / hls.js = aceleração de hardware, leve)
  if ((m = p.match(/^\/hls\/live\/(\d+)\.m3u8$/))) return serveHls(res, `${pv.base}/live/${pv.username}/${pv.password}/${m[1]}.m3u8`);
  if (p === '/hls/p') { const s = q.get('u'); if (!s) { res.writeHead(400); return res.end(); } return serveHls(res, s); }
  if (p === '/hls/seg') { const s = q.get('u'); if (!s) { res.writeHead(400); return res.end(); } return proxyStream(req, res, s); }

  // arquivo já baixado no servidor (toca local, com seek)
  if ((m = p.match(/^\/dl\/(.+)$/))) {
    const safe = path.basename(decodeURIComponent(m[1]));
    return serveLocal(req, res, path.join(DLDIR, safe));
  }

  if ((m = p.match(/^\/stream\/live\/(\d+)$/))) return proxyStream(req, res, `${pv.base}/live/${pv.username}/${pv.password}/${m[1]}.ts`);
  // transcode ao vivo HEVC->H264 (pra canais [H265] tocarem em qualquer tela)
  if ((m = p.match(/^\/transcode\/live\/(\d+)$/))) {
    const src = `${pv.base}/live/${pv.username}/${pv.password}/${m[1]}.ts`;
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-user_agent', UA, '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '2',
      '-rw_timeout', '12000000', '-fflags', '+genpts', '-i', src,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
      '-g', '50', '-b:v', '3000k', '-maxrate', '3000k', '-bufsize', '6000k',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      '-f', 'mpegts', '-muxdelay', '0', 'pipe:1'
    ]);
    transcodeCount++;
    ff.stdout.pipe(res);
    ff.stderr.resume();
    let ended = false; const endOne = () => { if (!ended) { ended = true; transcodeCount = Math.max(0, transcodeCount - 1); } };
    const kill = () => { try { ff.kill('SIGKILL'); } catch {} };
    req.on('close', kill);
    ff.on('error', () => { endOne(); try { res.end(); } catch {} });
    ff.on('exit', () => { endOne(); try { res.end(); } catch {} });
    return;
  }
  if ((m = p.match(/^\/stream\/movie\/(\d+)\.([a-z0-9]+)$/i))) {
    const dl = q.get('dl') ? { filename: `${sanitize(q.get('name') || 'filme')}.${m[2]}` } : undefined;
    return proxyStream(req, res, `${pv.base}/movie/${pv.username}/${pv.password}/${m[1]}.${m[2]}`, dl);
  }
  if ((m = p.match(/^\/stream\/series\/(\d+)\.([a-z0-9]+)$/i))) {
    const dl = q.get('dl') ? { filename: `${sanitize(q.get('name') || 'episodio')}.${m[2]}` } : undefined;
    return proxyStream(req, res, `${pv.base}/series/${pv.username}/${pv.password}/${m[1]}.${m[2]}`, dl);
  }

  serveStatic(res, p);
});

loadDLIndex();
cleanupAutoDownloads();                          // limpa caches temporários vencidos no boot
setInterval(cleanupAutoDownloads, 3600 * 1000);  // e de hora em hora
server.listen(PORT, () => {
  const def = getPv(DEFAULT_PV);
  console.log(`Fluxo rodando em http://0.0.0.0:${PORT}  (provedores: ${Object.keys(PROVIDERS).join(', ')} | padrão: ${def ? def.host : '—'})`);
  buildIndex(def); // aquece o índice de busca do provedor padrão em segundo plano
  buildEPG(def);   // aquece o guia (XMLTV) do provedor padrão em segundo plano
  if (JK) {
    setTimeout(() => fetchIndexerList(refreshTrackers), 3000); // aprende os ids e já checa a saúde (antes do 1º clique)
    setInterval(refreshTrackers, 4 * 60 * 1000);               // saúde periódica (consulta paralela, resiliente)
    setInterval(fetchIndexerList, 30 * 60 * 1000);             // re-descobre ids (trackers novos/removidos)
  }
});
