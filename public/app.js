'use strict';
/* Fluxo — app (v0.1) */

const $ = (s, r = document) => r.querySelector(s);
const api = (p) => fetch(p).then(r => r.json());
const img = (u) => u ? `/img?u=${encodeURIComponent(u)}` : 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E';
const esc = (s) => String(s || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
function initials(name) {
  const w = String(name || '').replace(/\b(FHD|HD|SD|4K|UHD|H265|FHDR|ALT|HEVC)\b/gi, '').replace(/[\[\]()]/g, '').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return 'TV';
  return (w[0][0] + (w[1] ? w[1][0] : '')).toUpperCase();
}

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('fluxo.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('fluxo.' + k, JSON.stringify(v)); } catch {} }
};
let FAV = store.get('fav', []);
let HITS = store.get('hits', {});
let CONT = store.get('cont', {});
let WATCHED = store.get('watched', []);             // histórico de assistidos (recente primeiro)
let DL = {};                                        // key "type:id" -> {status,file,received,total,...}

/* ---------- estado compartilhado no servidor (favoritos/histórico sincronizam entre aparelhos) ---------- */
let pushT;
function pushState() {
  clearTimeout(pushT);
  pushT = setTimeout(() => {
    fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fav: FAV, hits: HITS, cont: CONT, watched: WATCHED }) }).catch(() => {});
  }, 700);
}
async function loadState() {
  // servidor é a fonte da verdade do PERFIL ativo: substitui tudo (perfil novo começa zerado,
  // sem vazar o localStorage de outro perfil). localStorage vira só cache do perfil atual.
  let s = {};
  try { s = await api('/api/state'); } catch {}
  s = (s && typeof s === 'object') ? s : {};
  FAV = Array.isArray(s.fav) ? s.fav : [];
  HITS = (s.hits && typeof s.hits === 'object') ? s.hits : {};
  CONT = (s.cont && typeof s.cont === 'object') ? s.cont : {};
  WATCHED = Array.isArray(s.watched) ? s.watched : [];
  store.set('fav', FAV); store.set('hits', HITS); store.set('cont', CONT); store.set('watched', WATCHED);
}

function recordWatch(type, id, name, icon) {
  const key = type + ':' + id;
  WATCHED = WATCHED.filter(w => w.key !== key);
  WATCHED.unshift({ key, type, id, name, icon, at: Date.now() });
  WATCHED = WATCHED.slice(0, 150);
  store.set('watched', WATCHED); pushState();
}
const INDEX = { live: {}, vod: {}, series: {} };   // id -> item (vai preenchendo conforme navega)

/* ---------- downloads ---------- */
const dlOf = (type, id) => DL[type + ':' + id];
async function refreshDL() { try { const d = await api('/api/downloads'); DL = {}; (d.items || []).forEach(i => DL[i.key] = i); } catch {} }
function srvDownload(type, id, ext, name, icon, auto) {
  return api(`/api/download?type=${type}&id=${id}&ext=${encodeURIComponent(ext || 'mp4')}&name=${encodeURIComponent(name || '')}&icon=${encodeURIComponent(icon || '')}&auto=${auto ? 1 : 0}`)
    .then(r => { if (r.item) DL[r.item.key] = r.item; return r.item; });
}
function deviceDownload(type, id, ext, name) {
  const a = document.createElement('a');
  a.href = `/stream/${type}/${id}.${ext || 'mp4'}?dl=1&name=${encodeURIComponent(name || '')}`;
  a.download = ''; document.body.appendChild(a); a.click(); a.remove();
  toast('Baixando no aparelho…');
}
const pct = (d) => d && d.total ? Math.min(100, Math.round(d.received / d.total * 100)) : 0;

/* ---------- EPG (guia ao vivo) ---------- */
let EPGNOW = {};  // epg_channel_id -> {t,s,e,n}
async function fetchEpgNow() { try { const d = await api('/api/epg/now'); EPGNOW = d.ch || {}; } catch {} }

let TYPE = 'live';
let SEARCHING = false;
let SOURCES = { live: false, vod: false, series: false, torrents: false };
const SRC_LABELS = { live: 'Ao vivo', vod: 'Filmes', series: 'Séries', torrents: 'Torrents' };
function syncSourcesToTab() {
  SOURCES = { live: false, vod: false, series: false, torrents: false };
  if (Object.prototype.hasOwnProperty.call(SOURCES, TYPE)) SOURCES[TYPE] = true;
  renderDots();
}
function renderDots() {
  const bar = $('#srcdots'); if (!bar) return;
  bar.innerHTML = Object.keys(SRC_LABELS).map(s =>
    `<button class="utag ${SOURCES[s] ? 'on' : ''}" data-src="${s}">${SRC_LABELS[s]}</button>`).join('');
  bar.querySelectorAll('.utag').forEach(b => b.onclick = () => {
    SOURCES[b.dataset.src] = !SOURCES[b.dataset.src];
    b.classList.toggle('on', SOURCES[b.dataset.src]);
    const q = $('#q').value.trim();
    if (q.length >= 2) doSearch(q);
  });
}

/* ---------- toast ---------- */
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 2200);
}

/* ---------- tabs ---------- */
function activateTab(b) {
  [...document.querySelectorAll('.tab')].forEach(t => t.classList.toggle('active', t === b));
  TYPE = b.dataset.type; $('#q').value = ''; SEARCHING = false;
  syncSourcesToTab();
  loadTab();
}
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('.tab'); if (!b) return;
  // perfil Kids: "Baixados" pode ter conteúdo adulto baixado → pede PIN (quando há PIN definido)
  if (PROFILE && PROFILE.kid && b.dataset.type === 'local' && typeof CFG !== 'undefined' && CFG.hasPin && !ADMIN_PIN) {
    return askPin('abrir os <b>Baixados</b>', () => activateTab(b));
  }
  activateTab(b);
});

/* ---------- carregar aba ---------- */
let loadSeq = 0;                              // cada troca de aba ganha um número; destaque antigo é descartado
function homeLoading() {
  const d = document.createElement('div'); d.className = 'home-loading';
  d.innerHTML = '<div class="spin"></div><div>Carregando seu catálogo…<br><small>buscando filmes, séries e canais no provedor</small></div>';
  return d;
}
async function loadTab() {
  const seq = ++loadSeq;
  const rows = $('#rows'); rows.innerHTML = '';
  if (TYPE === 'local') { await renderLocal(rows); return; }
  if (TYPE === 'torrents') { renderTorrents(rows); return; }
  if (TYPE === 'live') await fetchEpgNow();   // guia carrega antes dos canais
  // linhas especiais (localStorage)
  renderSpecialRows(rows);
  let loadingEl = null;
  if (!rows.children.length) { loadingEl = homeLoading(); rows.appendChild(loadingEl); }   // tela vazia: avisa que está carregando
  const clearLoading = () => { if (loadingEl) { loadingEl.remove(); loadingEl = null; } };
  let top = [];
  if (TYPE !== 'live') {
    try { const t = await api(`/api/top?type=${TYPE}&limit=24`); top = t.results || []; } catch {}
    if (top.length) {
      clearLoading();
      top.forEach(r => INDEX[TYPE][r.id] = toItem(r));
      rows.appendChild(staticRow('⭐ Mais bem avaliados', top.map(r => makeCard(toItem(r), TYPE))));
    }
  }
  let cats = [];
  try { cats = await api(`/api/categories?type=${TYPE}`); } catch {}
  clearLoading();
  if (!Array.isArray(cats) || !cats.length) {
    if (!rows.children.length) rows.innerHTML = '<div class="empty">Nada por aqui ainda.</div>';
    return;
  }
  // Destaque = um hit reconhecível da categoria Cinema/Lançamentos (varia a cada visita)
  if (TYPE !== 'live') buildHeroFeatured(cats, seq);
  cats.forEach(c => rows.appendChild(lazyRow(c.category_name, c.category_id)));
}

async function buildHeroFeatured(cats, seq) {
  const myType = TYPE;                       // trava: só mostra se continuar nesta aba
  const re = myType === 'series' ? /netflix|apple|hbo|\bmax\b|destaque|premium/i : /cinema|lan[çc]amento|destaque/i;
  const cat = cats.find(c => re.test(c.category_name)) || cats[0];
  if (!cat) return;
  let items = [];
  try { items = await api(`/api/streams?type=${myType}&category_id=${cat.category_id}`); } catch {}
  items = (items || []).filter(x => x.stream_icon || x.cover || (x.backdrop_path && x.backdrop_path[0]));
  const it = items[Math.floor(Math.random() * Math.min(items.length, 15))];
  if (!it) return;
  let bg = it.stream_icon || it.cover || (it.backdrop_path && it.backdrop_path[0]), plot = it.plot || '';
  try {
    if (myType === 'series') { const d = await api(`/api/series?id=${idOf(it)}`); bg = (d.info && d.info.backdrop_path && d.info.backdrop_path[0]) || (d.info && d.info.cover) || bg; plot = (d.info && d.info.plot) || plot; }
    else { const d = await api(`/api/vod?id=${idOf(it)}`); bg = (d.info && d.info.backdrop_path && d.info.backdrop_path[0]) || (d.info && d.info.movie_image) || bg; plot = (d.info && d.info.plot) || plot; }
  } catch {}
  if (seq !== loadSeq || TYPE !== myType || SEARCHING) return;  // troquei de aba / buscando → não injeta
  const rate = (it.rating && parseFloat(it.rating)) ? ` · nota ${parseFloat(it.rating).toFixed(1)}` : '';
  const favType = myType === 'series' ? 'series' : 'vod';
  const hero = document.createElement('div'); hero.className = 'hero-spot';
  hero.innerHTML = `<img src="${img(bg)}" alt=""><div class="veil"></div>
    <div class="hs-body"><div class="tagline">⭐ Destaque${rate}</div>
    <h2>${esc(it.name)}</h2><p>${esc(plot)}</p>
    <div class="hs-actions">
      <button class="btn primary hs-play"><span>▶</span> Assistir</button>
      <button class="btn ghost hs-fav">+ Minha lista</button>
    </div></div>`;
  const open = () => myType === 'series' ? openSeries(it) : openMovie(it);
  hero.onclick = open;
  $('.hs-play', hero).onclick = (e) => { e.stopPropagation(); open(); };
  const favBtn = $('.hs-fav', hero);
  const syncFav = () => { const on = FAV.some(f => f.type === favType && f.id == idOf(it)); favBtn.textContent = on ? '✓ Na lista' : '+ Minha lista'; favBtn.classList.toggle('on', on); };
  favBtn.onclick = (e) => { e.stopPropagation(); toggleFav(it, favType, { classList: { add() {}, remove() {}, toggle() {} } }); syncFav(); };
  syncFav();
  $('#rows').querySelectorAll('.hero-spot').forEach(h => h.remove());  // garante no máximo 1 destaque
  $('#rows').prepend(hero);
}

/* ---------- Mídia Local (vídeos na pasta + baixados; funciona offline) ---------- */
const LOCAL_NOTE = `<div class="pagenote">Aqui aparece tudo que está no servidor: o que você <b>baixou do IPTV</b>, o que veio dos <b>torrents</b>, e o que você <b>jogar na pasta</b> (drive Samba <b>dados/midia</b>). Tudo toca <b>sem internet</b>, direto da sua rede.</div>`;
function dlCard(d) {   // card de download em progresso (ou com erro)
  const card = document.createElement('div'); card.className = 'card poster';
  const err = d.status === 'error', p = err ? 0 : pct(d);
  card.innerHTML = `<div class="thumb noimg"><div class="ph">${esc(initials(d.name))}</div>
    <div class="dl-ov"><div class="dl-bar"><span style="width:${p}%"></span></div><div class="dl-ovs">${err ? 'erro' : p + '%'}</div></div></div>
    <div class="meta"><div class="title">${esc(d.name)}</div><div class="now">${err ? 'falhou — toque pra tentar' : 'baixando…'}${d.total ? ' · ' + (d.total / 1048576).toFixed(0) + ' MB' : ''}</div></div>`;
  if (err) card.onclick = () => srvDownload(d.type === 'series' ? 'series' : 'movie', d.id, d.ext, d.name, d.icon).then(() => startDLPolling());
  return card;
}
function localCard(it, temp) {
  const card = document.createElement('div'); card.className = 'card poster';
  const gb = it.size >= 1073741824 ? (it.size / 1073741824).toFixed(2) + ' GB' : (it.size / 1048576).toFixed(0) + ' MB';
  card.innerHTML = `<div class="thumb noimg"><div class="ph">${esc(initials(it.name))}</div>${temp ? '<span class="tempbadge">TEMP 24h</span>' : ''}</div>
    <div class="meta"><div class="title">${esc(it.name)}</div><div class="now">${gb} · ${esc(it.ext)}</div></div>`;
  card.onclick = () => playLocal(it);
  return card;
}
async function renderLocal(rows) {
  let data = { items: [] };
  try { data = await api('/api/local'); } catch {}
  rows.innerHTML = '';
  const active = Object.values(DL).filter(d => d.status === 'downloading' || d.status === 'error');
  if (active.length) rows.appendChild(staticRow('⬇ Baixando agora', active.map(dlCard)));   // progresso aparece aqui também
  if (data.items && data.items.length) {
    const tempFiles = {}; Object.values(DL).forEach(d => { if (d.auto && d.file) tempFiles[d.file] = 1; });
    rows.appendChild(staticRow(`Baixados · ${data.items.length}`, data.items.map(it => localCard(it, tempFiles[it.file]))));
  } else if (!active.length) {
    rows.innerHTML = `<div class="empty">Nada baixado ainda.<br><small>Baixe filmes/séries (IPTV ou torrents) ou jogue vídeos na pasta — tudo aparece aqui e funciona offline.</small></div>` + LOCAL_NOTE;
    return;
  }
  rows.insertAdjacentHTML('beforeend', LOCAL_NOTE);
}
function playLocal(it) {
  clearTimeout(autoCacheT);
  openPlayer(it.name);
  showBuffer('Carregando arquivo…');          // local: arquivo na rede, não é o provedor
  destroyPlayers(); video.onended = null;
  const c = CONT['local:' + it.file]; const resume = c && c.pos ? c.pos : 0;
  saveCtx = { type: 'local', id: it.file, name: it.name, resumePos: resume };
  recordWatch('local', it.file, it.name, '');
  video.src = `/local?f=${encodeURIComponent(it.file)}`; video.load();
  video.onloadedmetadata = () => { if (resume > 5) video.currentTime = resume; };
  video.play().catch(() => {});
}

/* ---------- Torrents (Jackett busca + transmission baixa pra Mídia Local) ---------- */
const TORR_ST = { 0: 'parado', 1: 'fila', 2: 'checando', 3: 'fila', 4: 'baixando', 5: 'fila', 6: 'concluído' };
let torrPoll = null;
function torrentRow(r) {
  const gb = r.size >= 1073741824 ? (r.size / 1073741824).toFixed(2) + ' GB' : (r.size / 1048576).toFixed(0) + ' MB';
  const row = document.createElement('div'); row.className = 'torr-row';
  row.innerHTML = `<div class="torr-i"><div class="torr-t">${esc(r.title)}</div>
    <div class="torr-m"><span class="seed" title="enviando (seeds)">▲ ${r.seeders || 0}</span><span class="leech" title="baixando (leechers)">▼ ${r.peers || 0}</span><span class="dot">·</span>${gb}<span class="trk">${esc(r.tracker || '')}</span></div></div>
    <button class="btn ghost sm">⬇ Baixar</button>`;
  row.querySelector('button').onclick = () => addTorrent(r.magnet, r.title);
  return row;
}
function renderTorrents(rows) {
  rows.innerHTML = `
    <div id="torr-trackers" class="torr-trackers"></div>
    <div id="torr-active"></div>
    <div id="torr-results"><div class="empty">Use a busca lá em cima (com a tag <b>Torrents</b> marcada) pra procurar e baixar. O que estiver baixando aparece aqui com barra e botão de cancelar, e na aba <b>Baixados</b> quando terminar.</div></div>`;
  loadTrackerStatus();
  refreshTorrents(); startTorrentPoll();
}
async function loadTrackerStatus() {
  const box = $('#torr-trackers'); if (!box) return;
  if (!box.innerHTML) box.innerHTML = '<span class="tk-load">checando trackers…</span>';
  let d = { trackers: [] }; try { d = await api('/api/torrent/trackers'); } catch {}
  if (d.warming) {                                   // servidor ainda esquentando a saúde dos trackers
    box.innerHTML = '<span class="tk-load">checando trackers…</span>';
    if (TYPE === 'torrents') setTimeout(loadTrackerStatus, 3000);
    return;
  }
  if (!d.trackers || !d.trackers.length) { box.innerHTML = ''; return; }
  const bad = d.trackers.filter(t => !t.ok);
  let html = '';
  if (bad.length) html += `<span class="tk-warn" title="${esc(bad.map(b => b.name + ': ' + b.error).join('\n'))}">⚠ ${bad.length} tracker(s) com problema — veja em vermelho</span>`;
  html += d.trackers.map(t => `<span class="tk ${t.ok ? 'ok' : 'bad'}" title="${esc(t.ok ? 'conectado' : ('PROBLEMA: ' + t.error))}">● ${esc(t.name)}</span>`).join('');
  box.innerHTML = html;
}
async function addTorrent(magnet, title) {
  let r = {}; try { r = await api('/api/torrent/add?magnet=' + encodeURIComponent(magnet)); } catch {}
  if (r.ok) toast('⬇ Começou: ' + (title || 'torrent'));
  else toast('Não consegui adicionar (' + (r.result || 'erro') + ')');
  refreshTorrents(); startTorrentPoll();
}
async function refreshTorrents() {
  const box = $('#torr-active'); if (!box) return;
  let d = { torrents: [] }; try { d = await api('/api/torrent/list'); } catch {}
  if (!d.torrents.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<h3 style="font-size:16px;margin:6px 2px 12px">⬇ Baixando agora</h3>';
  d.torrents.forEach(t => {
    const p = Math.round((t.percentDone || 0) * 100);
    const done = p >= 100;
    const eta = (t.eta > 0 && !done) ? ' · faltam ' + (t.eta > 3600 ? Math.round(t.eta / 3600) + 'h' : Math.round(t.eta / 60) + 'min') : '';
    const row = document.createElement('div'); row.className = 'dl-row';
    row.innerHTML = `<div class="dl-i"><div class="dl-t">${esc(t.name)}</div>
      <div class="dl-bar"><span style="width:${p}%"></span></div>
      <div class="dl-s">${p}% · ${done ? 'concluído ✓' : TORR_ST[t.status] || ''} · ${((t.rateDownload || 0) / 1048576).toFixed(1)} MB/s${eta}</div></div>
      <button class="btn ghost sm" data-del>${done ? 'Remover' : '✕ Cancelar'}</button>`;
    row.querySelector('[data-del]').onclick = () => { api(`/api/torrent/delete?id=${t.id}&trash=${done ? 0 : 1}`).then(() => refreshTorrents()); };
    box.appendChild(row);
  });
}
function startTorrentPoll() {
  if (torrPoll) return;
  torrPoll = setInterval(() => { if (TYPE !== 'torrents') { clearInterval(torrPoll); torrPoll = null; return; } refreshTorrents(); }, 3000);
}

function renderSpecialRows(rows) {
  const favs = FAV.filter(f => f.type === TYPE);
  if (favs.length) rows.appendChild(staticRow('❤ Favoritos', favs.map(cardFromFav)));
  if (TYPE !== 'live') {
    const cont = Object.values(CONT).filter(c => c.type === (TYPE === 'vod' ? 'movie' : 'series'))
      .sort((a, b) => b.at - a.at).slice(0, 20);
    if (cont.length) rows.appendChild(staticRow('▶ Continuar assistindo', cont.map(cardFromCont)));
  }
  const hits = Object.values(HITS).filter(h => h.type === TYPE).sort((a, b) => b.n - a.n).slice(0, 20);
  if (hits.length) rows.appendChild(staticRow('🔥 Mais acessados', hits.map(h => makeCard(h.item, h.type))));
}

/* ---------- linhas ---------- */
function rowShell(title, count) {
  const row = document.createElement('section');
  row.className = 'row ' + (TYPE === 'live' ? 'live' : 'vod');
  row.innerHTML = `<div class="row-head"><h3>${esc(title)}</h3>${count != null ? `<span class="count">${count}</span>` : ''}</div>
    <button class="rowarrow left" aria-label="Anterior">‹</button>
    <div class="cards"></div>
    <button class="rowarrow right" aria-label="Próximo">›</button>`;
  const cards = $('.cards', row);
  $('.rowarrow.left', row).onclick = () => {
    if (cards.scrollLeft <= 4) cards.scrollTo({ left: cards.scrollWidth, behavior: 'smooth' });  // volta pro fim
    else cards.scrollBy({ left: -cards.clientWidth * 0.85, behavior: 'smooth' });
  };
  $('.rowarrow.right', row).onclick = () => {
    if (cards.scrollLeft + cards.clientWidth >= cards.scrollWidth - 4) cards.scrollTo({ left: 0, behavior: 'smooth' });  // volta pro começo
    else cards.scrollBy({ left: cards.clientWidth * 0.85, behavior: 'smooth' });
  };
  return row;
}
function staticRow(title, cards) {
  const row = rowShell(title); const box = $('.cards', row);
  cards.forEach(c => c && box.appendChild(c)); return row;
}
function lazyRow(title, catId) {
  const row = rowShell(title); const box = $('.cards', row);
  for (let i = 0; i < 6; i++) { const s = document.createElement('div'); s.className = 'card ' + (TYPE === 'live' ? 'chan' : 'poster'); s.innerHTML = '<div class="thumb skel"></div>'; box.appendChild(s); }
  const io = new IntersectionObserver(async (ents) => {
    if (!ents[0].isIntersecting) return;
    io.disconnect();
    let items = [];
    try { items = await api(`/api/streams?type=${TYPE}&category_id=${catId}`); } catch {}
    box.innerHTML = '';
    if (!Array.isArray(items) || !items.length) { row.remove(); return; }
    $('.row-head .count', row)?.remove();
    row.querySelector('.row-head').insertAdjacentHTML('beforeend', `<span class="count">${items.length}</span>`);
    items.slice(0, 60).forEach(it => { INDEX[TYPE][idOf(it)] = it; box.appendChild(makeCard(it, TYPE)); });
  }, { rootMargin: '300px' });
  io.observe(row);
  return row;
}

/* ---------- cards ---------- */
const idOf = (it) => it.stream_id ?? it.series_id;
function makeCard(it, type) {
  const id = idOf(it);
  const isLive = type === 'live';
  const poster = isLive ? it.stream_icon : (it.stream_icon || it.cover || (it.backdrop_path && it.backdrop_path[0]));
  const card = document.createElement('div');
  card.className = 'card ' + (isLive ? 'chan' : 'poster');
  const rate = (!isLive && it.rating && parseFloat(it.rating)) ? `<span class="rate">★ ${parseFloat(it.rating).toFixed(1)}</span>` : '';
  const faved = FAV.some(f => f.type === type && f.id == id);
  const epg = isLive && it.epg_channel_id ? EPGNOW[it.epg_channel_id] : null;
  let nowLine = '', bar = '';
  if (epg) {
    nowLine = `<div class="now">${esc(epg.t)}</div>`;
    const pr = Math.min(100, Math.max(0, (Date.now() - epg.s) / ((epg.e - epg.s) || 1) * 100));
    bar = `<div class="epgbar"><span style="width:${pr}%"></span></div>`;
  }
  const inner = poster
    ? `<img loading="lazy" decoding="async" src="${img(poster)}" alt="">`
    : `<div class="ph">${esc(initials(it.name))}</div>`;
  card.innerHTML = `<div class="thumb${poster ? '' : ' noimg'}">${inner}${rate}
      <button class="heart ${faved ? 'on' : ''}">${faved ? '♥' : '♡'}</button>${bar}</div>
    <div class="meta"><div class="title">${esc(it.name)}</div>${nowLine}</div>`;
  const im = $('img', card);
  if (im) im.onerror = () => {
    const th = im.parentElement; th.classList.add('noimg'); im.remove();
    const ph = document.createElement('div'); ph.className = 'ph'; ph.textContent = initials(it.name); th.prepend(ph);
  };
  card.onclick = () => { if (isLive) playLive(it); else if (type === 'series') openSeries(it); else openMovie(it); };
  $('.heart', card).onclick = (e) => { e.stopPropagation(); toggleFav(it, type, $('.heart', card)); };
  return card;
}
const cardFromFav = (f) => makeCard(INDEX[f.type][f.id] || { stream_id: f.type !== 'series' ? f.id : undefined, series_id: f.type === 'series' ? f.id : undefined, name: f.name, stream_icon: f.icon, cover: f.icon }, f.type);
const cardFromCont = (c) => {
  const type = c.type === 'series' ? 'series' : 'vod';
  const card = makeCard({ stream_id: c.id, series_id: c.sid, name: c.name, stream_icon: c.icon, cover: c.icon }, type);
  card.onclick = () => c.type === 'movie' ? playVOD(c.id, c.ext, c.name, c.icon, c.pos) : resumeSeriesCont(c);
  return card;
};
// "continuar assistindo" de série: toca o EPISÓDIO salvo direto, retomando a posição (síncrono = funciona no mobile)
function resumeSeriesCont(c) {
  const name = c.name || 'Episódio';
  const ext = c.ext || 'mp4';
  saveCtx = { type: 'series', id: c.id, sid: c.sid, ext, name, icon: c.icon, resumePos: c.pos || 0 };
  recordWatch('series', c.sid || c.id, name, c.icon);
  const d = dlOf('series', c.id);
  const url = (d && d.status === 'done') ? `/local?f=${encodeURIComponent(d.file)}` : `/stream/series/${c.id}.${ext}`;
  playNative(url, name, c.pos || 0);
}

/* ---------- favoritos ---------- */
function toggleFav(it, type, btn) {
  const id = idOf(it);
  const i = FAV.findIndex(f => f.type === type && f.id == id);
  if (i >= 0) { FAV.splice(i, 1); btn.classList.remove('on'); btn.textContent = '♡'; toast('Removido dos favoritos'); }
  else { FAV.push({ type, id, name: it.name, icon: it.stream_icon || it.cover }); btn.classList.add('on'); btn.textContent = '♥'; toast('Adicionado aos favoritos'); }
  store.set('fav', FAV); pushState();
}

/* ---------- hero destaque ---------- */
async function buildHero(cat) {
  let items = [];
  try { items = await api(`/api/streams?type=${TYPE}&category_id=${cat.category_id}`); } catch {}
  const it = (items || []).find(x => (x.backdrop_path && x.backdrop_path[0]) || x.stream_icon || x.cover);
  if (!it) return;
  const bg = (it.backdrop_path && it.backdrop_path[0]) || it.cover || it.stream_icon;
  const hero = document.createElement('div'); hero.className = 'hero-spot';
  hero.innerHTML = `<img src="${img(bg)}" alt=""><div class="veil"></div>
    <div class="hs-body"><div class="tagline">Destaque</div><h2>${esc(it.name)}</h2>
    <p>${esc(it.plot || '')}</p><button class="btn primary"><span>▶</span> Assistir</button></div>`;
  hero.onclick = () => TYPE === 'series' ? openSeries(it) : openMovie(it);
  $('#rows').prepend(hero);
}

/* ---------- detalhe: filme ---------- */
async function openMovie(it) {
  const id = idOf(it);
  openDetail();
  detailLoading(it.name);
  let d = null; try { d = await api(`/api/vod?id=${id}`); } catch {}
  if (!d) { detailError(it.name); return; }
  const info = d.info || {}; const md = d.movie_data || {};
  const ext = md.container_extension || 'mp4';
  const bg = (info.backdrop_path && info.backdrop_path[0]) || info.movie_image || it.stream_icon;
  fillHero(it.name, bg, [
    info.releasedate && info.releasedate.slice(0, 4), info.genre,
    info.duration, info.rating && '★ ' + info.rating
  ], info.plot);
  renderCast(info.cast);
  $('#d-seasons').innerHTML = ''; $('#d-episodes').innerHTML = '';
  setFav(it, 'vod');
  $('#d-play').onclick = () => playVOD(id, ext, it.name, bg);
  wireDownloadButtons('movie', id, ext, it.name, info.movie_image || it.stream_icon, true);
}

/* ---------- detalhe: série ---------- */
async function openSeries(it) {
  const id = idOf(it);
  openDetail();
  detailLoading(it.name);
  let d = null; try { d = await api(`/api/series?id=${id}`); } catch {}
  if (!d) { detailError(it.name); return; }
  const info = d.info || {};
  const bg = (info.backdrop_path && info.backdrop_path[0]) || info.cover || it.cover || it.stream_icon;
  fillHero(it.name || info.name, bg, [
    (info.releaseDate || '').slice(0, 4), info.genre, info.rating && '★ ' + info.rating
  ], info.plot);
  renderCast(info.cast);
  const eps = d.episodes || {};
  const seasons = Object.keys(eps);
  const sbox = $('#d-seasons'); sbox.innerHTML = '';
  const show = (s) => {
    [...sbox.children].forEach(p => p.classList.toggle('active', p.dataset.s === s));
    renderEpisodes(eps[s] || [], it.name || info.name, bg, s);
  };
  seasons.forEach((s, i) => {
    const pill = document.createElement('button'); pill.className = 'season-pill' + (i === 0 ? ' active' : '');
    pill.dataset.s = s; pill.textContent = 'Temporada ' + s; pill.onclick = () => show(s); sbox.appendChild(pill);
  });
  setFav(it, 'series');
  wireDownloadButtons(null, 0, '', '', '', false);  // séries: download é por episódio
  $('#d-play').onclick = () => { const first = (eps[seasons[0]] || [])[0]; if (first) playEpisode(first, eps[seasons[0]], 0, it.name || info.name, bg); };
  if (seasons.length) renderEpisodes(eps[seasons[0]], it.name || info.name, bg, seasons[0]);
}

function renderEpisodes(list, seriesName, bg, season) {
  const box = $('#d-episodes'); box.innerHTML = '';
  (list || []).forEach((ep, i) => {
    const info = ep.info || {};
    const ext = ep.container_extension || 'mp4';
    const d = dlOf('series', ep.id);
    const dlTxt = d ? (d.status === 'done' ? '✓' : (d.status === 'error' ? '↻' : pct(d) + '%')) : '⬇';
    const se = ep.season || season || '1';
    const phLabel = `T${se}<br>E${ep.episode_num}`;   // placeholder quando não tem capa do episódio
    const row = document.createElement('div'); row.className = 'ep';
    row.innerHTML = `<img class="thumb" src="${img(info.movie_image)}" alt="">
      <div class="ep-i"><div class="ep-t">E${ep.episode_num} · ${esc(ep.title)}</div>
      <div class="ep-d">${esc(info.plot || '')}</div></div>
      <div class="ep-actions"><button class="icbtn" data-srv title="Baixar offline">${dlTxt}</button>
      <button class="icbtn" data-dev title="Salvar no aparelho">⇩</button></div>`;
    const thumb = row.querySelector('.thumb');
    const toPh = () => { const p = document.createElement('div'); p.className = 'thumb noimg'; p.innerHTML = `<span class="ph">${phLabel}</span>`; thumb.replaceWith(p); };
    thumb.onerror = toPh;
    if (!info.movie_image) toPh();
    row.onclick = () => playEpisode(ep, list, i, seriesName, bg);
    const srv = row.querySelector('[data-srv]');
    srv.onclick = (e) => { e.stopPropagation(); srvDownload('series', ep.id, ext, `${seriesName} E${ep.episode_num}`, info.movie_image || bg).then(() => { srv.textContent = '…'; toast('Baixando episódio'); startDLPolling(); }); };
    row.querySelector('[data-dev]').onclick = (e) => { e.stopPropagation(); deviceDownload('series', ep.id, ext, `${seriesName} E${ep.episode_num}`); };
    box.appendChild(row);
  });
}

const castInitials = (n) => { const w = n.split(/\s+/).filter(Boolean); return ((w[0] ? w[0][0] : '') + (w[1] ? w[1][0] : '')).toUpperCase() || '?'; };
function renderCast(cast) {
  const box = $('#d-cast'); box.innerHTML = '';
  const names = (cast || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 24);
  if (!names.length) { box.style.display = 'none'; return; }
  box.style.display = '';
  names.forEach(n => {
    const p = document.createElement('div'); p.className = 'castchip';
    p.innerHTML = `<span class="ava">${esc(castInitials(n))}</span><span>${esc(n)}</span>`;
    box.appendChild(p);
  });
}

function fillHero(title, bg, metas, plot) {
  $('#d-title').textContent = title || '';
  $('#d-hero').style.backgroundImage = `url("${img(bg)}")`;
  $('#d-meta').innerHTML = metas.filter(Boolean).map(m => `<span class="chip${String(m).startsWith('★') ? ' star' : ''}">${esc(m)}</span>`).join('');
  $('#d-plot').textContent = plot || '';
}
function setFav(it, type) {
  const btn = $('#d-fav'); const id = idOf(it);
  const upd = () => { const on = FAV.some(f => f.type === type && f.id == id); btn.textContent = on ? '♥ Favorito' : '♡ Favoritar'; btn.classList.toggle('on', on); };
  btn.onclick = () => { toggleFav(it, type, { classList: { add() {}, remove() {} }, }); upd(); };
  upd();
}

/* ---------- modais abrir/fechar ---------- */
function openDetail() { $('#detail').classList.remove('hidden'); }
function detailLoading(name) {
  $('#d-title').textContent = name || 'Carregando…';
  $('#d-plot').textContent = 'Buscando informações no provedor…';
  $('#d-meta').innerHTML = ''; const c = $('#d-cast'); if (c) { c.innerHTML = ''; c.style.display = 'none'; }
  $('#d-seasons').innerHTML = ''; $('#d-episodes').innerHTML = '';
  $('#d-hero').style.backgroundImage = '';
}
function detailError(name) {
  $('#d-title').textContent = name || 'Ops…';
  $('#d-plot').textContent = 'O provedor demorou a responder (pode estar lento ou fora do ar). Feche e tente abrir de novo em instantes.';
  $('#d-meta').innerHTML = ''; $('#d-episodes').innerHTML = '';
}
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => $('#detail').classList.add('hidden'));
$('#detail').onclick = (e) => { if (e.target.id === 'detail') $('#detail').classList.add('hidden'); };

/* ---------- player ---------- */
let mpg = null, hls = null;
let saveCtx = null, saveT = 0, autoCacheT = null, retryN = 0;
const video = $('#video');

// overlay de carregamento com rodinha + texto claro (o usuário SEMPRE sabe o que está acontecendo)
let bufT = null;
const RING_C = 2 * Math.PI * 28;   // circunferência da rodinha (r=28)
function setRing(pct) {
  const ring = $('#buf-ring'); if (!ring) return;
  const fg = $('.ring-fg', ring), pe = $('#buf-pct');
  if (pct == null) { ring.classList.add('spin-ring'); if (pe) pe.textContent = ''; }   // indeterminado (girando)
  else { ring.classList.remove('spin-ring'); const p = Math.max(0, Math.min(100, Math.round(pct))); if (fg) fg.style.strokeDashoffset = (RING_C * (1 - p / 100)).toFixed(1); if (pe) pe.textContent = p + '%'; }
}
function showBuffer(msg) {
  const b = $('#buffering'); b.classList.remove('hidden');
  const m = $('#buffering .buf-msg'); if (m) m.textContent = msg || 'Esperando o provedor…';
  clearTimeout(bufT);
  bufT = setTimeout(() => { const mm = $('#buffering .buf-msg'); if (mm && !b.classList.contains('hidden')) mm.textContent = 'O provedor está lento — segurando a conexão… (ou o conteúdo é pesado/4K)'; }, 8000);
}
function hideBuffer() { $('#buffering').classList.add('hidden'); clearTimeout(bufT); clearInterval(bufMon); bufMon = null; }
// enquanto o overlay está visível, a rodinha mostra % do buffer (ou gira se ainda não tem dados)
let bufMon = null;
function startBufMon() {
  clearInterval(bufMon);
  bufMon = setInterval(() => {
    if ($('#buffering').classList.contains('hidden')) return;
    let ahead = 0; try { if (video.buffered.length) ahead = video.buffered.end(video.buffered.length - 1) - (video.currentTime || 0); } catch {}
    setRing(ahead > 0.4 ? Math.min(99, Math.round(ahead / 4 * 100)) : null);
  }, 350);
}

// reconecta filme/episódio no ponto atual (usado em erro E em travamento prolongado)
let stallT = null, lastProg = 0, stallCount = 0;
function reconnectStream() {
  if (!saveCtx || (saveCtx.type !== 'movie' && saveCtx.type !== 'series')) return;
  if (retryN++ > 6) { hideBuffer(); toast('Não consegui reconectar — o provedor pode estar fora do ar'); return; }
  const t = video.currentTime || saveCtx.resumePos || 0;
  const kind = saveCtx.type === 'movie' ? 'movie' : 'series';
  const d = dlOf(kind, saveCtx.id);
  const url = saveCtx._tc ? `/transcode/${kind}/${saveCtx.id}.${saveCtx.ext}`   // se estava convertendo, reconecta no transcode
    : (d && d.status === 'done') ? `/dl/${encodeURIComponent(d.file)}` : `/stream/${kind}/${saveCtx.id}.${saveCtx.ext}`;
  showBuffer('Reconectando ao provedor…');
  setTimeout(() => { destroyPlayers(); video.src = url; video.load(); video.onloadedmetadata = () => { if (t > 3) video.currentTime = t; }; video.play().catch(() => {}); }, 800);
}

video.addEventListener('waiting', () => {
  showBuffer('Carregando buffer…'); stallCount++;
  clearTimeout(stallT);
  if (saveCtx && (saveCtx.type === 'movie' || saveCtx.type === 'series')) {   // travou e não anda? reconecta
    stallT = setTimeout(() => { if (!video.paused && Date.now() - lastProg > 11000) reconnectStream(); }, 12000);
  }
});
['playing', 'canplay'].forEach(ev => video.addEventListener(ev, () => { hideBuffer(); clearTimeout(stallT); }));
video.addEventListener('pause', () => { if (video.readyState > 2) hideBuffer(); clearTimeout(stallT); });
video.addEventListener('playing', () => { retryN = 0; });
video.addEventListener('timeupdate', () => { lastProg = Date.now(); clearTimeout(stallT); });
video.addEventListener('error', onVideoError);

// cache TEMPORÁRIO (não cai no meio): após 30s assistindo, baixa pro servidor marcado como auto.
// o servidor apaga esses sozinho depois de 24h — só os que o usuário clicar pra baixar ficam permanentes.
function scheduleAutoCache(type, id, ext, name, icon) {
  clearTimeout(autoCacheT);
  const d = dlOf(type, id);
  if (d && (d.status === 'done' || d.status === 'downloading')) return;
  autoCacheT = setTimeout(() => { srvDownload(type, id, ext, name, icon, true).then(() => startDLPolling()); }, 30000);
}

function destroyPlayers() {
  if (mpg) { try { mpg.destroy(); } catch {} mpg = null; }
  if (hls) { try { hls.destroy(); } catch {} hls = null; }
}
function openPlayer(name) { $('#nowplaying').textContent = name || ''; $('#upnext').classList.add('hidden'); const cb = $('#compat'); if (cb) cb.style.display = 'none'; const rg = $('#buf-ring'); if (rg) rg.style.display = ''; $('#player').classList.remove('hidden'); showBuffer('Conectando ao provedor…'); startBufMon(); }
function closePlayer() {
  $('#player').classList.add('hidden');
  try { video.pause(); } catch {}
  destroyPlayers();
  clearTimeout(autoCacheT);
  video.removeAttribute('src'); video.load(); saveCtx = null;
  hideBuffer();
}
document.querySelector('[data-close-player]').onclick = closePlayer;
$('#compat')?.addEventListener('click', () => { if (currentLive) playLive(currentLive, !liveTC); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('#player').classList.contains('hidden')) closePlayer(); else $('#detail').classList.add('hidden'); } });

function bumpHit(item, type) {
  const k = type + ':' + idOf(item);
  HITS[k] = { type, n: (HITS[k]?.n || 0) + 1, item: { stream_id: item.stream_id, series_id: item.series_id, name: item.name, stream_icon: item.stream_icon, cover: item.cover } };
  store.set('hits', HITS); pushState();
}
function saveProgress() {
  if (!saveCtx || !video.duration) return;
  const now = Date.now(); if (now - saveT < 4000) return; saveT = now;
  const pct = video.currentTime / video.duration;
  const key = saveCtx.type + ':' + (saveCtx.id || saveCtx.sid);
  if (pct > 0.02 && pct < 0.95) CONT[key] = Object.assign({}, saveCtx, { pos: video.currentTime, dur: video.duration, at: now });
  else delete CONT[key];
  store.set('cont', CONT); pushState();
}
video.addEventListener('timeupdate', saveProgress);

// aviso FIXO na tela (não some sozinho) — pra quando o conteúdo não existe / não toca
function showError(msg) {
  clearInterval(bufMon); bufMon = null; clearTimeout(bufT);
  const b = $('#buffering'); b.classList.remove('hidden');
  const ring = $('#buf-ring'); if (ring) ring.style.display = 'none';
  const m = $('#buffering .buf-msg'); if (m) m.textContent = msg;
}
// erro de vídeo: verifica se o conteúdo EXISTE; se não, avisa claro; se existe mas não decodifica, converte; rede → reconecta
async function onVideoError() {
  const code = video.error && video.error.code;
  const isVod = saveCtx && (saveCtx.type === 'movie' || saveCtx.type === 'series');
  if ((code === 4 || code === 3) && isVod && !saveCtx._handled) {
    saveCtx._handled = true;
    const kind = saveCtx.type === 'movie' ? 'movie' : 'series';
    showBuffer('Verificando o conteúdo no provedor…');
    let ok = false;
    try { const r = await fetch(`/stream/${kind}/${saveCtx.id}.${saveCtx.ext}`, { headers: { Range: 'bytes=0-1' }, cache: 'no-store' }); ok = r.status >= 200 && r.status < 400; } catch {}
    if (!ok) { showError('🚫 Este conteúdo não está disponível no provedor (o link foi removido). Tente outra versão — as "4K" costumam sumir — ou outro título.'); return; }
    // existe, mas o navegador não decodificou (HEVC/4K) → converte no servidor
    saveCtx._tc = true;
    showBuffer('Formato pesado — convertendo no servidor pra tocar aqui…');
    destroyPlayers(); try { video.pause(); } catch {}
    video.src = `/transcode/${kind}/${saveCtx.id}.${saveCtx.ext}`; video.load(); video.play().catch(() => {});
    return;
  }
  if (code === 4 || code === 3) {   // já tratou (ex.: até o transcode falhou)
    showError('🚫 Não consegui tocar este conteúdo, nem convertendo. Pode estar indisponível no provedor ou ser pesado demais — tente a versão normal (sem 4K) ou baixe.');
    return;
  }
  reconnectStream();                // erro de rede → reconecta e volta de onde parou
}

function playNative(url, name, resume) {
  destroyPlayers();
  openPlayer(name);                 // mostra a rodinha "Conectando ao provedor…" até tocar
  video.src = url; video.load();
  video.onloadedmetadata = () => { if (resume && resume > 5) video.currentTime = resume; };
  video.play().catch(() => {});     // toca na hora (usa o gesto do toque = funciona no Brave/mobile)
}

function playVOD(id, ext, name, icon, resume) {
  const item = INDEX.vod[id] || { stream_id: id, name };
  bumpHit(item, 'vod');
  recordWatch('movie', id, name, icon || item.stream_icon);
  if (resume == null) { const c = CONT['movie:' + id]; if (c && c.pos) resume = c.pos; }
  saveCtx = { type: 'movie', id, ext, name, icon: icon || item.stream_icon, resumePos: resume || 0 };
  const d = dlOf('movie', id);
  const url = (d && d.status === 'done') ? `/local?f=${encodeURIComponent(d.file)}` : `/stream/movie/${id}.${ext}`;
  playNative(url, name, resume);
  video.onended = null;
  scheduleAutoCache('movie', id, ext, name, icon || item.stream_icon);
}

function playEpisode(ep, list, idx, seriesName, bg) {
  const ext = ep.container_extension || 'mp4';
  const name = `${seriesName} · E${ep.episode_num} ${ep.title || ''}`;
  const c = CONT['series:' + ep.id]; const resume = c && c.pos ? c.pos : 0;
  saveCtx = { type: 'series', id: ep.id, sid: ep.series_id, ext, name: seriesName, icon: bg, resumePos: resume };
  recordWatch('series', ep.series_id || ep.id, seriesName, bg);
  const d = dlOf('series', ep.id);
  const url = (d && d.status === 'done') ? `/local?f=${encodeURIComponent(d.file)}` : `/stream/series/${ep.id}.${ext}`;
  playNative(url, name, resume);
  scheduleAutoCache('series', ep.id, ext, `${seriesName} E${ep.episode_num}`, bg);
  const next = list[idx + 1];
  const un = $('#upnext');
  video.onended = () => {
    if (!next) { un.classList.add('hidden'); return; }
    playEpisode(next, list, idx + 1, seriesName, bg);
  };
  video.ontimeupdate = () => {
    saveProgress();
    if (next && video.duration && video.duration - video.currentTime < 25) {
      un.classList.remove('hidden');
      un.innerHTML = `<div class="l">Próximo episódio</div><div class="t">E${next.episode_num} · ${esc(next.title || '')}</div><button>Assistir agora</button>`;
      un.querySelector('button').onclick = () => playEpisode(next, list, idx + 1, seriesName, bg);
    } else un.classList.add('hidden');
  };
}

const canHEVC = () => video.canPlayType('video/mp4; codecs="hvc1"') !== '' || video.canPlayType('video/mp4; codecs="hev1"') !== '';
const isH265 = (it) => /h\.?\s?265|hevc/i.test(it.name || '');
let currentLive = null, liveTC = false;

function playViaMpegts(url, name, targetSec, msg) {
  if (window.mpegts && mpegts.getFeatureList().mseLivePlayback) {
    mpg = mpegts.createPlayer({ type: 'mpegts', isLive: true, url });
    mpg.attachMediaElement(video); mpg.load(); mpg.play().catch(() => {});
  } else playNative(url, name);
}
function updateCompat() {
  const b = $('#compat'); if (!b) return;
  b.style.display = '';
  b.classList.toggle('on', liveTC);
  b.textContent = liveTC ? '⚙ Compatibilidade: ON' : '⚙ Compatibilidade';
}

function playLive(it, force) {
  currentLive = it;
  saveCtx = null; clearTimeout(autoCacheT);   // ao vivo não tem resume nem auto-cache
  liveTC = force === true || (force === undefined && isH265(it) && !canHEVC());
  bumpHit(it, 'live');
  recordWatch('live', it.stream_id, it.name, it.stream_icon);
  openPlayer(it.name);
  updateCompat();
  if (liveTC) toast('Modo compatibilidade (convertendo no servidor)');
  if (it.epg_channel_id) api(`/api/epg?ch=${encodeURIComponent(it.epg_channel_id)}`).then(e => {
    if (e && e.now) {
      let s = `${esc(it.name)} · Agora: ${esc(e.now.t)}`;
      if (e.upcoming && e.upcoming[0]) s += ` · Depois: ${esc(e.upcoming[0].t)}`;
      $('#nowplaying').innerHTML = s;
    }
  });
  destroyPlayers();
  video.onended = null;
  if (liveTC) { playViaMpegts(`/transcode/live/${it.stream_id}`, it.name); return; }
  const hlsUrl = `/hls/live/${it.stream_id}.m3u8`;
  const tsUrl = `/stream/live/${it.stream_id}`;
  if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = hlsUrl; video.load(); video.play().catch(() => {}); return; }
  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({ lowLatencyMode: false, liveSyncDurationCount: 5, liveMaxLatencyDurationCount: 15, maxBufferLength: 40, maxMaxBufferLength: 120, backBufferLength: 30 });
    hls.loadSource(hlsUrl); hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    hls.on(Hls.Events.ERROR, (_e, d) => { if (d && d.fatal) { try { hls.startLoad(); } catch {} } });
    return;
  }
  playViaMpegts(tsUrl, it.name);
}

/* ---------- botões de download no detalhe ---------- */
let _srvRefresh = null;
function wireDownloadButtons(type, id, ext, name, icon, show) {
  const srv = $('#d-dl-srv'), dev = $('#d-dl-dev');
  if (!show) { srv.style.display = 'none'; dev.style.display = 'none'; _srvRefresh = null; return; }
  srv.style.display = ''; dev.style.display = '';
  const refresh = () => { const d = dlOf(type, id); srv.innerHTML = d ? (d.status === 'done' ? '✓ Baixado' : d.status === 'error' ? '↻ Tentar de novo' : `⬇ Baixando ${pct(d)}%`) : '⬇ Baixar offline'; };
  _srvRefresh = refresh; refresh();
  srv.onclick = () => srvDownload(type, id, ext, name, icon).then(() => { toast('Começou a baixar — veja na aba Baixados'); refresh(); startDLPolling(); });
  dev.onclick = () => deviceDownload(type, id, ext, name);
}

/* ---------- painel de downloads ---------- */
let dlPoll = null;
function startDLPolling() {
  if (dlPoll) return;
  dlPoll = setInterval(async () => {
    await refreshDL();
    if (!$('#downloads').classList.contains('hidden')) renderDownloads();
    if (TYPE === 'local' && !SEARCHING) renderLocal($('#rows'));   // aba Baixados atualiza o progresso sozinha
    if (_srvRefresh) _srvRefresh();
    if (!Object.values(DL).some(d => d.status === 'downloading')) { clearInterval(dlPoll); dlPoll = null; }
  }, 2500);
}
const timeago = (ts) => { if (!ts) return ''; const s = (Date.now() - ts) / 1000; if (s < 60) return 'agora'; if (s < 3600) return Math.floor(s / 60) + 'min atrás'; if (s < 86400) return Math.floor(s / 3600) + 'h atrás'; return Math.floor(s / 86400) + 'd atrás'; };
function renderDownloads() {
  const box = $('#dl-list');
  const active = Object.values(DL).filter(d => d.status === 'downloading' || d.status === 'error');
  const hist = {};
  WATCHED.forEach(w => { hist[w.key] = { key: w.key, type: w.type, id: w.id, name: w.name, icon: w.icon, at: w.at, watched: true }; });
  Object.values(DL).filter(d => d.status === 'done').forEach(d => {
    const t = d.type === 'movie' ? 'movie' : 'series', key = t + ':' + d.id;
    const h = hist[key] || { key, type: t, id: d.id, name: d.name, icon: d.icon, at: d.at || 0 };
    h.downloaded = true; h.file = d.file; h.dlkey = d.key; h.at = Math.max(h.at || 0, d.at || 0);
    hist[key] = h;
  });
  const list = Object.values(hist).sort((a, b) => (b.at || 0) - (a.at || 0));
  box.innerHTML = '';
  if (active.length) {
    box.insertAdjacentHTML('beforeend', '<h3 class="hist-h">⬇ Baixando agora</h3>');
    active.forEach(d => {
      const p = d.status === 'error' ? 0 : pct(d);
      const row = document.createElement('div'); row.className = 'dl-row';
      row.innerHTML = `<img class="dl-thumb" src="${img(d.icon)}" alt="">
        <div class="dl-i"><div class="dl-t">${esc(d.name)}</div>
        <div class="dl-bar"><span style="width:${p}%"></span></div>
        <div class="dl-s">${d.status === 'error' ? 'Erro' : p + '%'}${d.total ? ` · ${(d.total / 1048576).toFixed(0)} MB` : ''}</div></div>
        <button class="icbtn" data-del>🗑</button>`;
      row.querySelector('[data-del]').onclick = () => api(`/api/download/delete?key=${encodeURIComponent(d.key)}`).then(() => { delete DL[d.key]; renderDownloads(); });
      box.appendChild(row);
    });
  }
  if (!list.length && !active.length) { box.innerHTML = '<div class="empty">Nada por aqui ainda.<br><small>O que você assistir ou baixar aparece aqui.</small></div>'; return; }
  if (list.length) box.insertAdjacentHTML('beforeend', '<h3 class="hist-h">Histórico</h3>');
  list.forEach(h => {
    const row = document.createElement('div'); row.className = 'dl-row';
    const badges = `${h.downloaded ? '<span class="hb dl">⬇ baixado</span>' : ''}${h.watched ? '<span class="hb w">▶ assistido</span>' : ''}`;
    row.innerHTML = `<img class="dl-thumb" src="${img(h.icon)}" alt="">
      <div class="dl-i"><div class="dl-t">${esc(h.name)}</div><div class="dl-s">${badges} · ${timeago(h.at)}</div></div>
      <div class="dl-actions"><button class="icbtn" data-play>▶</button>${h.downloaded ? '<button class="icbtn" data-del>🗑</button>' : ''}</div>`;
    row.querySelector('[data-play]').onclick = () => { closeDownloads(); playFromHistory(h); };
    const del = row.querySelector('[data-del]');
    if (del) del.onclick = () => api(`/api/download/delete?key=${encodeURIComponent(h.dlkey)}`).then(() => { delete DL[h.dlkey]; refreshDL().then(renderDownloads); });
    box.appendChild(row);
  });
}
function playFromHistory(h) {
  if (h.type === 'movie') { const d = dlOf('movie', h.id); playVOD(h.id, (d && d.ext) || 'mp4', h.name, h.icon); }
  else if (h.type === 'series') { const c = CONT['series:' + h.id]; resumeSeriesCont((c && c.id) ? c : { id: h.id, sid: h.sid, name: h.name, icon: h.icon, ext: 'mp4', pos: 0 }); }
  else if (h.type === 'live') playLive(INDEX.live[h.id] || { stream_id: h.id, name: h.name, stream_icon: h.icon });
  else { saveCtx = null; playNative(`/local?f=${encodeURIComponent(h.id)}`, h.name); }
}
function openDownloads() { refreshDL().then(() => { renderDownloads(); $('#downloads').classList.remove('hidden'); startDLPolling(); }); }
function closeDownloads() { $('#downloads').classList.add('hidden'); }
$('#dlbtn')?.addEventListener('click', openDownloads);
document.querySelectorAll('[data-close-dl]').forEach(b => b.onclick = closeDownloads);
$('#downloads').addEventListener('click', e => { if (e.target.id === 'downloads') closeDownloads(); });

/* ---------- atualizar conteúdo: pré-baixa todas as capas pro cache ---------- */
let warmPoll = null;
async function warmContent() {
  try { await api('/api/cache/warm'); } catch {}
  toast('Atualizando capas…');
  if (warmPoll) return;
  warmPoll = setInterval(async () => {
    let s = {}; try { s = await api('/api/cache/status'); } catch {}
    if (s.running) toast(`Baixando capas… ${s.done}/${s.total}`);
    else { clearInterval(warmPoll); warmPoll = null; toast(`✓ Capas em cache (${s.done || 0})`); }
  }, 1500);
}
$('#warmbtn')?.addEventListener('click', warmContent);

/* ---------- busca global (índice no servidor, todo o catálogo da aba) ---------- */
const toItem = (r) => ({
  stream_id: r.t !== 'series' ? r.id : undefined, series_id: r.t === 'series' ? r.id : undefined,
  name: r.name, stream_icon: r.icon, cover: r.icon, rating: r.rating, container_extension: r.ext, category_id: r.cat
});
let searchT, searchSeq = 0;
$('#q').addEventListener('input', e => {
  clearTimeout(searchT);
  const q = e.target.value.trim();
  searchT = setTimeout(() => doSearch(q), 260);
});
async function doSearch(q) {
  if (q.length < 2) { if (SEARCHING) { SEARCHING = false; loadTab(); } return; }
  SEARCHING = true;
  const seq = ++searchSeq;
  let active = Object.keys(SOURCES).filter(s => SOURCES[s]);
  if (!active.length) active = [Object.prototype.hasOwnProperty.call(SOURCES, TYPE) ? TYPE : 'vod'];
  const rows = $('#rows');
  const labels = { live: '\u{1F4E1} Ao vivo', vod: '\u{1F3AC} Filmes', series: '\u{1F4FA} Séries', torrents: '\u{1F9F2} Torrents' };
  rows.innerHTML = '';
  active.forEach(s => {
    const ph = document.createElement('section'); ph.className = 'row';
    ph.innerHTML = `<div class="row-head"><h3>${active.length > 1 ? labels[s] : 'Resultados'}</h3></div><div class="empty">Buscando…</div>`;
    rows.appendChild(ph);
    fillSection(s, q, ph, labels[s], seq);
  });
}
async function fillSection(source, q, ph, label, seq) {
  if (source === 'torrents') {
    let d = { results: [] }; try { d = await api('/api/torrent/search?q=' + encodeURIComponent(q)); } catch {}
    if (seq !== searchSeq || !ph.isConnected) return;
    ph.replaceWith(torrentSection(label, d.results || []));
  } else {
    let data = { results: [] }; try { data = await api(`/api/search?type=${source}&q=${encodeURIComponent(q)}`); } catch {}
    if (seq !== searchSeq || !ph.isConnected) return;
    const cards = (data.results || []).slice(0, 48).map(r => { INDEX[source][r.id] = toItem(r); return makeCard(toItem(r), source); });
    ph.replaceWith(cardsSection(label, cards, source));
  }
}
function cardsSection(label, cards, srcType) {
  const row = document.createElement('section');
  row.className = 'row search-row ' + (srcType === 'live' ? 'live' : 'vod');
  row.innerHTML = `<div class="row-head"><h3>${label}</h3><span class="count">${cards.length}</span></div>
    <button class="rowarrow left" aria-label="Anterior">‹</button>
    <div class="cards"></div>
    <button class="rowarrow right" aria-label="Próximo">›</button>`;
  const box = $('.cards', row);
  if (!cards.length) box.innerHTML = '<div class="empty">—</div>';
  else cards.forEach(c => box.appendChild(c));
  $('.rowarrow.left', row).onclick = () => { if (box.scrollLeft <= 4) box.scrollTo({ left: box.scrollWidth, behavior: 'smooth' }); else box.scrollBy({ left: -box.clientWidth * 0.85, behavior: 'smooth' }); };
  $('.rowarrow.right', row).onclick = () => { if (box.scrollLeft + box.clientWidth >= box.scrollWidth - 4) box.scrollTo({ left: 0, behavior: 'smooth' }); else box.scrollBy({ left: box.clientWidth * 0.85, behavior: 'smooth' }); };
  return row;
}
const FMAP = { '4K': '4k|2160|uhd', '1080p': '1080', '720p': '720', 'Dublado': 'dubl|dual|nacional', 'Legendado': 'legend' };
const TORR_FILTER = new Set();
function torrentSection(label, results) {
  const sec = document.createElement('section'); sec.className = 'row';
  const chips = Object.keys(FMAP);
  sec.innerHTML = `<div class="row-head"><h3>${label}</h3><span class="count tcount"></span></div>
    <div class="torr-filters">${chips.map(c => `<button class="fchip ${TORR_FILTER.has(c) ? 'on' : ''}" data-f="${c}">${c}</button>`).join('')}
      <span class="fsep"></span><label class="fmin">min seeds <input type="number" min="0" value="0" class="fminv"></label></div>
    <div class="torr-list tlist"></div>`;
  const list = $('.tlist', sec), count = $('.tcount', sec), minv = $('.fminv', sec);
  const render = () => {
    const act = [...TORR_FILTER];
    const minS = parseInt(minv.value || '0', 10) || 0;
    const shown = results.filter(r => (r.seeders || 0) >= minS && (!act.length || act.some(x => new RegExp(FMAP[x], 'i').test(r.title))));
    list.innerHTML = '';
    if (!shown.length) list.innerHTML = '<div class="empty">Nada com esse filtro.</div>';
    else shown.forEach(r => list.appendChild(torrentRow(r)));
    count.textContent = shown.length;
  };
  sec.querySelectorAll('.fchip').forEach(b => b.onclick = () => {
    const f = b.dataset.f; if (TORR_FILTER.has(f)) TORR_FILTER.delete(f); else TORR_FILTER.add(f);
    b.classList.toggle('on'); render();
  });
  minv.oninput = render;
  render();
  return sec;
}

/* ---------- modo leve (performance em TV / máquina fraca) ---------- */
function autoLite() { return !!(navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2); }
function applyLite(on) {
  document.body.classList.toggle('lite', on); store.set('lite', on);
  const b = $('#lite'); if (b) { b.classList.toggle('on', on); b.title = on ? 'Modo leve: ligado' : 'Modo leve: desligado'; }
}
applyLite(store.get('lite', autoLite()));
$('#lite')?.addEventListener('click', () => applyLite(!document.body.classList.contains('lite')));

/* ---------- start ---------- */
/* ===================== perfis + provedores + configurações ===================== */
let CFG = { providers: [], profiles: [], hasPin: false, defaultPv: '' };
let PROFILE = null, PV = '', ADMIN_PIN = '';
const apiPost = (p, body) => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const setCookie = (k, v) => { document.cookie = `${k}=${encodeURIComponent(v)};path=/;max-age=31536000;samesite=lax`; };
const delCookie = (k) => { document.cookie = `${k}=;path=/;max-age=0`; };
const pdot = (p) => `<span class="pdot" style="background:${p.color || '#7c9cff'}"></span>`;

function applyCookies() {
  if (PV) setCookie('fluxo_pv', PV);
  if (PROFILE) { setCookie('fluxo_prof', PROFILE.id); PROFILE.kid ? setCookie('fluxo_kid', '1') : delCookie('fluxo_kid'); }
}
async function bootProfiles() {
  try { CFG = await api('/api/config'); } catch {}
  const profs = CFG.profiles || [];
  let prof = profs.find(p => p.id === store.get('profile', null));
  if (!prof && profs.length <= 1) prof = profs[0];
  if (!prof) { renderProfilePicker(); return false; }     // vários perfis e nenhum escolhido → mostra seletor
  setActiveProfile(prof, false);
  return true;
}
function setActiveProfile(prof, reload) {
  if (!prof) return;
  PROFILE = prof;
  const allowed = (prof.providers && prof.providers.length) ? prof.providers : [CFG.defaultPv];
  let pv = store.get('pv', null);
  if (!allowed.includes(pv)) pv = allowed[0];
  PV = pv; store.set('profile', prof.id); store.set('pv', pv);
  applyCookies(); renderProfileChip(); renderPvSel(); applyProfileUI();
  if (reload) location.reload();
}
// esconde aba Torrents e engrenagem no perfil Kids
function applyProfileUI() {
  const kid = !!(PROFILE && PROFILE.kid);
  document.body.classList.toggle('kid', kid);
  const t = document.querySelector('.tab[data-type="torrents"]'); if (t) t.style.display = kid ? 'none' : '';
  const sb = $('#setbtn'); if (sb) sb.style.display = kid ? 'none' : '';
}
// trocar de perfil: perfil adulto exige PIN (criança não sai do Kids sem o PIN)
function pickProfile(p) {
  if (!p) return;
  if (!p.kid && CFG.hasPin && !ADMIN_PIN) return askPin(`entrar em <b>${esc(p.name)}</b>`, () => setActiveProfile(p, true), renderProfilePicker);
  setActiveProfile(p, true);
}
// prompt de PIN reutilizável (troca de perfil adulto, abrir Baixados, etc.)
function askPin(label, onOk, onCancel) {
  const grid = $('#prof-grid');
  grid.innerHTML = `<div class="prof-pinbox"><div class="prof-pin-h">🔒 PIN para ${label}</div>
    <input id="pp-in" type="password" inputmode="numeric" autocomplete="off" class="set-inp" placeholder="PIN">
    <div class="set-row" style="justify-content:center;margin-top:12px"><button class="btn ghost" id="pp-cancel">Voltar</button><button class="btn primary" id="pp-ok">Entrar</button></div>
    <div id="pp-err" class="set-err" style="text-align:center"></div></div>`;
  $('#profiles').classList.remove('hidden');
  const close = () => $('#profiles').classList.add('hidden');
  const go = async () => { let r = {}; try { r = await apiPost('/api/admin/auth', { pin: $('#pp-in').value }); } catch {} if (r.ok) { ADMIN_PIN = $('#pp-in').value; close(); onOk(); } else $('#pp-err').textContent = 'PIN incorreto.'; };
  $('#pp-ok').onclick = go; $('#pp-in').onkeydown = e => { if (e.key === 'Enter') go(); };
  $('#pp-cancel').onclick = () => { close(); if (onCancel) onCancel(); }; $('#pp-in').focus();
}
function switchProvider(id) {
  if (!PROFILE || !(PROFILE.providers || []).includes(id)) return;
  PV = id; store.set('pv', id); setCookie('fluxo_pv', id); location.reload();
}
function renderProfileChip() {
  const b = $('#profbtn'); if (!b || !PROFILE) return;
  b.textContent = (PROFILE.name || '?').trim()[0].toUpperCase();
  b.style.background = PROFILE.color || 'var(--panel-2)'; b.style.color = '#0b0b12';
  b.title = `Perfil: ${PROFILE.name}${PROFILE.kid ? ' (Kids)' : ''} — trocar`;
}
function renderPvSel() {
  const sel = $('#pvsel'); if (!sel || !PROFILE) return;
  const allowed = (PROFILE.providers || []).map(id => CFG.providers.find(p => p.id === id)).filter(Boolean);
  if (allowed.length <= 1) { sel.style.display = 'none'; return; }
  sel.style.display = ''; sel.innerHTML = allowed.map(p => `<option value="${p.id}">📡 ${esc(p.name)}</option>`).join('');
  sel.value = PV; sel.onchange = () => switchProvider(sel.value);
}
function profAvatar(p) { return `<div class="prof-av" style="--c:${p.color || '#7c9cff'}">${esc((p.name || '?').trim()[0].toUpperCase())}</div>${p.kid ? '<span class="kidtag">KIDS</span>' : ''}`; }
function renderProfilePicker() {
  const grid = $('#prof-grid');
  grid.innerHTML = (CFG.profiles || []).map(p => `<button class="prof-card" data-id="${p.id}">${profAvatar(p)}<span>${esc(p.name)}</span></button>`).join('');
  grid.querySelectorAll('.prof-card').forEach(b => b.onclick = () => pickProfile((CFG.profiles || []).find(p => p.id === b.dataset.id)));
  $('#profiles').classList.remove('hidden');
}

/* ---- Configurações ---- */
async function openSettings() {
  $('#profiles').classList.add('hidden');
  $('#settings').classList.remove('hidden');
  try { CFG = await api('/api/config'); } catch {}
  if (CFG.hasPin && !ADMIN_PIN) return renderPinGate();
  renderSettings();
}
function renderPinGate() {
  $('#set-body').innerHTML = `<h1 class="set-h">🔒 Configurações</h1>
    <p class="set-sub">Digite o PIN para gerenciar provedores e perfis.</p>
    <div class="set-row"><input id="pin-in" type="password" inputmode="numeric" autocomplete="off" placeholder="PIN" class="set-inp"><button id="pin-ok" class="btn primary">Entrar</button></div>
    <div id="pin-err" class="set-err"></div>`;
  const go = async () => { let r = {}; try { r = await apiPost('/api/admin/auth', { pin: $('#pin-in').value }); } catch {} if (r.ok) { ADMIN_PIN = $('#pin-in').value; renderSettings(); } else $('#pin-err').textContent = 'PIN incorreto.'; };
  $('#pin-ok').onclick = go; $('#pin-in').onkeydown = e => { if (e.key === 'Enter') go(); }; $('#pin-in').focus();
}
function renderSettings() {
  const provs = CFG.providers || [], profs = CFG.profiles || [];
  $('#set-body').innerHTML = `
    <h1 class="set-h">⚙ Configurações</h1>
    <section class="set-sec"><div class="set-sec-h">📡 Provedores</div><div id="set-provs"></div><button class="btn ghost" id="add-prov">+ Novo provedor</button></section>
    <section class="set-sec"><div class="set-sec-h">👤 Perfis</div><div id="set-profs"></div><button class="btn ghost" id="add-prof">+ Novo perfil</button></section>
    <section class="set-sec"><div class="set-sec-h">🔒 PIN de acesso</div>
      <p class="set-sub">${CFG.hasPin ? 'Há um PIN definido. Deixe em branco e salve pra remover.' : 'Sem PIN — qualquer um nesta rede abre as Configurações.'}</p>
      <div class="set-row"><input id="newpin" type="password" inputmode="numeric" autocomplete="new-password" placeholder="${CFG.hasPin ? 'Novo PIN' : 'Definir PIN'}" class="set-inp"><button class="btn" id="save-pin">Salvar PIN</button></div></section>`;
  $('#set-provs').innerHTML = provs.map(p => `<div class="set-item"><div><b>${esc(p.name)}</b><span class="set-dim"> · ${esc(p.host)}</span></div><div class="set-item-act"><button class="icbtn" data-ep="${p.id}" title="Editar">✎</button><button class="icbtn" data-dp="${p.id}" title="Remover">🗑</button></div></div>`).join('') || '<div class="set-dim">nenhum</div>';
  $('#set-profs').innerHTML = profs.map(p => `<div class="set-item"><div>${pdot(p)}<b>${esc(p.name)}</b>${p.kid ? '<span class="kidbadge">KIDS</span>' : ''}<span class="set-dim"> · ${(p.providers || []).length} prov.</span></div><div class="set-item-act"><button class="icbtn" data-ef="${p.id}">✎</button><button class="icbtn" data-df="${p.id}">🗑</button></div></div>`).join('');
  $('#add-prov').onclick = () => provForm(null);
  $('#add-prof').onclick = () => profForm(null);
  $('#save-pin').onclick = savePin;
  $('#set-provs').querySelectorAll('[data-ep]').forEach(b => b.onclick = () => provForm(provs.find(x => x.id === b.dataset.ep)));
  $('#set-provs').querySelectorAll('[data-dp]').forEach(b => b.onclick = () => delItem('provider', b.dataset.dp, 'Remover este provedor?'));
  $('#set-profs').querySelectorAll('[data-ef]').forEach(b => b.onclick = () => profForm(profs.find(x => x.id === b.dataset.ef)));
  $('#set-profs').querySelectorAll('[data-df]').forEach(b => b.onclick = () => delItem('profile', b.dataset.df, 'Remover este perfil?'));
}
function provForm(p) {
  const ed = !!p;
  $('#set-body').innerHTML = `<button class="set-back" id="back">← voltar</button><h1 class="set-h">${ed ? 'Editar' : 'Novo'} provedor</h1>
    <label class="set-lbl">Nome<input id="f-name" class="set-inp" value="${ed ? esc(p.name) : ''}" placeholder="ex: Pai20"></label>
    <label class="set-lbl">Host<input id="f-host" class="set-inp" value="${ed ? esc(p.host) : ''}" placeholder="ex: meuprovedor.com"></label>
    <label class="set-lbl">Usuário<input id="f-user" class="set-inp" autocomplete="off" placeholder="${ed ? '(em branco mantém o atual)' : 'usuário do painel'}"></label>
    <label class="set-lbl">Senha<input id="f-pass" class="set-inp" type="password" autocomplete="off" placeholder="${ed ? '(em branco mantém a atual)' : 'senha do painel'}"></label>
    <div class="set-row"><button class="btn" id="f-test">Testar conexão</button><span id="f-testr" class="set-dim"></span></div>
    <div class="set-row"><button class="btn primary" id="f-save">Salvar</button></div><div id="f-err" class="set-err"></div>`;
  $('#back').onclick = renderSettings;
  const payload = () => ({ pin: ADMIN_PIN, provider: { id: ed ? p.id : undefined, name: $('#f-name').value.trim(), host: $('#f-host').value.trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''), username: $('#f-user').value, password: $('#f-pass').value } });
  $('#f-test').onclick = async () => { $('#f-testr').textContent = 'testando…'; let r = {}; try { r = await apiPost('/api/admin/provider/test', payload()); } catch {} $('#f-testr').textContent = r.ok ? `✓ ativo${r.exp ? ' · expira ' + new Date(r.exp * 1000).toLocaleDateString('pt-BR') : ''}` : ('✗ ' + (r.error || 'falhou')); };
  $('#f-save').onclick = async () => { let r = {}; try { r = await apiPost('/api/admin/provider', payload()); } catch {} if (r.ok) { CFG = await api('/api/config'); toast('Provedor salvo'); renderSettings(); } else $('#f-err').textContent = r.error || 'erro ao salvar'; };
}
function profForm(p) {
  const ed = !!p, provs = CFG.providers || [], sel = (p && p.providers) || [];
  const COLORS = ['#7c9cff', '#5ad1a5', '#ff9f6e', '#e06ec1', '#ffd36e', '#8f7cff'];
  let color = (p && p.color) || '#7c9cff';
  $('#set-body').innerHTML = `<button class="set-back" id="back">← voltar</button><h1 class="set-h">${ed ? 'Editar' : 'Novo'} perfil</h1>
    <label class="set-lbl">Nome<input id="p-name" class="set-inp" value="${ed ? esc(p.name) : ''}" placeholder="ex: Davi"></label>
    <label class="set-check"><input type="checkbox" id="p-kid" ${p && p.kid ? 'checked' : ''}> <span>Perfil <b>Kids</b> — esconde conteúdo adulto</span></label>
    <div class="set-lbl">Cor<div class="color-row" id="p-colors">${COLORS.map(c => `<button class="color-dot${color === c ? ' on' : ''}" data-c="${c}" style="background:${c}"></button>`).join('')}</div></div>
    <div class="set-lbl">Provedores deste perfil<div id="p-provs" class="p-provs">${provs.map(pr => `<label class="set-check"><input type="checkbox" value="${pr.id}" ${sel.includes(pr.id) || (!ed && provs[0] && provs[0].id === pr.id) ? 'checked' : ''}> ${esc(pr.name)}</label>`).join('')}</div></div>
    <div class="set-row"><button class="btn primary" id="p-save">Salvar</button></div><div id="p-err" class="set-err"></div>`;
  $('#back').onclick = renderSettings;
  $('#p-colors').querySelectorAll('.color-dot').forEach(b => b.onclick = () => { color = b.dataset.c; $('#p-colors').querySelectorAll('.color-dot').forEach(x => x.classList.toggle('on', x === b)); });
  $('#p-save').onclick = async () => {
    const providers = [...$('#p-provs').querySelectorAll('input:checked')].map(x => x.value);
    const body = { pin: ADMIN_PIN, profile: { id: ed ? p.id : undefined, name: $('#p-name').value.trim(), kid: $('#p-kid').checked, providers, color } };
    let r = {}; try { r = await apiPost('/api/admin/profile', body); } catch {} if (r.ok) { CFG = await api('/api/config'); toast('Perfil salvo'); renderSettings(); } else $('#p-err').textContent = r.error || 'erro ao salvar';
  };
}
async function delItem(kind, id, msg) {
  if (!confirm(msg)) return;
  let r = {}; try { r = await apiPost(`/api/admin/${kind}/delete`, { pin: ADMIN_PIN, id }); } catch {}
  if (r.ok) { CFG = await api('/api/config'); renderSettings(); } else toast(r.error || 'erro');
}
async function savePin() {
  const np = $('#newpin').value; let r = {}; try { r = await apiPost('/api/admin/pin', { pin: ADMIN_PIN, newPin: np }); } catch {}
  if (r.ok) { ADMIN_PIN = np; CFG = await api('/api/config'); toast('PIN salvo'); renderSettings(); } else toast('erro ao salvar PIN');
}
$('#profbtn')?.addEventListener('click', renderProfilePicker);
$('#setbtn')?.addEventListener('click', openSettings);
$('#prof-manage')?.addEventListener('click', openSettings);
$('[data-close-set]')?.addEventListener('click', () => $('#settings').classList.add('hidden'));

/* ===================== "travou ou tá ruim": diagnóstico + resolução ===================== */
function playerDiag() {
  const playing = !$('#player').classList.contains('hidden');
  const src = video.currentSrc || '';
  let mode = 'parado';
  if (playing) {
    if (src.includes('/local') || src.includes('/dl/')) mode = 'arquivo local';
    else if (src.includes('/transcode')) mode = 'transcode H265→H264';
    else if (hls) mode = 'HLS (hls.js)';
    else if (mpg) mode = 'MPEG-TS (mpegts.js)';
    else if (src.includes('/hls/')) mode = 'HLS nativo';
    else mode = 'direto (mp4)';
  }
  let bufAhead = 0; try { if (video.buffered.length) bufAhead = Math.round(video.buffered.end(video.buffered.length - 1) - (video.currentTime || 0)); } catch {}
  const net = navigator.connection || {};
  return {
    playing, mode, liveTC, pv: PV, profile: PROFILE && PROFILE.id,
    providerCount: PROFILE ? (PROFILE.providers || []).length : 1,
    ctx: saveCtx ? { type: saveCtx.type, id: saveCtx.id, name: saveCtx.name, ext: saveCtx.ext } : null,
    videoErr: (video.error && video.error.code) || 0, readyState: video.readyState, networkState: video.networkState,
    paused: video.paused, bufferedAhead: bufAhead, stalls: stallCount, reconnects: retryN,
    lite: document.body.classList.contains('lite'),
    net: { type: net.effectiveType || '?', downlinkMbps: net.downlink || 0, rttMs: net.rtt || 0 },
    ua: navigator.userAgent.slice(0, 120), cores: navigator.hardwareConcurrency || 0, screen: `${screen.width}x${screen.height}`
  };
}
let diagBusy = false;
async function runDiag() {
  if (diagBusy) return; diagBusy = true;
  $('#diag').classList.remove('hidden');
  $('#diag-body').innerHTML = `<h1 class="set-h">🛠 Diagnóstico</h1><p class="set-sub">Analisando o que pode estar travando… (uns segundos)</p><div class="diag-spin"><div class="spin"></div></div>`;
  let d = null; try { d = await apiPost('/api/diag', playerDiag()); } catch {}
  diagBusy = false;
  if (!d) { $('#diag-body').innerHTML = `<h1 class="set-h">🛠 Diagnóstico</h1><p class="set-err">Não consegui falar com o servidor — ele pode ter caído. Tente reiniciar/recarregar.</p><div class="diag-actions"><button class="btn primary" id="dg-rl">🧹 Recarregar</button></div>`; $('#dg-rl').onclick = () => location.href = '/?r=' + Date.now(); return; }
  renderDiag(d);
  const autoFix = (d.actions || []).find(a => a.auto);
  if (autoFix) setTimeout(() => applyFix(autoFix, true), 600);   // aplica a correção leve na hora
}
function renderDiag(d) {
  const s = d.server || {};
  const m = (k, v) => v == null ? '' : `<div class="diag-m"><span>${k}</span><b>${esc(String(v))}</b></div>`;
  $('#diag-body').innerHTML = `<h1 class="set-h">🛠 Diagnóstico</h1>
    <div class="diag-verdict">${esc(d.verdict)}</div>
    <div class="diag-metrics">
      ${m('Provedor — velocidade', s.providerSpeedMBs != null ? s.providerSpeedMBs + ' MB/s' : '—')}
      ${m('Provedor — resposta', s.providerApiMs != null ? s.providerApiMs + ' ms' : '—')}
      ${m('Carga do servidor', s.loadPerCore != null ? s.loadPerCore + ' /núcleo' : '—')}
      ${m('Memória livre', s.memFreePct != null ? s.memFreePct + '%' : '—')}
      ${m('Disco livre', s.diskFreeGB != null ? s.diskFreeGB + ' GB' : '—')}
      ${m('Downloads agora', s.activeDownloads)}
      ${m('Transcodes agora', s.transcodes)}
    </div>
    <div class="diag-sub2">O que fazer:</div><div class="diag-actions" id="diag-actions"></div>`;
  const box = $('#diag-actions');
  (d.actions || []).forEach(a => {
    const btn = document.createElement('button');
    btn.className = 'btn ' + (a.auto ? 'ghost' : 'primary');
    btn.textContent = (a.auto ? '↻ ' : '') + a.label;
    btn.onclick = () => applyFix(a, false);
    box.appendChild(btn);
  });
}
async function applyFix(a, isAuto) {
  const id = a.id || a;
  if (id === 'reconnect') {
    if (saveCtx && (saveCtx.type === 'movie' || saveCtx.type === 'series')) { retryN = 0; reconnectStream(); }
    else if (currentLive) playLive(currentLive, liveTC);
    toast('Reconectando…'); if (!isAuto) $('#diag').classList.add('hidden');
  } else if (id === 'compat') {
    if (currentLive) { playLive(currentLive, true); toast('Compatibilidade ligada'); $('#diag').classList.add('hidden'); }
    else toast('Compatibilidade só vale pra ao vivo');
  } else if (id === 'switchpv') {
    const others = (PROFILE.providers || []).filter(x => x !== PV);
    if (others.length) { toast('Trocando de provedor…'); switchProvider(others[0]); }
    else toast('Esse perfil só tem 1 provedor');
  } else if (id === 'reload') {
    if (!confirm('Recarregar a página agora? Vai interromper o que estiver tocando.')) return;
    location.href = '/?r=' + Date.now();
  } else if (id === 'restart') {
    const go = async () => { toast('Reiniciando o servidor… (~10s)'); try { await apiPost('/api/diag/restart', {}); } catch {} setTimeout(() => location.href = '/?r=' + Date.now(), 8000); };
    // do perfil Kids, reiniciar pede o PIN (criança não derruba o servidor sozinha)
    if (PROFILE && PROFILE.kid && CFG.hasPin && !ADMIN_PIN) { $('#diag').classList.add('hidden'); return askPin('reiniciar o servidor', go); }
    if (!confirm('Reiniciar o servidor Fluxo?\n\nIsso derruba QUEM ESTIVER ASSISTINDO por alguns segundos (inclusive outros aparelhos).')) return;
    go();
  }
}
$('#fixbtn')?.addEventListener('click', runDiag);
$('[data-close-diag]')?.addEventListener('click', () => $('#diag').classList.add('hidden'));

/* ---------- start ---------- */
bootProfiles().then(ok => {
  if (!ok) return;                           // seletor de perfil aberto; segue após escolher (reload)
  refreshDL().then(() => { if (Object.values(DL).some(d => d.status === 'downloading')) startDLPolling(); });
  syncSourcesToTab();
  loadState().then(loadTab);                 // favoritos/histórico do perfil + catálogo do provedor ativo
});
