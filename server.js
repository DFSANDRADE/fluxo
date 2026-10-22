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

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const { host, username, password } = CONFIG.provider;
const UA = CONFIG.userAgent || 'okhttp/4.9';
const PORT = CONFIG.port || 8085;
const BASE = `http://${host}`;
const JK = CONFIG.jackett || null;
const TM = CONFIG.transmission || { host: '127.0.0.1', port: 9091 };
const TORRENT_DIR = CONFIG.torrentDir || '/dados/midia/torrents';

let trackerCache = { at: 0, list: [] };
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

const apiUrl = (params) =>
  `${BASE}/player_api.php?${new URLSearchParams(Object.assign({ username, password }, params))}`;

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
function startDownload({ type, id, ext, name, icon }) {
  const key = dlKey(type, id);
  if (DOWNLOADS[key] && DOWNLOADS[key].status !== 'error') return DOWNLOADS[key];
  ext = (ext || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4';
  const subdir = type === 'series' ? 'series' : 'filmes';
  const dir = path.join('/dados/midia', subdir);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const abs = path.join(dir, `${sanitize(name)}.${ext}`);
  const rec = DOWNLOADS[key] = { key, type, id, ext, name, icon, file: abs, status: 'downloading', received: 0, total: 0, at: Date.now() };
  const url = `${BASE}/${type === 'series' ? 'series' : 'movie'}/${username}/${password}/${id}.${ext}`;
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
const cleanRec = (r) => ({ key: r.key, type: r.type, id: r.id, name: r.name, icon: r.icon, ext: r.ext, file: r.file, status: r.status, received: r.received, total: r.total });

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
async function warmCache() {
  if (warmState.running) return;
  if (!SEARCH.at) await buildIndex();
  const urls = new Set();
  for (const t of ['vod', 'series', 'live']) for (const it of SEARCH[t]) if (it.icon) urls.add(it.icon);
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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

const CAT_ACTIONS = { live: 'get_live_categories', vod: 'get_vod_categories', series: 'get_series_categories' };
const STREAM_ACTIONS = { live: 'get_live_streams', vod: 'get_vod_streams', series: 'get_series' };

// categorias "premium" (reconhecíveis) pro Destaque / top avaliados
const PREMIUM_RE = /cinema|lan[çc]amento|4k|uhd|netflix|marvel|disney|hbo|\bmax\b|prime|apple|paramount|star|dc\b|destaque|cl[áa]ssico|top/i;
const premiumCats = { vod: null, series: null, at: 0 };
function getPremiumCats(type, cb) {
  if (premiumCats[type] && Date.now() - premiumCats.at < 3600000) return cb(premiumCats[type]);
  fetchBuffer(apiUrl({ action: CAT_ACTIONS[type] }), (e, b) => {
    const set = new Set();
    if (!e) { try { const a = JSON.parse(b.toString()); if (Array.isArray(a)) a.forEach(c => { if (PREMIUM_RE.test(c.category_name)) set.add(String(c.category_id)); }); } catch {} }
    premiumCats[type] = set; premiumCats.at = Date.now(); cb(set);
  });
}

// ---- índice de busca: catálogo inteiro em memória (nomes normalizados) ----
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const INDEX_TTL = 6 * 3600 * 1000;
let SEARCH = { live: [], vod: [], series: [], at: 0 };
let building = null;

const minItem = (it, t) => ({
  t, id: it.stream_id ?? it.series_id, name: it.name, icon: it.stream_icon || it.cover,
  rating: it.rating, ext: it.container_extension, cat: it.category_id, _n: norm(it.name)
});

function buildIndex() {
  if (building) return building;
  building = (async () => {
    const out = { live: [], vod: [], series: [], at: Date.now() };
    await Promise.all(['live', 'vod', 'series'].map((t) => new Promise((resolve) => {
      fetchBuffer(apiUrl({ action: STREAM_ACTIONS[t] }), (e, b) => {
        if (!e) { try { const a = JSON.parse(b.toString()); if (Array.isArray(a)) out[t] = a.map((x) => minItem(x, t)); } catch {} }
        resolve();
      });
    })));
    SEARCH = out; building = null;
    console.log(`Índice pronto: ${out.vod.length} filmes, ${out.series.length} séries, ${out.live.length} canais`);
    return out;
  })();
  return building;
}

function runSearch(res, q, type, limit) {
  const types = type && SEARCH[type] ? [type] : ['vod', 'series', 'live'];
  const hits = [];
  for (const t of types) for (const it of SEARCH[t]) {
    if (it._n.includes(q)) { hits.push(it); if (hits.length >= limit * 3) break; }
  }
  hits.sort((a, b) => (b._n.startsWith(q) ? 1 : 0) - (a._n.startsWith(q) ? 1 : 0));
  sendJSON(res, 200, { ready: true, results: hits.slice(0, limit).map(({ _n, ...r }) => r) });
}

// ---- EPG (guia): parseia o XMLTV do provedor e guarda agora/depois por canal ----
let EPG = { at: 0, byCh: {} };
let epgBuilding = null;
const decodeEnt = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
function parseXmltvTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/.exec(s || '');
  if (!m) return 0;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (m[7]) { const sign = m[7][0] === '-' ? 1 : -1; t += sign * ((+m[7].slice(1, 3)) * 60 + (+m[7].slice(3, 5))) * 60000; }
  return t;
}
function buildEPG() {
  if (epgBuilding) return epgBuilding;
  epgBuilding = new Promise((resolve) => {
    fetchBuffer(`${BASE}/xmltv.php?username=${username}&password=${password}`, (e, b) => {
      if (e) { epgBuilding = null; return resolve(EPG); }
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
      EPG = { at: Date.now(), byCh }; epgBuilding = null;
      console.log(`EPG pronto: ${Object.keys(byCh).length} canais`);
      resolve(EPG);
    });
  });
  return epgBuilding;
}
const ensureEPG = () => (EPG.at && Date.now() - EPG.at < 2 * 3600 * 1000) ? Promise.resolve(EPG) : buildEPG();
function epgFor(ch, now) {
  const list = EPG.byCh[ch]; if (!list) return { now: null, upcoming: [] };
  let cur = null, nextIdx = list.length;
  for (let i = 0; i < list.length; i++) {
    if (list[i].s <= now && now < list[i].e) { cur = list[i]; nextIdx = i + 1; break; }
    if (list[i].s > now) { nextIdx = i; break; }
  }
  return { now: cur, upcoming: list.slice(nextIdx, nextIdx + 6) };
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  const q = u.searchParams;

  if (p === '/api/categories') {
    const action = CAT_ACTIONS[q.get('type')];
    if (!action) return sendJSON(res, 400, { error: 'bad type' });
    return fetchBuffer(apiUrl({ action }), (e, b) => e ? sendJSON(res, 502, { error: 'upstream' }) : passThroughJSON(res, b));
  }
  if (p === '/api/streams') {
    const action = STREAM_ACTIONS[q.get('type')];
    if (!action) return sendJSON(res, 400, { error: 'bad type' });
    const params = { action };
    if (q.get('category_id')) params.category_id = q.get('category_id');
    return fetchBuffer(apiUrl(params), (e, b) => e ? sendJSON(res, 502, { error: 'upstream' }) : passThroughJSON(res, b));
  }
  if (p === '/api/vod') {
    return fetchBuffer(apiUrl({ action: 'get_vod_info', vod_id: q.get('id') || '' }), (e, b) => e ? sendJSON(res, 502, { error: 'upstream' }) : passThroughJSON(res, b));
  }
  if (p === '/api/series') {
    return fetchBuffer(apiUrl({ action: 'get_series_info', series_id: q.get('id') || '' }), (e, b) => e ? sendJSON(res, 502, { error: 'upstream' }) : passThroughJSON(res, b));
  }
  if (p === '/api/search') {
    const term = norm(q.get('q'));
    const type = q.get('type');
    const limit = Math.min(parseInt(q.get('limit') || '60', 10) || 60, 120);
    if (term.length < 2) return sendJSON(res, 200, { ready: true, results: [] });
    if (SEARCH.at && Date.now() - SEARCH.at < INDEX_TTL) return runSearch(res, term, type, limit);
    return buildIndex().then(() => runSearch(res, term, type, limit)).catch(() => sendJSON(res, 200, { ready: false, results: [] }));
  }
  if (p === '/api/download') {
    const rec = startDownload({ type: q.get('type') || 'movie', id: q.get('id'), ext: q.get('ext'), name: q.get('name'), icon: q.get('icon') });
    return sendJSON(res, 200, { ok: true, item: cleanRec(rec) });
  }
  if (p === '/api/downloads') {
    return sendJSON(res, 200, { items: Object.values(DOWNLOADS).map(cleanRec) });
  }
  if (p === '/api/download/delete') {
    removeDownload(q.get('key')); return sendJSON(res, 200, { ok: true });
  }
  if (p === '/api/epg') {
    return ensureEPG().then(() => sendJSON(res, 200, epgFor(q.get('ch'), Date.now())));
  }
  if (p === '/api/epg/now') {
    return ensureEPG().then(() => {
      const now = Date.now(); const out = {};
      for (const ch in EPG.byCh) { const f = epgFor(ch, now); if (f.now) out[ch] = { t: f.now.t, s: f.now.s, e: f.now.e, n: (f.upcoming[0] && f.upcoming[0].t) || '' }; }
      sendJSON(res, 200, { at: EPG.at, ch: out });
    });
  }
  if (p === '/api/cache/warm') { warmCache(); return sendJSON(res, 200, { ok: true }); }
  if (p === '/api/cache/status') { return sendJSON(res, 200, warmState); }
  if (p === '/api/top') {
    const type = q.get('type') === 'series' ? 'series' : 'vod';
    const limit = Math.min(parseInt(q.get('limit') || '24', 10) || 24, 60);
    const run = () => getPremiumCats(type, (prem) => {
      const arr = (SEARCH[type] || [])
        .filter(it => it.icon && it.rating && parseFloat(it.rating) >= 7 && parseFloat(it.rating) <= 9.6 && (prem.size === 0 || prem.has(String(it.cat))))
        .sort((a, b) => parseFloat(b.rating) - parseFloat(a.rating))
        .slice(0, limit).map(({ _n, ...r }) => r);
      sendJSON(res, 200, { results: arr });
    });
    if (SEARCH.at) return run();
    return buildIndex().then(run);
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
    const STATE_FILE = '/dados/.fluxo-state.json';
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
    const url = `${JK.url}/api/v2.0/indexers/all/results?apikey=${JK.apikey}&Query=${encodeURIComponent(q.get('q') || '')}`;
    return fetchBuffer(url, (e, b) => {
      if (e) return sendJSON(res, 502, { error: 'jackett' });
      let out = [];
      try {
        const d = JSON.parse(b.toString());
        const fixLink = (l) => l ? l.replace('http://127.0.0.1:9117', JK.url).replace('http://localhost:9117', JK.url) : '';
        out = (d.Results || []).map(r => ({ title: r.Title, size: r.Size, seeders: r.Seeders, peers: r.Peers, tracker: r.Tracker, magnet: r.MagnetUri || fixLink(r.Link) }))
          .filter(r => r.magnet && (r.seeders || 0) < 30000)   // corta spam de seeds falsos (int16 max)
          .sort((a, c) => (c.seeders || 0) - (a.seeders || 0)).slice(0, 80);
      } catch {}
      sendJSON(res, 200, { results: out });
    }, 45000);
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
    if (Date.now() - trackerCache.at < 120000 && trackerCache.list.length) return sendJSON(res, 200, { trackers: trackerCache.list });
    const url = `${JK.url}/api/v2.0/indexers/all/results?apikey=${JK.apikey}&Query=matrix`;
    return fetchBuffer(url, (e, b) => {
      let list = trackerCache.list;
      if (!e) {
        try {
          const d = JSON.parse(b.toString());
          list = (d.Indexers || []).map(i => ({ name: i.Name, ok: !i.Error, error: String(i.Error || '').replace(/Jackett\.Common\.IndexerException:\s*/g, '').replace(/\s+/g, ' ').slice(0, 160) }))
            .sort((a, c) => (a.ok === c.ok) ? a.name.localeCompare(c.name) : (a.ok ? 1 : -1));
        } catch {}
      }
      trackerCache = { at: Date.now(), list };
      sendJSON(res, 200, { trackers: list });
    }, 45000);
  }
  if (p === '/img') {
    const src = q.get('u');
    if (!src) { res.writeHead(400); return res.end(); }
    return serveImg(res, src);
  }

  let m;
  // HLS ao vivo (toca nativo no Safari / hls.js = aceleração de hardware, leve)
  if ((m = p.match(/^\/hls\/live\/(\d+)\.m3u8$/))) return serveHls(res, `${BASE}/live/${username}/${password}/${m[1]}.m3u8`);
  if (p === '/hls/p') { const s = q.get('u'); if (!s) { res.writeHead(400); return res.end(); } return serveHls(res, s); }
  if (p === '/hls/seg') { const s = q.get('u'); if (!s) { res.writeHead(400); return res.end(); } return proxyStream(req, res, s); }

  // arquivo já baixado no servidor (toca local, com seek)
  if ((m = p.match(/^\/dl\/(.+)$/))) {
    const safe = path.basename(decodeURIComponent(m[1]));
    return serveLocal(req, res, path.join(DLDIR, safe));
  }

  if ((m = p.match(/^\/stream\/live\/(\d+)$/))) return proxyStream(req, res, `${BASE}/live/${username}/${password}/${m[1]}.ts`);
  // transcode ao vivo HEVC->H264 (pra canais [H265] tocarem em qualquer tela)
  if ((m = p.match(/^\/transcode\/live\/(\d+)$/))) {
    const src = `${BASE}/live/${username}/${password}/${m[1]}.ts`;
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
    ff.stdout.pipe(res);
    ff.stderr.resume();
    const kill = () => { try { ff.kill('SIGKILL'); } catch {} };
    req.on('close', kill);
    ff.on('error', () => { try { res.end(); } catch {} });
    ff.on('exit', () => { try { res.end(); } catch {} });
    return;
  }
  if ((m = p.match(/^\/stream\/movie\/(\d+)\.([a-z0-9]+)$/i))) {
    const dl = q.get('dl') ? { filename: `${sanitize(q.get('name') || 'filme')}.${m[2]}` } : undefined;
    return proxyStream(req, res, `${BASE}/movie/${username}/${password}/${m[1]}.${m[2]}`, dl);
  }
  if ((m = p.match(/^\/stream\/series\/(\d+)\.([a-z0-9]+)$/i))) {
    const dl = q.get('dl') ? { filename: `${sanitize(q.get('name') || 'episodio')}.${m[2]}` } : undefined;
    return proxyStream(req, res, `${BASE}/series/${username}/${password}/${m[1]}.${m[2]}`, dl);
  }

  serveStatic(res, p);
});

loadDLIndex();
server.listen(PORT, () => {
  console.log(`Fluxo rodando em http://0.0.0.0:${PORT}  (provedor: ${host})`);
  buildIndex(); // aquece o índice de busca em segundo plano
  buildEPG();   // aquece o guia (XMLTV) em segundo plano
});
