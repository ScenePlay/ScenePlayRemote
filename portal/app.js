'use strict';

// ── State ───────────────────────────────────────────────────────────────────
let jwt = null;
let myPlayerId = null;    // JWT sub
let myTokenId = null;     // resolved from session_state
let sessionId = null;     // from JWT
let playerName = null;    // from JWT

let tokens = [];          // [{ id, session_id, character_id, label, x_pct, y_pct, token_type }]
let characters = [];      // [{ id, session_id, player_name, sheet_json, hp_current, hp_max }]
let eventSource = null;

// ── Drag state (battlemap) ──────────────────────────────────────────────────
let dragging = null;      // token object being dragged
const TOKEN_RADIUS = 18;

// ── DOM shortcuts ───────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const canvas = $('token-canvas');
const ctx = canvas.getContext('2d');
const mapImg = $('map-img');

// ── Utility ─────────────────────────────────────────────────────────────────
function parseJwt(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64));
  } catch {
    return null;
  }
}

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (jwt) opts.headers['Authorization'] = `Bearer ${jwt}`;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`/api/v1${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res.json();
}

function showTab(name) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  $(`tab-${name}`).classList.remove('hidden');
  document.querySelector(`[data-tab="${name}"]`).classList.add('active');
}

// ── Login ───────────────────────────────────────────────────────────────────
$('join-btn').addEventListener('click', doJoin);
$('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });

async function doJoin() {
  const name = $('player-name').value.trim();
  const code = $('join-code').value.trim().toUpperCase();
  const errEl = $('login-error');
  errEl.textContent = '';

  if (!name) { errEl.textContent = 'Enter your name.'; return; }
  if (!code) { errEl.textContent = 'Enter a join code.'; return; }

  $('join-btn').disabled = true;
  try {
    const data = await api('POST', '/join', { name, code });
    jwt = data.token;
    sessionStorage.setItem('relay_jwt', jwt);

    const claims = parseJwt(jwt);
    myPlayerId = claims.sub;
    sessionId = claims.session_id;
    playerName = claims.player_name;

    $('login-overlay').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('header-player').textContent = playerName;

    connectSSE();
    showTab('battlemap');
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    $('join-btn').disabled = false;
  }
}

// Resume session from sessionStorage on page load
(function resumeSession() {
  const saved = sessionStorage.getItem('relay_jwt');
  if (!saved) return;
  const claims = parseJwt(saved);
  if (!claims || !claims.exp || claims.exp * 1000 < Date.now()) {
    sessionStorage.removeItem('relay_jwt');
    return;
  }
  jwt = saved;
  myPlayerId = claims.sub;
  sessionId = claims.session_id;
  playerName = claims.player_name;

  $('login-overlay').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('header-player').textContent = playerName;
  connectSSE();
  showTab('battlemap');
})();

// ── SSE ─────────────────────────────────────────────────────────────────────
function connectSSE() {
  if (eventSource) eventSource.close();
  const url = `/api/v1/session/${sessionId}/stream?token=${encodeURIComponent(jwt)}`;
  eventSource = new EventSource(url);

  eventSource.addEventListener('message', e => {
    try { handleEvent(JSON.parse(e.data)); } catch { /* malformed */ }
  });

  eventSource.addEventListener('error', () => {
    // Auto-reconnect is handled by the browser for EventSource
  });
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'session_state':
      tokens = ev.data.tokens || [];
      characters = ev.data.characters || [];
      myTokenId = (tokens.find(t => t.character_id === myPlayerId) || {}).id || null;
      renderTokens();
      renderParty();
      populateSheetFromState();
      break;

    case 'scene_update':
      $('header-scene').textContent = ev.data.name || 'ScenePlay Relay';
      break;

    case 'map_update':
      loadMap(ev.data.url);
      break;

    case 'token_move': {
      const t = tokens.find(x => x.id === ev.data.token_id);
      if (t) { t.x_pct = ev.data.x_pct; t.y_pct = ev.data.y_pct; }
      else tokens.push({ id: ev.data.token_id, label: ev.data.label, x_pct: ev.data.x_pct, y_pct: ev.data.y_pct });
      renderTokens();
      break;
    }

    case 'health_update': {
      const c = characters.find(x => x.id === ev.data.character_id);
      if (c) { c.hp_current = ev.data.hp_current; c.hp_max = ev.data.hp_max; }
      renderParty();
      // Sync own HP fields
      if (ev.data.character_id === myPlayerId) {
        $('hp-current').value = ev.data.hp_current ?? '';
        $('hp-max').value = ev.data.hp_max ?? '';
      }
      break;
    }

    case 'roll_result':
      addRollToFeed(ev.data);
      break;

    case 'character_saved':
      break; // nothing to update client-side

    case 'ping':
      break;
  }
}

// ── Battlemap ────────────────────────────────────────────────────────────────
function loadMap(url) {
  $('no-map-msg').style.display = 'none';
  mapImg.src = url;
}

mapImg.addEventListener('load', () => {
  canvas.width = mapImg.naturalWidth;
  canvas.height = mapImg.naturalHeight;
  renderTokens();
});

function renderTokens() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const t of tokens) {
    const x = (t.x_pct / 100) * canvas.width;
    const y = (t.y_pct / 100) * canvas.height;
    const isMe = t.character_id === myPlayerId;
    const isNpc = t.token_type === 'npc' || t.token_type === 'monster';

    // Circle
    ctx.beginPath();
    ctx.arc(x, y, TOKEN_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = isMe ? '#27ae60' : isNpc ? '#c0392b' : '#2980b9';
    ctx.fill();
    ctx.strokeStyle = isMe ? '#2ecc71' : '#ecf0f1';
    ctx.lineWidth = isMe ? 3 : 2;
    ctx.stroke();

    // Label
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 11px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = t.label.length > 6 ? t.label.slice(0, 5) + '…' : t.label;
    ctx.fillText(label, x, y);

    // Name below circle
    ctx.font = '10px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ccc';
    ctx.fillText(t.label, x, y + TOKEN_RADIUS + 3);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

// ── Token drag ───────────────────────────────────────────────────────────────
function canvasXY(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const src = e.touches ? e.touches[0] : e;
  return {
    x: (src.clientX - rect.left) * scaleX,
    y: (src.clientY - rect.top) * scaleY,
  };
}

function tokenAt(cx, cy) {
  // Only own token is draggable
  return tokens.find(t => {
    if (t.character_id !== myPlayerId) return false;
    const tx = (t.x_pct / 100) * canvas.width;
    const ty = (t.y_pct / 100) * canvas.height;
    return Math.hypot(cx - tx, cy - ty) <= TOKEN_RADIUS;
  }) || null;
}

canvas.addEventListener('mousedown', e => {
  const { x, y } = canvasXY(e);
  dragging = tokenAt(x, y);
});

canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  const { x, y } = canvasXY(e);
  dragging = tokenAt(x, y);
}, { passive: false });

function onMove(e) {
  if (!dragging) return;
  e.preventDefault();
  const { x, y } = canvasXY(e);
  dragging.x_pct = Math.min(100, Math.max(0, (x / canvas.width) * 100));
  dragging.y_pct = Math.min(100, Math.max(0, (y / canvas.height) * 100));
  renderTokens();
}

canvas.addEventListener('mousemove', onMove);
canvas.addEventListener('touchmove', onMove, { passive: false });

async function onDragEnd() {
  if (!dragging) return;
  const t = dragging;
  dragging = null;
  try {
    await api('POST', '/token/move', {
      token_id: t.id,
      x_pct: t.x_pct,
      y_pct: t.y_pct,
    });
  } catch (err) {
    console.warn('token move failed:', err.message);
  }
}

canvas.addEventListener('mouseup', onDragEnd);
canvas.addEventListener('touchend', onDragEnd);

// ── Character sheet ──────────────────────────────────────────────────────────
function populateSheetFromState() {
  const me = characters.find(c => c.id === myPlayerId);
  if (!me) return;
  let sheet = {};
  try { sheet = JSON.parse(me.sheet_json); } catch { /* ignore */ }
  const form = $('sheet-form');
  const fields = ['char_name', 'char_class', 'level', 'ac', 'str', 'dex', 'con', 'int', 'wis', 'cha', 'notes'];
  for (const f of fields) {
    const el = form.elements[f];
    if (el && sheet[f] !== undefined) el.value = sheet[f];
  }
  if (me.hp_current !== null && me.hp_current !== undefined) $('hp-current').value = me.hp_current;
  if (me.hp_max !== null && me.hp_max !== undefined) $('hp-max').value = me.hp_max;
}

$('save-sheet-btn').addEventListener('click', saveSheet);

async function saveSheet() {
  const form = $('sheet-form');
  const els = form.elements;
  const sheet = {};
  for (const f of ['char_name', 'char_class', 'level', 'ac', 'str', 'dex', 'con', 'int', 'wis', 'cha', 'notes']) {
    if (els[f]) sheet[f] = els[f].value;
  }
  const hp_current = parseInt($('hp-current').value) || null;
  const hp_max = parseInt($('hp-max').value) || null;

  $('sheet-status').textContent = 'Saving…';
  try {
    await api('POST', '/character', { sheet, hp_current, hp_max });
    $('sheet-status').textContent = 'Saved ✓';
    setTimeout(() => { $('sheet-status').textContent = ''; }, 2000);

    // After first save, token should exist — resolve myTokenId
    if (!myTokenId) {
      const tok = tokens.find(t => t.character_id === myPlayerId);
      if (tok) myTokenId = tok.id;
    }

    // Fire HP health update immediately
    if (myTokenId && hp_current !== null && hp_max !== null) {
      await api('POST', '/token/health', { token_id: myTokenId, hp_current, hp_max });
    }
  } catch (err) {
    $('sheet-status').textContent = `Error: ${err.message}`;
  }
}

// HP fields fire health update on blur
async function onHpBlur() {
  if (!myTokenId) return;
  const hp_current = parseInt($('hp-current').value);
  const hp_max = parseInt($('hp-max').value);
  if (isNaN(hp_current) || isNaN(hp_max)) return;
  try {
    await api('POST', '/token/health', { token_id: myTokenId, hp_current, hp_max });
  } catch { /* ignore */ }
}

$('hp-current').addEventListener('blur', onHpBlur);
$('hp-max').addEventListener('blur', onHpBlur);

// ── Party health ─────────────────────────────────────────────────────────────
function renderParty() {
  const list = $('party-list');
  if (characters.length === 0) {
    list.innerHTML = '<p class="muted">No characters yet.</p>';
    return;
  }
  list.innerHTML = '';
  for (const c of characters) {
    const hp = c.hp_current ?? 0;
    const max = c.hp_max || 1;
    const pct = Math.min(100, Math.max(0, (hp / max) * 100));
    const low = pct <= 25;
    const card = document.createElement('div');
    card.className = 'hp-card';
    card.innerHTML = `
      <div class="hp-card-name">${esc(c.player_name)}</div>
      <div class="hp-bar-track">
        <div class="hp-bar-fill${low ? ' low' : ''}" style="width:${pct}%"></div>
      </div>
      <div class="hp-text">${hp} / ${c.hp_max ?? '?'}</div>
    `;
    list.appendChild(card);
  }
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Dice & roll feed ─────────────────────────────────────────────────────────
document.querySelectorAll('.die-btn').forEach(btn => {
  btn.addEventListener('click', () => rollDie(parseInt(btn.dataset.sides)));
});

async function rollDie(sides) {
  const result = Math.floor(Math.random() * sides) + 1;
  const roll_expr = `d${sides}`;
  const breakdown = String(result);

  $('last-roll').textContent = `${roll_expr}: ${result}`;

  if (!jwt) return;
  try {
    await api('POST', '/roll', { roll_expr, result, breakdown });
  } catch (err) {
    console.warn('roll post failed:', err.message);
  }
}

function addRollToFeed(data) {
  const feed = $('roll-feed');
  const li = document.createElement('li');
  li.innerHTML = `
    <span class="roll-player">${esc(data.player)}</span>
    <span class="roll-detail">${esc(data.roll)} (${esc(data.breakdown)})</span>
    <span class="roll-result">${data.result}</span>
  `;
  feed.prepend(li);
  // Trim to 60 entries in the DOM
  while (feed.children.length > 60) feed.removeChild(feed.lastChild);
}

// ── Tab nav ───────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});
