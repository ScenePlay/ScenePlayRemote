'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let jwt = null, myPlayerId = null, myUsername = null, sessionId = null, playerName = null;
let activeCharId = null;   // which owned character is shown in the Sheet tab
let tokens = [], characters = [], effects = [], eventSource = null;
let CELL_PX = 64, GRID_COLS = 20, GRID_ROWS = 20, dragging = null;
let sheetTab = 'resources';
let diceSides = 20, diceMode = 'normal';
let resourceState = {};   // `${charId}:${name}` → currentVal

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const mod  = score => Math.floor((score - 10) / 2);
const modS = score => { const m = mod(score); return (m >= 0 ? '+' : '') + m; };
const pb   = level => Math.floor((Math.max(1, level) - 1) / 4) + 2;
const initials = name => (name||'?').split(' ').slice(0,2).map(w=>w[0]||'').join('').toUpperCase()||'?';
const hpColor  = pct  => pct > 50 ? '#28a745' : pct > 20 ? '#ffc107' : '#dc3545';
const rand = sides => Math.floor(Math.random() * sides) + 1;

function parseJwt(token) {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
  } catch { return null; }
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (jwt) opts.headers['Authorization'] = `Bearer ${jwt}`;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`/api/v1${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res.json();
}

// ── Character helpers ─────────────────────────────────────────────────────────
// All characters belonging to the logged-in user
function myChars() {
  if (myUsername) return characters.filter(c => c.username === myUsername);
  return characters.filter(c => c.id === myPlayerId);
}
// The currently-selected character for the Sheet tab
function myChar() {
  if (activeCharId) {
    const c = characters.find(c => c.id === activeCharId);
    if (c) return c;
  }
  return characters.find(c => c.id === myPlayerId) || null;
}
function mySheet() {
  const c = myChar();
  if (!c || !c.sheet_json) return null;
  try { return typeof c.sheet_json === 'string' ? JSON.parse(c.sheet_json) : c.sheet_json; }
  catch { return null; }
}
function setActiveChar(id) {
  activeCharId = id;
  renderSheet();
}

// ── Tab nav ───────────────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  $(`tab-${name}`).classList.remove('hidden');
  const btn = document.querySelector(`.tab-btn[data-tab="${name}"]`);
  if (btn) btn.classList.add('active');
}

document.querySelectorAll('.tab-btn').forEach(btn =>
  btn.addEventListener('click', () => showTab(btn.dataset.tab))
);

// ── Login ─────────────────────────────────────────────────────────────────────
$('join-btn').addEventListener('click', doJoin);
['player-name','player-password','join-code'].forEach(id =>
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); })
);
$('join-code').addEventListener('input', e => {
  const el = e.target, pos = el.selectionStart;
  el.value = el.value.toUpperCase();
  el.setSelectionRange(pos, pos);
});

// Restore last login credentials
(function() {
  const n = localStorage.getItem('relay_login_name');
  const c = localStorage.getItem('relay_login_code');
  const p = localStorage.getItem('relay_login_pass');
  if (n) $('player-name').value     = n;
  if (c) $('join-code').value       = c.toUpperCase();
  if (p) $('player-password').value = p;
})();

async function doJoin() {
  const name     = $('player-name').value.trim();
  const password = $('player-password').value;
  const code     = $('join-code').value.trim().toUpperCase();
  const errEl    = $('login-error');
  errEl.textContent = '';
  if (!name)     { errEl.textContent = 'Enter your username.'; return; }
  if (!password) { errEl.textContent = 'Enter your password.'; return; }
  if (!code)     { errEl.textContent = 'Enter a join code.'; return; }
  $('join-btn').disabled = true;
  try {
    const data = await api('POST', '/join', { name, password, code });
    jwt = data.token;
    sessionStorage.setItem('relay_jwt', jwt);
    localStorage.setItem('relay_login_name', name);
    localStorage.setItem('relay_login_code', code);
    localStorage.setItem('relay_login_pass', password);
    const claims = parseJwt(jwt);
    myPlayerId = claims.sub;
    myUsername = claims.username || null;
    sessionId  = claims.session_id;
    playerName = claims.player_name;
    activeCharId = myPlayerId;
    afterLogin();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    $('join-btn').disabled = false;
  }
}

function afterLogin() {
  $('login-overlay').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('header-player').textContent = playerName;
  connectSSE();
  showTab('map');
}

// Resume session from sessionStorage
(function() {
  const saved = sessionStorage.getItem('relay_jwt');
  if (!saved) return;
  const claims = parseJwt(saved);
  if (!claims || !claims.exp || claims.exp * 1000 < Date.now()) {
    sessionStorage.removeItem('relay_jwt');
    return;
  }
  jwt = saved; myPlayerId = claims.sub; myUsername = claims.username || null;
  sessionId = claims.session_id; playerName = claims.player_name;
  activeCharId = activeCharId || myPlayerId;
  afterLogin();
})();

// ── SSE ───────────────────────────────────────────────────────────────────────
function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/v1/session/${sessionId}/stream?token=${encodeURIComponent(jwt)}`);
  eventSource.addEventListener('message', e => {
    try { handleEvent(JSON.parse(e.data)); } catch { /* malformed */ }
  });
}

// ── Heartbeat (keeps GM presence display accurate) ────────────────────────────
setInterval(() => {
  if (jwt) api('POST', '/heartbeat', {}).catch(() => {});
}, 30000);

// ── Event handler ─────────────────────────────────────────────────────────────
function handleEvent(ev) {
  switch (ev.type) {
    case 'session_state': {
      characters = ev.data.characters || [];
      initResourceState();
      if (ev.data.map_json) {
        const parsed = tokensFromMapJson(ev.data.map_json);
        if (parsed) {
          loadMap(parsed.url, parsed.grid_cols, parsed.grid_rows);
          // map_json is always canonical (has all tokens + image_url).
          // token_positions records only have moved tokens and no image_url,
          // so we only use them to overlay updated positions.
          tokens = parsed.tokens;
          effects = parsed.effects || [];
          if (ev.data.tokens && ev.data.tokens.length > 0) {
            const posById = {};
            for (const t of ev.data.tokens) posById[String(t.id)] = t;
            for (const t of tokens) {
              const pos = posById[String(t.id)];
              if (pos) { t.x_pct = pos.x_pct; t.y_pct = pos.y_pct; }
            }
          }
        }
      } else if (ev.data.tokens && ev.data.tokens.length > 0) {
        tokens = ev.data.tokens;
      }
      if (ev.data.rolls) ev.data.rolls.forEach(addRollToFeed);
      renderTokens(); renderEffects(); renderParty(); renderSheet();
      break;
    }
    case 'scene_update':
      $('header-scene').textContent = ev.data.name || 'ScenePlay Relay';
      break;
    case 'map_update': {
      const parsed = tokensFromMapJson(ev.data.map_json);
      if (parsed) {
        loadMap(parsed.url, parsed.grid_cols, parsed.grid_rows);
        // Preserve any in-memory position overrides (player drags)
        const prevPos = {};
        for (const t of tokens) prevPos[t.id] = { x_pct: t.x_pct, y_pct: t.y_pct };
        tokens = parsed.tokens;
        effects = parsed.effects || [];
        for (const t of tokens) { const p = prevPos[t.id]; if (p) { t.x_pct = p.x_pct; t.y_pct = p.y_pct; } }
        renderTokens(); renderEffects();
      }
      break;
    }
    case 'character_hp_update': {
      const c = characters.find(x => x.id === ev.data.character_id);
      if (c) {
        c.hp_current = ev.data.hp_current; c.hp_max = ev.data.hp_max;
        for (const tok of tokens) {
          if (findCharForToken(tok)?.id === c.id) {
            const el = $('tok-' + tok.id);
            if (el) updateTokenHp(el, c);
          }
        }
      }
      renderParty();
      if (ev.data.character_id === myPlayerId) renderSheet();
      break;
    }
    case 'token_move': {
      const t = tokens.find(x => x.id === ev.data.token_id);
      if (t) { t.x_pct = ev.data.x_pct; t.y_pct = ev.data.y_pct; }
      else tokens.push({ id: ev.data.token_id, label: ev.data.label||'', x_pct: ev.data.x_pct, y_pct: ev.data.y_pct, token_type: ev.data.token_type||'player', character_id: ev.data.character_id, image_url: '' });
      renderTokens();
      break;
    }
    case 'health_update': {
      const tok = tokens.find(x => x.id === ev.data.token_id);
      if (tok) {
        const c = findCharForToken(tok);
        if (c) {
          c.hp_current = ev.data.hp_current; c.hp_max = ev.data.hp_max;
          const el = $('tok-'+tok.id); if (el) updateTokenHp(el, c);
        } else {
          tok.hp_current = ev.data.hp_current; tok.hp_max = ev.data.hp_max;
          const el = $('tok-'+tok.id); if (el) updateTokenHp(el, tok);
        }
      }
      renderParty();
      break;
    }
    case 'condition_update': {
      const d = ev.data;
      const _condChip = c => {
        const s = document.createElement('span');
        s.textContent = c;
        s.style.cssText = 'background:rgba(200,170,110,.12);color:var(--accent);border:1px solid var(--accent);border-radius:4px;padding:1px 6px;font-size:.68rem;';
        return s;
      };
      const _patchTooltipConds = conds => {
        if (_tt.style.display !== 'none') {
          const condEl = $('tt-conditions');
          condEl.innerHTML = '';
          conds.forEach(c => condEl.appendChild(_condChip(c)));
        }
      };
      if (d.token_id) {
        const tok = tokens.find(x => x.id === d.token_id);
        if (tok) {
          tok.conditions = d.conditions;
          if (_ttToken?.id === d.token_id) _patchTooltipConds(d.conditions);
        }
      } else if (d.player_name) {
        const char = characters.find(x => x.player_name === d.player_name);
        if (char) {
          try {
            const sheet = typeof char.sheet_json === 'string' ? JSON.parse(char.sheet_json) : char.sheet_json;
            if (sheet) { sheet.conditions = d.conditions; char.sheet_json = JSON.stringify(sheet); }
          } catch {}
          if (_ttToken && findCharForToken(_ttToken)?.id === char.id) _patchTooltipConds(d.conditions);
        }
      }
      break;
    }
    case 'player_joined': {
      const d = ev.data;
      const idx = characters.findIndex(c => c.id === d.character_id);
      if (idx >= 0) {
        const prev = characters[idx].portrait_url;
        characters[idx] = { ...characters[idx], ...d };
        if (!characters[idx].portrait_url && prev) characters[idx].portrait_url = prev;
      } else {
        characters.push({ id: d.character_id, player_name: d.player_name, username: d.username, display_name: d.display_name, portrait_url: d.portrait_url||'', hp_current: d.hp_current, hp_max: d.hp_max });
      }
      if (d.character_id === myPlayerId) renderSheet();
      renderParty(); renderTokens();
      break;
    }
    case 'character_removed': {
      const name = ev.data.player_name;
      characters = characters.filter(c => c.player_name !== name);
      tokens     = tokens.filter(t => !(t.label === name && t.token_type === 'player'));
      renderParty(); renderTokens();
      if (name === playerName) doLogout();
      break;
    }
    case 'roll_result':
      addRollToFeed(ev.data);
      break;
    case 'ping': break;
  }
}

// ── Battlemap ─────────────────────────────────────────────────────────────────
function tokensFromMapJson(mapJson) {
  try {
    const m = typeof mapJson === 'string' ? JSON.parse(mapJson) : mapJson;
    if (!m || !m.tokens) return null;
    return {
      url: m.url || '', grid_cols: m.grid_cols || 20, grid_rows: m.grid_rows || 20,
      tokens: m.tokens.map(t => ({
        id: String(t.token_id), label: t.label||'', x_pct: t.x_pct, y_pct: t.y_pct,
        token_type: t.token_type||'player', character_id: t.character_id != null ? String(t.character_id) : null,
        image_url: t.image_url||'',
        hp_current: t.hp_current ?? null, hp_max: t.hp_max ?? null,
        speed: t.speed ?? null, conditions: t.conditions || [],
        type: t.type || '', ac: t.ac ?? null,
      })),
      effects: m.effects || [],
    };
  } catch { return null; }
}

function loadMap(url, gridCols, gridRows) {
  if (!url) return;
  $('no-map-msg').style.display = 'none';
  GRID_COLS = gridCols || GRID_COLS; GRID_ROWS = gridRows || GRID_ROWS;
  const grid = $('map-grid'), lines = $('map-lines');
  grid.style.width  = (GRID_COLS * CELL_PX) + 'px';
  grid.style.height = (GRID_ROWS * CELL_PX) + 'px';
  lines.style.backgroundSize = `${CELL_PX}px ${CELL_PX}px`;
  $('map-bg').src = url;
  // Resize both effect SVGs to match grid
  ['effects-layer', 'fog-layer'].forEach(id => {
    const svg = $(id);
    if (svg) { svg.setAttribute('width', GRID_COLS * CELL_PX); svg.setAttribute('height', GRID_ROWS * CELL_PX); }
  });
}

function pctToColRow(x, y) {
  return { col: GRID_COLS > 1 ? Math.round(x*(GRID_COLS-1)) : 0, row: GRID_ROWS > 1 ? Math.round(y*(GRID_ROWS-1)) : 0 };
}
function colRowToPct(col, row) {
  return { x_pct: GRID_COLS > 1 ? col/(GRID_COLS-1) : 0, y_pct: GRID_ROWS > 1 ? row/(GRID_ROWS-1) : 0 };
}
function findCharForToken(t) {
  if (t.token_type === 'monster' || t.token_type === 'npc') return null;
  return characters.find(c => c.id === t.character_id) || characters.find(c => c.player_name === t.label) || null;
}
function updateTokenHp(el, charOrTok) {
  if (!charOrTok || charOrTok.hp_current == null || !charOrTok.hp_max) return;
  let fill = el.querySelector('.token-hp-fill');
  if (!fill) {
    // Bar was never created (hp data absent at token creation time) — inject it now
    const bar = document.createElement('div');
    bar.className = 'token-hp-bar';
    bar.innerHTML = '<div class="token-hp-fill"></div>';
    const nameEl = el.querySelector('.token-name');
    nameEl ? el.insertBefore(bar, nameEl) : el.appendChild(bar);
    fill = bar.querySelector('.token-hp-fill');
  }
  const pct = Math.max(0, Math.min(100, Math.round(100 * (charOrTok.hp_current??0) / (charOrTok.hp_max||1))));
  fill.style.width = pct + '%'; fill.style.background = hpColor(pct);
}
function isMyToken(t) {
  if (t.token_type !== 'player') return false;
  // Match against ALL characters belonging to this user
  const mine = myChars();
  if (mine.some(c => t.label === c.player_name)) return true;
  // Fallback: JWT player_name
  if (t.label === playerName) return true;
  return false;
}

function createTokenEl(t, char, col, row) {
  const isMe  = isMyToken(t);
  const isNpc = t.token_type === 'monster' || t.token_type === 'npc';
  const sz = CELL_PX - 6;
  const border = isMe ? '#2ecc71' : isNpc ? '#cc3333' : '#4a9eff';
  const bg     = isMe ? '#0d2820' : isNpc ? '#2d0a0a' : '#0d2845';
  const el = document.createElement('div');
  el.className = 'map-token' + (isMe ? ' token-mine' : '');
  el.id = 'tok-'+t.id; el.dataset.tokenId = t.id;
  el.style.cssText = `transform:translate(${col*CELL_PX}px,${row*CELL_PX}px);width:${CELL_PX}px;`;
  const portraitUrl = char?.portrait_url || t.image_url || '';
  const pInner = portraitUrl
    ? `<img src="${esc(portraitUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
       <span style="display:none;width:100%;height:100%;align-items:center;justify-content:center;">${initials(t.label)}</span>`
    : `<span>${initials(t.label)}</span>`;
  const hp  = char?.hp_current ?? t.hp_current ?? null;
  const max = char?.hp_max     ?? t.hp_max     ?? null;
  const pct = (hp != null && max) ? Math.max(0, Math.min(100, Math.round(100*hp/max))) : null;
  const hpBar = pct != null ? `<div class="token-hp-bar"><div class="token-hp-fill" style="width:${pct}%;background:${hpColor(pct)};"></div></div>` : '';
  const youArrow = isMe ? '<div class="token-you-arrow">YOU</div>' : '';
  el.innerHTML = `${youArrow}<div class="token-portrait" style="width:${sz}px;height:${sz}px;border-color:${border};background:${bg};">${pInner}</div>${hpBar}<div class="token-name">${esc(t.label)}</div>`;
  el.addEventListener('mouseenter', e => { if (!dragging) showTokenTooltip(e, t, findCharForToken(t)); });
  el.addEventListener('mousemove',  e => { if (!dragging) _positionTooltip(e); });
  el.addEventListener('mouseleave', hideTooltip);
  attachTokenDrag(el, t, isMe);
  return el;
}
function renderTokens() {
  const grid = $('map-grid'); if (!grid) return;
  const seen = new Set();
  for (const t of tokens) {
    seen.add(t.id);
    const char = findCharForToken(t);
    const { col, row } = pctToColRow(t.x_pct, t.y_pct);
    let el = $('tok-'+t.id);
    if (!el) { el = createTokenEl(t, char, col, row); grid.appendChild(el); }
    else {
      if (!dragging || dragging.id !== t.id) { el.style.transform = `translate(${col*CELL_PX}px,${row*CELL_PX}px)`; el.style.width = CELL_PX+'px'; }
      updateTokenHp(el, char || t);
    }
  }
  grid.querySelectorAll('.map-token').forEach(el => { if (!seen.has(el.dataset.tokenId)) el.remove(); });
}
// ── Token tooltip ─────────────────────────────────────────────────────────────
const _tt = $('tok-tooltip');
let _ttToken = null;

function _positionTooltip(e) {
  const w = _tt.offsetWidth || 200, h = _tt.offsetHeight || 160;
  const x = e.clientX + 16, y = e.clientY + 16;
  _tt.style.left = (x + w > window.innerWidth  ? e.clientX - w - 10 : x) + 'px';
  _tt.style.top  = (y + h > window.innerHeight ? e.clientY - h - 10 : y) + 'px';
}

function showTokenTooltip(e, t, char) {
  _ttToken = t;
  const isMonster = t.token_type === 'monster' || t.token_type === 'npc';
  const typeColor = isMonster ? '#cc3333' : '#4a9eff';
  _tt.style.borderColor = typeColor;
  _tt.style.background  = `color-mix(in srgb, ${typeColor} 10%, var(--surface))`;

  const portrait = $('tt-portrait');
  const imgSrc = char?.portrait_url || t.image_url || '';
  if (portrait) {
    if (imgSrc) {
      portrait.src = imgSrc;
      portrait.style.borderColor = typeColor;
      portrait.style.display = 'block';
    } else {
      portrait.style.display = 'none';
    }
  }

  $('tt-name').style.color = typeColor;
  $('tt-name').textContent = t.label;

  // Sub-line: class/level for players; monster type (e.g. "Undead") for monsters
  const sheet = (() => { try { return char && (typeof char.sheet_json === 'string' ? JSON.parse(char.sheet_json) : char.sheet_json); } catch { return null; } })();
  const sub = isMonster
    ? (t.type || '')
    : `${sheet?.class || ''}${sheet?.level ? ' ' + sheet.level : ''}`.trim();
  $('tt-sub').textContent = sub;

  // HP — players use character record; monsters use token fields
  const hp  = isMonster ? t.hp_current : (char?.hp_current ?? null);
  const max = isMonster ? t.hp_max     : (char?.hp_max     ?? null);
  const hpRow  = $('tt-hp-row');
  const hpWrap = $('tt-hp-bar-wrap');
  if (hp != null && max) {
    const pct = Math.max(0, Math.min(100, Math.round(100 * hp / max)));
    $('tt-hp').textContent     = `HP ${hp} / ${max}`;
    $('tt-hp-pct').textContent = pct + '%';
    $('tt-hp-bar').style.width      = pct + '%';
    $('tt-hp-bar').style.background = hpColor(pct);
    hpRow.style.display  = 'flex';
    hpWrap.style.display = '';
  } else {
    hpRow.style.display  = 'none';
    hpWrap.style.display = 'none';
  }

  // Stats row: AC · Speed — monsters read token fields; players read sheet
  const ac    = isMonster ? t.ac    : sheet?.ac;
  const speed = isMonster ? t.speed : sheet?.speed;
  const stats = [];
  if (ac)    stats.push(`AC ${ac}`);
  if (speed) stats.push(`Speed ${speed} ft`);
  $('tt-stats').textContent = stats.join('  ·  ');

  // Conditions — monsters from token; players from sheet
  const condEl = $('tt-conditions');
  condEl.innerHTML = '';
  const conds = isMonster ? (t.conditions || []) : (sheet?.conditions || []);
  conds.forEach(c => {
    const s = document.createElement('span');
    s.textContent = c;
    s.style.cssText = 'background:rgba(200,170,110,.12);color:var(--accent);border:1px solid var(--accent);border-radius:4px;padding:1px 6px;font-size:.68rem;';
    condEl.appendChild(s);
  });

  // Skills — players only (monsters have no skill list on the relay)
  const skillEl = $('tt-skills');
  skillEl.innerHTML = '';
  (sheet?.skills || []).forEach(s => {
    const sp = document.createElement('span');
    const sign = s.bonus >= 0 ? '+' : '';
    sp.innerHTML = `${s.proficient ? '<span style="color:var(--accent);">&#9733;</span>' : ''}${esc(s.name)} <strong style="color:var(--text);">${sign}${s.bonus}</strong>&ensp;`;
    skillEl.appendChild(sp);
  });

  _positionTooltip(e);
  _tt.style.display = 'block';
}

function hideTooltip() { _ttToken = null; if (_tt) _tt.style.display = 'none'; }

// ── Effects (SVG) ─────────────────────────────────────────────────────────────
const CONE_HALF_RAD = 26.57 * Math.PI / 180;

function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function applyEffectGeometry(g, eff) {
  while (g.firstChild) g.removeChild(g.firstChild);
  const px  = eff.anchor_x * CELL_PX;
  const py  = eff.anchor_y * CELL_PX;
  const θ   = (eff.angle || 0) * Math.PI / 180;
  const dim = (eff.size_ft / 5) * CELL_PX;
  let shape, lx = px, ly = py;

  if (eff.shape === 'circle') {
    shape = svgEl('circle', { cx: px, cy: py, r: dim });
  } else if (eff.shape === 'square') {
    shape = svgEl('rect', { x: px - dim, y: py - dim, width: dim * 2, height: dim * 2 });
  } else if (eff.shape === 'cone') {
    const x1 = px + dim * Math.cos(θ - CONE_HALF_RAD);
    const y1 = py + dim * Math.sin(θ - CONE_HALF_RAD);
    const x2 = px + dim * Math.cos(θ + CONE_HALF_RAD);
    const y2 = py + dim * Math.sin(θ + CONE_HALF_RAD);
    shape = svgEl('path', { d: `M ${px.toFixed(1)} ${py.toFixed(1)} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${dim.toFixed(1)} ${dim.toFixed(1)} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z` });
    lx = px + dim * 0.55 * Math.cos(θ);
    ly = py + dim * 0.55 * Math.sin(θ);
  } else if (eff.shape === 'line') {
    const hw = CELL_PX * 0.5;
    const nx = -Math.sin(θ), ny = Math.cos(θ);
    const ex = dim * Math.cos(θ), ey = dim * Math.sin(θ);
    const pts = [
      `${(px + nx*hw).toFixed(1)},${(py + ny*hw).toFixed(1)}`,
      `${(px + ex + nx*hw).toFixed(1)},${(py + ey + ny*hw).toFixed(1)}`,
      `${(px + ex - nx*hw).toFixed(1)},${(py + ey - ny*hw).toFixed(1)}`,
      `${(px - nx*hw).toFixed(1)},${(py - ny*hw).toFixed(1)}`,
    ].join(' ');
    shape = svgEl('polygon', { points: pts });
    lx = px + (dim / 2) * Math.cos(θ);
    ly = py + (dim / 2) * Math.sin(θ);
  } else if (eff.shape === 'cloud') {
    const wCells = eff.size_ft / 5;
    const hCells = eff.angle > 0 ? eff.angle : wCells;
    shape = svgEl('rect', { x: px, y: py, width: wCells * CELL_PX, height: hCells * CELL_PX });
    g.style.pointerEvents = 'all';
  }

  if (!shape) return;
  shape.setAttribute('fill',         eff.fill_color);
  shape.setAttribute('fill-opacity', eff.fill_opacity);
  if (eff.shape !== 'cloud') {
    shape.setAttribute('stroke',       eff.border_color);
    shape.setAttribute('stroke-width', '2');
  } else {
    shape.setAttribute('stroke',       '#c0c0c0');
    shape.setAttribute('stroke-width', '1.5');
  }
  g.appendChild(shape);

  if (eff.label && eff.shape !== 'cloud') {
    const txt = svgEl('text', {
      x: lx.toFixed(1), y: ly.toFixed(1),
      'text-anchor': 'middle', 'dominant-baseline': 'middle',
      fill: 'white', 'font-size': '11', 'font-weight': 'bold',
      stroke: 'black', 'stroke-width': '2.5', 'paint-order': 'stroke',
      'pointer-events': 'none',
    });
    txt.textContent = eff.label;
    g.appendChild(txt);
  }
}

function renderEffects() {
  const fxSvg  = $('effects-layer');
  const fogSvg = $('fog-layer');
  if (!fxSvg || !fogSvg) return;
  const seen = new Set();
  for (const eff of effects) {
    const key  = String(eff.effect_id);
    const svg  = eff.shape === 'cloud' ? fogSvg : fxSvg;
    const other = eff.shape === 'cloud' ? fxSvg : fogSvg;
    seen.add(key);
    // Remove from wrong layer if it was previously placed there
    other.querySelector(`#efx-${key}`)?.remove();
    let g = svg.querySelector(`#efx-${key}`);
    if (!g) { g = svgEl('g'); g.id = `efx-${key}`; svg.appendChild(g); }
    applyEffectGeometry(g, eff);
  }
  [fxSvg, fogSvg].forEach(svg =>
    svg.querySelectorAll('g').forEach(g => { if (!seen.has(g.id.replace('efx-', ''))) g.remove(); })
  );
}

function attachTokenDrag(el, tok, canMove) {
  if (!canMove) { el.style.cursor = 'default'; }

  let ds = null, _lastDown = 0, _ctrlOnDown = false, _startCol, _startRow;
  let _lpTimer = null, _downPos = null, _hasMoved = false;

  el.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.pointerType !== 'touch') return;
    e.preventDefault(); e.stopPropagation();
    el.setPointerCapture(e.pointerId);

    const now = Date.now();
    // Double-click (mouse) or double-tap (touch) opens character sheet
    _ctrlOnDown = e.ctrlKey || (now - _lastDown < 300);
    _lastDown = now;
    const pos = pctToColRow(tok.x_pct, tok.y_pct);
    _startCol = pos.col; _startRow = pos.row;
    _hasMoved = false;
    _downPos  = { clientX: e.clientX, clientY: e.clientY };

    if (canMove) {
      ds = pos; dragging = { id: tok.id };
      hideTooltip();
      el.style.transition = 'none'; el.style.zIndex = '100'; el.style.opacity = '.85';
    }

    // Touch: show tooltip after 500ms hold without movement
    if (e.pointerType === 'touch') {
      clearTimeout(_lpTimer);
      _lpTimer = setTimeout(() => {
        if (!_hasMoved) {
          const ttPos = { clientX: _downPos.clientX, clientY: _downPos.clientY - 120 };
          showTokenTooltip(ttPos, tok, findCharForToken(tok));
          setTimeout(hideTooltip, 3000);
        }
      }, 500);
    }
  });

  el.addEventListener('pointermove', e => {
    // Track movement to cancel long-press and enforce drag threshold on touch
    if (e.pointerType === 'touch' && _downPos && !_hasMoved) {
      const dx = e.clientX - _downPos.clientX;
      const dy = e.clientY - _downPos.clientY;
      if (Math.sqrt(dx * dx + dy * dy) > 8) {
        _hasMoved = true;
        clearTimeout(_lpTimer);
        _lpTimer = null;
        hideTooltip();
      }
    }

    if (!canMove || !ds) return;
    if (e.pointerType === 'touch' && !_hasMoved) return; // wait for movement threshold

    const rect = $('map-grid').getBoundingClientRect();
    const col = Math.max(0, Math.min(GRID_COLS-1, Math.floor((e.clientX-rect.left)/CELL_PX)));
    const row = Math.max(0, Math.min(GRID_ROWS-1, Math.floor((e.clientY-rect.top )/CELL_PX)));
    if (col !== ds.col || row !== ds.row) { ds.col = col; ds.row = row; el.style.transform = `translate(${col*CELL_PX}px,${row*CELL_PX}px)`; }
  });

  function endDrag() {
    clearTimeout(_lpTimer);
    _lpTimer = null;
    let col = _startCol, row = _startRow;
    if (canMove && ds) {
      col = ds.col; row = ds.row;
      ds = null; dragging = null;
      el.style.transition = ''; el.style.zIndex = '10'; el.style.opacity = '';
    }

    // Ctrl+click or double-click without moving: open character sheet
    if (_ctrlOnDown && col === _startCol && row === _startRow) {
      if (isMyToken(tok)) {
        const char = findCharForToken(tok);
        setActiveChar(char ? char.id : myPlayerId);
        showTab('sheet');
      }
      return;
    }

    if (!canMove) return;

    const { x_pct, y_pct } = colRowToPct(col, row); tok.x_pct = x_pct; tok.y_pct = y_pct;
    api('POST', '/token/move', { token_id: tok.id, x_pct, y_pct, label: tok.label, token_type: tok.token_type || 'player' }).catch(() => {});
  }

  el.addEventListener('pointerup', endDrag); el.addEventListener('pointercancel', endDrag);
}
function setCellPx(val) {
  CELL_PX = Math.max(32, Math.min(128, val));
  const grid = $('map-grid'), lines = $('map-lines');
  if (grid) { grid.style.width = (GRID_COLS*CELL_PX)+'px'; grid.style.height = (GRID_ROWS*CELL_PX)+'px'; }
  if (lines) lines.style.backgroundSize = `${CELL_PX}px ${CELL_PX}px`;
  ['effects-layer', 'fog-layer'].forEach(id => {
    const svg = $(id);
    if (svg) { svg.setAttribute('width', GRID_COLS * CELL_PX); svg.setAttribute('height', GRID_ROWS * CELL_PX); }
  });
  for (const t of tokens) {
    const el = $('tok-'+t.id); if (!el || (dragging && dragging.id === t.id)) continue;
    const { col, row } = pctToColRow(t.x_pct, t.y_pct);
    el.style.transform = `translate(${col*CELL_PX}px,${row*CELL_PX}px)`; el.style.width = CELL_PX+'px';
    const p = el.querySelector('.token-portrait'); if (p) { const sz = CELL_PX-6; p.style.width = sz+'px'; p.style.height = sz+'px'; }
  }
  renderEffects();
  const lbl = $('cell-px-label'); if (lbl) lbl.textContent = CELL_PX+'px';
}
function adjustCellPx(delta) { setCellPx(CELL_PX + delta); }

// Viewport pan + pinch-to-zoom
(function() {
  const vp = $('map-viewport'); if (!vp) return;
  const activePointers = new Map(); // pointerId → {x, y}
  let pan = null, pinch = null; // pan: single-finger; pinch: two-finger zoom

  vp.addEventListener('pointerdown', e => {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size >= 2) {
      // Switch to pinch-to-zoom
      pan = null; vp.style.cursor = '';
      const pts = [...activePointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinch = { dist, cellPx: CELL_PX };
      vp.setPointerCapture(e.pointerId);
      return;
    }

    if (e.button !== 0 && e.pointerType !== 'touch') return;
    if (e.target !== vp && e.target !== $('map-grid') && e.target !== $('map-lines') && e.target !== $('map-bg')) return;
    pan = { sx: e.clientX, sy: e.clientY, sl: vp.scrollLeft, st: vp.scrollTop };
    vp.style.cursor = 'grabbing'; vp.setPointerCapture(e.pointerId);
  });

  vp.addEventListener('pointermove', e => {
    if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pinch && activePointers.size >= 2) {
      const pts = [...activePointers.values()];
      const newDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (newDist > 0) setCellPx(Math.round(pinch.cellPx * newDist / pinch.dist));
      return;
    }

    if (!pan) return;
    vp.scrollLeft = pan.sl-(e.clientX-pan.sx); vp.scrollTop = pan.st-(e.clientY-pan.sy);
  });

  function end(e) {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinch = null;
    if (activePointers.size === 0) { pan = null; vp.style.cursor = ''; }
  }
  vp.addEventListener('pointerup', end); vp.addEventListener('pointercancel', end);
})();

// ── Character sheet ───────────────────────────────────────────────────────────
function initResourceState() {
  for (const c of characters) {
    let s; try { s = c.sheet_json ? (typeof c.sheet_json==='string'?JSON.parse(c.sheet_json):c.sheet_json) : null; } catch { s = null; }
    if (!s || !s.resources) continue;
    for (const r of s.resources) {
      const key = `${c.id}:${r.name}`;
      if (!(key in resourceState)) resourceState[key] = r.current;
    }
  }
}

function renderSheet() {
  const el = $('sheet-content');
  // Character picker — shown when the user owns more than one character
  const owned = myChars();
  let pickerHtml = '';
  if (owned.length > 1) {
    const cur = myChar();
    pickerHtml = `<div class="char-picker">` +
      owned.map(c => {
        const active = cur && c.id === cur.id ? ' active' : '';
        return `<button class="char-pick-btn${active}" onclick="setActiveChar('${esc(c.id)}')">${esc(c.player_name)}</button>`;
      }).join('') +
      `</div>`;
  }
  const char = myChar(); const sheet = mySheet();
  if (!char || !sheet) {
    el.innerHTML = pickerHtml + '<p class="muted-text" style="padding:20px;text-align:center;">No character data. Ask your GM to sync the party.</p>';
    return;
  }
  const hp = char.hp_current ?? 0, hpMax = char.hp_max || 1;
  const hpPct = Math.max(0, Math.min(100, Math.round(100*hp/hpMax)));
  const equippedW = (sheet.weapons||[]).filter(w=>w.equipped);
  const equippedA = (sheet.armor||[]).filter(a=>a.equipped);
  const wChips = equippedW.map(w =>
    `<span class="chip chip-weapon">&#9876; ${esc(w.name)}${w.damage_dice?`<span class="chip-detail"> ${esc(w.damage_dice)}${w.damage_bonus?'+'+w.damage_bonus:''} ${esc(w.damage_type)}</span>`:''}</span>`
  ).join('');
  const aChips = equippedA.map(a =>
    `<span class="chip chip-armor">${a.is_shield?'&#9694;':'&#9651;'} ${esc(a.name)}<span class="chip-detail"> ${a.is_shield?'+':''}${(a.ac_base||0)+(a.ac_bonus||0)} AC</span></span>`
  ).join('');
  const cChips = (sheet.conditions||[]).map(c => `<span class="chip chip-condition">&#9763; ${esc(c)}</span>`).join('');
  const portrait = char.portrait_url
    ? `<img src="${esc(char.portrait_url)}" class="sheet-portrait" alt="" onerror="this.style.display='none';document.getElementById('sheet-ph').style.display='flex';">
       <div id="sheet-ph" class="sheet-portrait-placeholder" style="display:none;">${initials(sheet.name||char.player_name)}</div>`
    : `<div class="sheet-portrait-placeholder">${initials(sheet.name||char.player_name)}</div>`;
  const attrs = ['str','dex','con','int','wis','cha'].map(s => {
    const score = sheet[s] ?? 10, m = mod(score);
    return `<div class="attr-box"><div class="attr-label">${s.toUpperCase()}</div><div class="attr-score">${score}</div><div class="attr-mod">${m>=0?'+':''}${m}</div></div>`;
  }).join('');
  const subTabs = [['resources','Resources'],['skills','Skills'],['inventory','Inventory'],['weapons','Weapons'],['armor','Armor'],['currency','Currency'],['feats','Feats'],['spells','Spells'],['conditions','Conditions']];
  el.innerHTML = pickerHtml + `
    <div class="card">
      <div class="char-header">
        <div class="char-portrait-wrap">${portrait}</div>
        <div class="char-info">
          <div class="char-name">${esc(sheet.name||char.player_name)}</div>
          <div class="char-sub">Lv${sheet.level||1} ${esc(sheet.class||'')}${sheet.race?' &bull; '+esc(sheet.race):''}${sheet.background?' &bull; '+esc(sheet.background):''}</div>
          <div class="hp-section">
            <div class="hp-labels"><span>HP <strong id="hp-disp">${hp}</strong> / ${hpMax}</span><span class="muted-text">${hpPct}%</span></div>
            <div class="hp-bar-wrap"><div class="hp-bar-fill" id="hp-bar" style="width:${hpPct}%;background:${hpColor(hpPct)};"></div></div>
            <div class="hp-controls">
              <button class="btn btn-danger btn-sm" onclick="applyHpDelta(-hpAmount())">&#9660; Dmg</button>
              <input type="number" id="hp-amount" value="1" min="1" class="input-sm text-center" style="width:58px;">
              <button class="btn btn-success btn-sm" onclick="applyHpDelta(+hpAmount())">&#9650; Heal</button>
            </div>
          </div>
          <div class="quick-stats">
            <span>AC <strong>${sheet.ac??'?'}</strong></span>
            <span>Speed <strong>${sheet.speed??30}</strong>ft</span>
            <span>Init <strong>${(sheet.initiative_bonus??0)>=0?'+':''}${sheet.initiative_bonus??0}</strong></span>
            <span>Pass.Perc <strong>${sheet.passive_perception??'?'}</strong></span>
          </div>
        </div>
      </div>
      ${wChips||aChips?`<div class="chip-row">${wChips}${aChips}</div>`:''}
      ${cChips?`<div class="chip-row">${cChips}</div>`:''}
    </div>
    <div class="card"><div class="attr-grid">${attrs}</div></div>
    <div class="card sheet-tabs-card">
      <div class="sheet-tab-bar">${subTabs.map(([id,label])=>`<button class="sheet-tab-btn${id===sheetTab?' active':''}" onclick="showSheetTab('${id}')">${label}</button>`).join('')}</div>
      <div id="sheet-tab-content" class="sheet-tab-content">${renderSheetTabContent(sheet, char)}</div>
    </div>`;
  updateDiceStatButtons(sheet);
}

function showSheetTab(name) {
  sheetTab = name;
  document.querySelectorAll('.sheet-tab-btn').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`.sheet-tab-btn[onclick*="'${name}'"]`);
  if (btn) btn.classList.add('active');
  const el = $('sheet-tab-content');
  if (el) el.innerHTML = renderSheetTabContent(mySheet(), myChar());
}

function renderSheetTabContent(sheet, char) {
  if (!sheet || !char) return '';
  switch (sheetTab) {
    case 'resources':  return renderResources(sheet, char);
    case 'skills':     return renderSkills(sheet);
    case 'inventory':  return renderInventory(sheet);
    case 'weapons':    return renderWeaponsTab(sheet);
    case 'armor':      return renderArmorTab(sheet);
    case 'currency':   return renderCurrency(sheet);
    case 'feats':      return renderFeats(sheet);
    case 'spells':     return renderSpells(sheet);
    case 'conditions': return renderConditions(sheet);
    default: return '';
  }
}

function renderResources(sheet, char) {
  const res = sheet.resources || [];
  if (!res.length) return '<p class="muted-text" style="padding:6px 0;">No resources.</p>';
  return res.map(r => {
    const key = `${char.id}:${r.name}`, cur = resourceState[key] ?? r.current, max = r.max || 1;
    const pips = Array.from({length: Math.min(max, 20)}, (_,i) =>
      `<div class="res-pip${i<cur?' filled':''}" onclick="setResPip('${esc(key)}',${i},${max})"></div>`
    ).join('');
    return `<div class="resource-row">
      <span class="resource-name">${esc(r.name)}</span>
      <button class="btn-icon" onclick="deltaRes('${esc(key)}',-1,${max})">&#8722;</button>
      <span class="resource-val" id="rv-${char.id.slice(-6)}-${r.name.replace(/\W/g,'_')}">${cur}</span>
      <button class="btn-icon" onclick="deltaRes('${esc(key)}',1,${max})">+</button>
      <span class="muted-text">/ ${max}</span>
      <div class="res-pips">${pips}</div>
    </div>`;
  }).join('');
}

function deltaRes(key, delta, max) {
  resourceState[key] = Math.max(0, Math.min(max, (resourceState[key]??0) + delta));
  const el = $('sheet-tab-content'); if (el && sheetTab==='resources') el.innerHTML = renderResources(mySheet(), myChar());
}
function setResPip(key, idx, max) {
  const cur = resourceState[key] ?? 0;
  resourceState[key] = cur === idx + 1 ? idx : idx + 1;
  const el = $('sheet-tab-content'); if (el && sheetTab==='resources') el.innerHTML = renderResources(mySheet(), myChar());
}

function renderSkills(sheet) {
  const skills = sheet.skills || [];
  if (!skills.length) return '<p class="muted-text" style="padding:6px 0;">No skills.</p>';
  return skills.map(s =>
    `<div class="list-row"><span class="prof-star">${s.proficient?'&#9733;':'&#9734;'}</span><span class="list-name">${esc(s.name)}</span><span class="list-value">${s.bonus>=0?'+':''}${s.bonus}</span></div>`
  ).join('');
}

function renderInventory(sheet) {
  const inv = sheet.inventory || [];
  if (!inv.length) return '<p class="muted-text" style="padding:6px 0;">No items.</p>';
  return inv.map(i =>
    `<div class="list-row">${i.equipped?'<span style="color:var(--accent);font-size:.7rem;">[E]</span>':''}<span class="list-name">${esc(i.name)}</span><span class="list-muted">x${i.qty}</span></div>`
  ).join('');
}

function renderWeaponsTab(sheet) {
  const weapons = sheet.weapons || [];
  if (!weapons.length) return '<p class="muted-text" style="padding:6px 0;">No weapons.</p>';
  return weapons.map(w =>
    `<div class="list-row">
      <span style="color:var(--accent);font-size:.7rem;">${w.equipped?'&#9741;':'&#9675;'}</span>
      <span class="list-name">${esc(w.name)}</span>
      <span class="list-muted">${w.damage_dice?esc(w.damage_dice)+(w.damage_bonus?'+'+w.damage_bonus:'')+(w.damage_type?' '+esc(w.damage_type):''):''}</span>
      ${w.attack_bonus?`<span class="list-value">+${w.attack_bonus}</span>`:''}
    </div>`
  ).join('');
}

function renderArmorTab(sheet) {
  const armor = sheet.armor || [];
  if (!armor.length) return '<p class="muted-text" style="padding:6px 0;">No armor.</p>';
  return armor.map(a =>
    `<div class="list-row">
      <span style="color:var(--accent);font-size:.7rem;">${a.equipped?'&#9741;':'&#9675;'}</span>
      <span class="list-name">${esc(a.name)}</span>
      <span class="list-muted">${esc(a.category||'')}</span>
      <span class="list-value">${a.is_shield?'+':''}${(a.ac_base||0)+(a.ac_bonus||0)} AC</span>
    </div>`
  ).join('');
}

function renderCurrency(sheet) {
  return `<div class="currency-grid">
    <div class="currency-item"><div class="currency-label">Gold</div><div class="currency-val">${sheet.gold??0}</div></div>
    <div class="currency-item"><div class="currency-label">Silver</div><div class="currency-val">${sheet.silver??0}</div></div>
    <div class="currency-item"><div class="currency-label">Copper</div><div class="currency-val">${sheet.copper??0}</div></div>
  </div>`;
}

function renderFeats(sheet) {
  const feats = sheet.feats || [];
  if (!feats.length) return '<p class="muted-text" style="padding:6px 0;">No feats.</p>';
  return feats.map(f =>
    `<div style="padding:6px 0;border-bottom:1px solid rgba(48,54,61,.6);">
      <div style="color:var(--accent);font-weight:600;font-size:.85rem;">${esc(f.name)}</div>
      ${f.description?`<div style="color:var(--muted);font-size:.75rem;margin-top:2px;white-space:pre-wrap;">${esc(f.description)}</div>`:''}
    </div>`
  ).join('');
}

function renderSpells(sheet) {
  const spells = sheet.spells || [];
  if (!spells.length) return '<p class="muted-text" style="padding:6px 0;">No spells.</p>';
  const byLevel = {};
  for (const s of spells) { const l = s.level||0; (byLevel[l]||(byLevel[l]=[])).push(s); }
  const lvlLabel = l => l===0?'Cantrips':l===1?'1st Level':l===2?'2nd Level':l===3?'3rd Level':l+'th Level';
  return Object.keys(byLevel).sort((a,b)=>a-b).map(l =>
    `<div class="spell-level-header">${lvlLabel(Number(l))}</div>` +
    byLevel[l].map(s =>
      `<div class="spell-row">
        <span class="${s.prepared?'spell-prepared':'spell-unprepared'}">${s.prepared?'&#9670;':'&#9671;'}</span>
        <span class="spell-name">${esc(s.name)}</span>
        ${s.school?`<span class="spell-school">${esc(s.school)}</span>`:''}
      </div>`
    ).join('')
  ).join('');
}

function renderConditions(sheet) {
  const conds = sheet.conditions || [];
  if (!conds.length) return '<p class="muted-text" style="padding:6px 0;">No conditions.</p>';
  return `<div style="padding:6px 0;">${conds.map(c=>`<span class="cond-chip">&#9763; ${esc(c)}</span>`).join('')}</div>`;
}

// HP controls
function hpAmount() { return Math.max(1, parseInt($('hp-amount').value)||1); }

async function applyHpDelta(delta) {
  const c = myChar();
  const charId = c?.id || activeCharId;
  try {
    const data = await api('POST', '/character/hp-delta', { delta, character_id: charId });
    if (c) { c.hp_current = data.hp_current; c.hp_max = data.hp_max; }
    renderSheet(); renderParty();
  } catch (err) {
    console.warn('hp-delta failed:', err.message);
  }
}

// ── Party ─────────────────────────────────────────────────────────────────────
function renderParty() {
  const list = $('party-list');
  if (!characters.length) { list.innerHTML = '<p class="muted-text" style="padding:8px;">No characters yet.</p>'; return; }
  const mine = new Set(myChars().map(c => c.id));
  list.innerHTML = characters.map(c => {
    const isMe = mine.has(c.id);
    const hp = c.hp_current ?? 0, max = c.hp_max || 1;
    const pct = Math.min(100, Math.max(0, (hp / max) * 100));
    const avatar = c.portrait_url
      ? `<div class="hp-avatar" style="background-image:url('${esc(c.portrait_url)}')"></div>`
      : `<div class="hp-avatar-placeholder">${initials(c.player_name||'?')}</div>`;
    const sub = c.display_name && c.display_name !== c.player_name ? `<div class="hp-card-sub">${esc(c.display_name)}</div>` : '';
    const youBadge = isMe ? '<span class="you-badge">You</span>' : '';
    return `<div class="hp-card${isMe ? ' mine' : ''}">
      <div class="hp-card-header">
        ${avatar}
        <div class="hp-card-info">
          <div class="hp-card-name">${esc(c.player_name||'Unknown')}${youBadge}</div>${sub}
          <div class="hp-bar-track"><div class="hp-bar-fill" style="width:${pct}%;background:${hpColor(pct)};"></div></div>
          <div class="hp-text">${hp} / ${c.hp_max??'?'}</div>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ── Dice ──────────────────────────────────────────────────────────────────────
function selectDie(sides) {
  diceSides = sides;
  document.querySelectorAll('.die-btn').forEach(b => b.classList.toggle('active', +b.dataset.sides === sides));
  const advRow = $('adv-row');
  if (sides === 20) advRow.classList.add('visible'); else { advRow.classList.remove('visible'); setAdvMode('normal'); }
}

function setAdvMode(mode) {
  diceMode = mode;
  const idMap = { normal: 'adv-normal', advantage: 'adv-adv', disadvantage: 'adv-dis' };
  Object.entries(idMap).forEach(([m, id]) =>
    document.getElementById(id)?.classList.toggle('active', m === mode)
  );
}

function updateDiceStatButtons(sheet) {
  fdUpdateStatButtons();
  const el = $('stat-mod-btns'); if (!el || !sheet) return;
  const level = sheet.level || 1, profB = pb(level);
  const stats = [
    ['STR', mod(sheet.str??10)], ['DEX', mod(sheet.dex??10)], ['CON', mod(sheet.con??10)],
    ['INT', mod(sheet.int??10)], ['WIS', mod(sheet.wis??10)], ['CHA', mod(sheet.cha??10)],
    ['PROF', profB],
  ];
  el.innerHTML = stats.map(([label, val]) =>
    `<button class="stat-mod-btn" onclick="setDiceMod(${val})" title="${label}: ${val>=0?'+':''}${val}">${label}<br><span style="color:var(--accent);">${val>=0?'+':''}${val}</span></button>`
  ).join('');
}

function setDiceMod(val) { $('dice-modifier').value = val; }

function resetDice() {
  $('dice-count').value = 1; $('dice-modifier').value = 0; $('dice-label').value = '';
  selectDie(20); setAdvMode('normal');
  $('dice-result').classList.add('hidden');
}

function clearDiceFeed() {
  const feed = $('roll-feed'); if (feed) feed.innerHTML = '';
}

function doRoll() {
  const count    = Math.max(1, Math.min(20, parseInt($('dice-count').value)||1));
  const sides    = diceSides;
  const modifier = parseInt($('dice-modifier').value)||0;
  const label    = $('dice-label').value.trim();

  let rolls, keptRolls, droppedRolls;
  if (sides === 20 && diceMode !== 'normal') {
    const r1 = rand(20), r2 = rand(20);
    if (diceMode === 'advantage') { keptRolls=[Math.max(r1,r2)]; droppedRolls=[Math.min(r1,r2)]; }
    else                          { keptRolls=[Math.min(r1,r2)]; droppedRolls=[Math.max(r1,r2)]; }
    rolls = diceMode === 'advantage' ? [Math.max(r1,r2), Math.min(r1,r2)] : [Math.min(r1,r2), Math.max(r1,r2)];
  } else {
    rolls = Array.from({length: count}, () => rand(sides));
    keptRolls = [...rolls]; droppedRolls = [];
  }

  const total = keptRolls.reduce((a,b)=>a+b,0) + modifier;
  const modeTag = diceMode !== 'normal' ? ` [${diceMode}]` : '';
  const modTag  = modifier !== 0 ? (modifier>0?'+':'')+modifier : '';
  const roll_expr   = `${count>1||diceMode!=='normal'?count:''}d${sides}${modTag}${modeTag}${label?' '+label:''}`;
  const breakdown = rolls.join(', ') + modTag;

  // Display result
  const resultEl = $('dice-result');
  const diceHtml = rolls.map((r,i) => {
    const isKept    = keptRolls.includes(r);
    const isDropped = droppedRolls[0] === r && i === rolls.length - 1 && droppedRolls.length > 0;
    const cls = (r===20&&sides===20?' nat20':r===1&&sides===20?' nat1':'') + (isDropped?' dropped':keptRolls.length<rolls.length&&isKept?' kept':'');
    return `<span class="die-val${cls}">${r}</span>`;
  }).join('');
  const modHtml = modifier !== 0 ? ` <span style="color:var(--muted);">${modifier>0?'+':''}${modifier}</span>` : '';
  resultEl.innerHTML = `
    <div class="dice-result-expr">${esc(roll_expr)}</div>
    <div class="dice-result-dice">${diceHtml}${modHtml}</div>
    <div class="dice-result-total">${total}${label?' — '+esc(label):''}</div>`;
  resultEl.classList.remove('hidden');

  if (jwt) api('POST', '/roll', { roll_expr, result: total, breakdown }).catch(() => {});
}

function addRollToFeed(data) {
  const name      = data.player_name || data.player || '?';
  const rollExpr  = data.roll_expr   || data.roll   || '';
  const breakdown = data.breakdown   || '';
  const result    = data.result;

  // Parse modifier and dice values from breakdown ("12, 8+3" → dice=[12,8], mod=3)
  const modM = breakdown.match(/([+-]\d+)$/);
  const mod  = modM ? parseInt(modM[1]) : 0;
  const diceStr = breakdown.replace(/[+-]\d+$/, '').trim();
  const dice = diceStr ? diceStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n)) : [];

  // Parse sides, mode, label from rollExpr
  const sidesM  = rollExpr.match(/d(\d+)/i);
  const sides   = sidesM ? parseInt(sidesM[1]) : 20;
  const isAdv   = /\[advantage\]/i.test(rollExpr);
  const isDis   = /\[disadvantage\]/i.test(rollExpr);
  const advMode = isAdv ? 'advantage' : isDis ? 'disadvantage' : 'normal';
  const baseM   = rollExpr.match(/^(\d*d\d+(?:[+-]\d+)?)/i);
  const baseExpr = baseM ? baseM[1] : rollExpr;
  const label   = rollExpr
    .replace(/^\d*d\d+(?:[+-]\d+)?/i, '')
    .replace(/\s*\[(advantage|disadvantage)\]\s*/i, '')
    .trim();

  // Kept index for advantage/disadvantage
  let ki = -1;
  if (advMode === 'advantage'    && dice.length >= 2) ki = dice.indexOf(Math.max(...dice));
  if (advMode === 'disadvantage' && dice.length >= 2) ki = dice.indexOf(Math.min(...dice));

  // Render die value spans
  const diceHtml = dice.length
    ? dice.map((v, i) => {
        let cls = 'fd-die-val';
        if (sides === 20 && v === 20) cls += ' nat20';
        else if (sides === 20 && v === 1) cls += ' nat1';
        if (ki !== -1 && i === ki) cls += ' kept';
        return `<span class="${cls}">${v}</span>`;
      }).join(' ')
    : `<span class="fd-fe-mod">${breakdown}</span>`;

  const modHtml  = mod ? `<span class="fd-fe-mod"> ${mod > 0 ? '+' : ''}${mod}</span>` : '';
  const advHtml  = advMode === 'advantage'    ? ` <span class="fd-adv-tag up">&#9650;</span>`
                 : advMode === 'disadvantage' ? ` <span class="fd-adv-tag dn">&#9660;</span>` : '';

  const html = `
    <div class="fd-fe-top">
      <span class="fd-fe-name">${esc(name)}</span>
      ${label ? `<span class="fd-fe-label"> &mdash; ${esc(label)}</span>` : ''}
      <span class="fd-fe-expr"> ${esc(baseExpr)}</span>${advHtml}
    </div>
    <div class="fd-fe-dice">${diceHtml}${modHtml}<span class="fd-fe-arrow"> &#8594;</span> <span class="fd-fe-total">${result}</span></div>`;

  for (const feedId of ['roll-feed', 'fd-feed']) {
    const feed = $(feedId); if (!feed) continue;
    const li = document.createElement('li');
    li.innerHTML = html;
    feed.prepend(li);
    while (feed.children.length > 50) feed.removeChild(feed.lastChild);
  }
}

// ── Floating dice panel ───────────────────────────────────────────────────────
let fdSides = 20, fdMode = 'normal';

function toggleFdPanel() {
  const panel = $('fd-panel'), btn = $('fd-toggle-btn');
  const open = panel.classList.toggle('open');
  if (btn) btn.classList.toggle('active', open);
  if (open) {
    const body = $('fd-panel-body');
    if (body) body.style.display = '';
    const minBtn = $('fd-minimize-btn');
    if (minBtn) { minBtn.textContent = '−'; minBtn.title = 'Minimize'; }
    fdUpdateStatButtons(); fdSelectDie(fdSides);
  }
}

function minimizeFdPanel() {
  const body = $('fd-panel-body'), btn = $('fd-minimize-btn');
  if (!body) return;
  const min = body.style.display === 'none';
  body.style.display = min ? '' : 'none';
  if (btn) { btn.textContent = min ? '−' : '+'; btn.title = min ? 'Minimize' : 'Restore'; }
}

function makeDraggable(panel, handle) {
  let startX, startY, startLeft, startTop;
  function onDown(cx, cy) {
    const r = panel.getBoundingClientRect();
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
    panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px';
    startX = cx; startY = cy; startLeft = r.left; startTop = r.top;
  }
  function onMove(cx, cy) {
    const maxL = window.innerWidth  - panel.offsetWidth  - 4;
    const maxT = window.innerHeight - panel.offsetHeight - 4;
    panel.style.left = Math.min(Math.max(0, startLeft + cx - startX), maxL) + 'px';
    panel.style.top  = Math.min(Math.max(0, startTop  + cy - startY), maxT) + 'px';
  }
  handle.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault(); onDown(e.clientX, e.clientY);
    const mv = e => onMove(e.clientX, e.clientY);
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });
  handle.addEventListener('touchstart', e => {
    if (e.target.closest('button')) return;
    const t = e.touches[0]; onDown(t.clientX, t.clientY);
    const mv = e => { e.preventDefault(); const t = e.touches[0]; onMove(t.clientX, t.clientY); };
    const up = () => { handle.removeEventListener('touchmove', mv); handle.removeEventListener('touchend', up); };
    handle.addEventListener('touchmove', mv, { passive: false });
    handle.addEventListener('touchend', up);
  }, { passive: true });
}

function fdSelectDie(sides) {
  fdSides = sides;
  $('fd-panel').querySelectorAll('.die-btn').forEach(b => b.classList.toggle('active', +b.dataset.sides === sides));
  if (sides !== 20) fdSetAdvMode('normal');
}

function fdSetAdvMode(mode) {
  fdMode = mode;
  const ids = { normal: 'fd-adv-normal', advantage: 'fd-adv-adv', disadvantage: 'fd-adv-dis' };
  Object.entries(ids).forEach(([m, id]) => document.getElementById(id)?.classList.toggle('active', m === mode));
}

function fdDoRoll() {
  const count    = Math.max(1, Math.min(20, parseInt($('fd-count').value) || 1));
  const sides    = fdSides;
  const modifier = parseInt($('fd-mod').value) || 0;
  const label    = $('fd-label').value.trim();

  let rolls, keptRolls, droppedRolls;
  if (sides === 20 && fdMode !== 'normal') {
    const r1 = rand(20), r2 = rand(20);
    if (fdMode === 'advantage') { keptRolls = [Math.max(r1,r2)]; droppedRolls = [Math.min(r1,r2)]; }
    else                        { keptRolls = [Math.min(r1,r2)]; droppedRolls = [Math.max(r1,r2)]; }
    rolls = fdMode === 'advantage' ? [Math.max(r1,r2), Math.min(r1,r2)] : [Math.min(r1,r2), Math.max(r1,r2)];
  } else {
    rolls = Array.from({length: count}, () => rand(sides));
    keptRolls = [...rolls]; droppedRolls = [];
  }

  const total    = keptRolls.reduce((a,b) => a+b, 0) + modifier;
  const modeTag  = fdMode !== 'normal' ? ` [${fdMode}]` : '';
  const modTag   = modifier !== 0 ? (modifier > 0 ? '+' : '') + modifier : '';
  const roll_expr = `${count > 1 || fdMode !== 'normal' ? count : ''}d${sides}${modTag}${modeTag}${label ? ' ' + label : ''}`;
  const breakdown = rolls.join(', ') + modTag;

  // Kept die is always placed first in rolls array for adv/disadv
  const diceHtml = rolls.map((r, i) => {
    const isKept = fdMode !== 'normal' && i === 0;
    let cls = 'fd-die-val';
    if (sides === 20 && r === 20) cls += ' nat20';
    else if (sides === 20 && r === 1) cls += ' nat1';
    if (isKept) cls += ' kept';
    return `<span class="${cls}">${isKept ? '&#10003;&thinsp;' : ''}${r}</span>`;
  }).join(' ');
  const modHtml  = modifier !== 0 ? `<span style="color:var(--muted);margin-left:3px;">${modifier > 0 ? '+' : ''}${modifier}</span>` : '';
  const advHtml  = fdMode === 'advantage'
    ? `<div style="color:#28a745;font-size:.7rem;font-weight:600;">&#9650; Advantage &mdash; keep highest</div>`
    : fdMode === 'disadvantage'
    ? `<div style="color:#fd7e14;font-size:.7rem;font-weight:600;">&#9660; Disadvantage &mdash; keep lowest</div>` : '';
  const lblHtml  = label ? `<div style="color:var(--muted);font-size:.7rem;">${esc(label)}</div>` : '';

  const resultEl = $('fd-result');
  resultEl.innerHTML = `${lblHtml}${advHtml}<div class="fd-fe-dice">${diceHtml}${modHtml} <span style="opacity:.5;">&#8594;</span> <span style="color:var(--accent);font-weight:bold;font-size:1rem;">${total}</span></div>`;
  resultEl.classList.remove('hidden');

  if (jwt) api('POST', '/roll', { roll_expr, result: total, breakdown }).catch(() => {});
}

function fdReset() {
  $('fd-count').value = 1; $('fd-mod').value = 0; $('fd-label').value = '';
  fdSelectDie(20); fdSetAdvMode('normal');
  $('fd-result').classList.add('hidden');
}

function clearFdFeed() { const f = $('fd-feed'); if (f) f.innerHTML = ''; }

function fdUpdateStatButtons() {
  const el = $('fd-stat-mod-btns'); if (!el) return;
  const sheet = mySheet(); if (!sheet) { el.innerHTML = ''; return; }
  const level = sheet.level || 1, profB = pb(level);
  const stats = [
    ['STR', mod(sheet.str??10)], ['DEX', mod(sheet.dex??10)], ['CON', mod(sheet.con??10)],
    ['INT', mod(sheet.int??10)], ['WIS', mod(sheet.wis??10)], ['CHA', mod(sheet.cha??10)],
    ['PROF', profB],
  ];
  el.innerHTML = stats.map(([label, val]) =>
    `<button class="stat-mod-btn" onclick="$('fd-mod').value=${val}" title="${label}: ${val>=0?'+':''}${val}">${label}<br><span style="color:var(--accent);">${val>=0?'+':''}${val}</span></button>`
  ).join('');
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function doChangePassword() {
  const oldPw = $('pw-old').value;
  const newPw = $('pw-new').value;
  const conf  = $('pw-confirm').value;
  const msg   = $('pw-msg');
  msg.textContent = ''; msg.className = 'msg-line';
  if (!oldPw || !newPw) { msg.textContent = 'Fill in all fields.'; msg.style.color = 'var(--danger)'; return; }
  if (newPw !== conf)   { msg.textContent = 'New passwords do not match.'; msg.style.color = 'var(--danger)'; return; }
  if (newPw.length < 4) { msg.textContent = 'New password too short.'; msg.style.color = 'var(--danger)'; return; }
  try {
    await api('POST', '/character/password', { old_password: oldPw, new_password: newPw });
    msg.textContent = 'Password changed successfully.'; msg.style.color = 'var(--success)';
    $('pw-old').value = ''; $('pw-new').value = ''; $('pw-confirm').value = '';
  } catch (err) {
    msg.textContent = err.message; msg.style.color = 'var(--danger)';
  }
}

// ── Logout ────────────────────────────────────────────────────────────────────
$('logout-btn').addEventListener('click', doLogout);

function doLogout() {
  if (eventSource) { eventSource.close(); eventSource = null; }
  sessionStorage.removeItem('relay_jwt');
  jwt = null; myPlayerId = null; sessionId = null; playerName = null;
  tokens = []; characters = []; effects = []; resourceState = {};
  GRID_COLS = 20; GRID_ROWS = 20; dragging = null;
  const grid = $('map-grid'); if (grid) grid.querySelectorAll('.map-token').forEach(e=>e.remove());
  const bg = $('map-bg'); if (bg) bg.src = '';
  $('no-map-msg').style.display = '';
  $('player-name').value = ''; $('player-password').value = ''; $('join-code').value = '';
  $('login-error').textContent = ''; $('header-player').textContent = ''; $('header-scene').textContent = 'ScenePlay Relay';
  $('roll-feed').innerHTML = '';
  $('party-list').innerHTML = '<p class="muted-text" style="padding:8px;">No characters yet.</p>';
  $('sheet-content').innerHTML = '';
  $('dice-result').classList.add('hidden');
  $('fd-panel').classList.remove('open'); $('fd-toggle-btn')?.classList.remove('active');
  $('fd-feed').innerHTML = ''; $('fd-result').classList.add('hidden');
  $('app').classList.add('hidden'); $('login-overlay').classList.remove('hidden');
}

// ── Init ──────────────────────────────────────────────────────────────────────
selectDie(20);
fdSelectDie(20);
makeDraggable($('fd-panel'), $('fd-drag-handle'));
