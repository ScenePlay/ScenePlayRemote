'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let jwt = null, myPlayerId = null, myUsername = null, sessionId = null, playerName = null;
let activeCharId = null;   // which owned character is shown in the Sheet tab
let tokens = [], characters = [], effects = [], eventSource = null;
let CELL_PX = 64, GRID_COLS = 20, GRID_ROWS = 20, dragging = null, MOVE_SCALE = 1;
let sheetTab = 'resources';
let diceSides = 20, diceMode = 'normal';
let resourceState = {};   // `${charId}:${name}` → currentVal
let _mapUrl = '';         // last-loaded map background, to detect real map switches
// Safe SFX trigger — never let a missing/broken sound module touch portal logic.
function _sfx(name) { try { if (window.SFX) SFX.play(name); } catch (e) {} }
let _library = { spells: [], feats: [], weapons: [], armor: [], equipment: [], skills: [], races: [], classes: [],
                 conditions: [], magic_items: [], features: [], class_levels: [], subclasses: [], traits: [],
                 weapon_properties: [], rules: [] };

const STD_CONDITIONS = [
  'Blinded','Charmed','Deafened','Exhaustion','Frightened','Grappled',
  'Incapacitated','Invisible','Paralyzed','Petrified','Poisoned',
  'Prone','Restrained','Stunned','Unconscious',
];
const COND_DESC = {
  Blinded:       "Can't see; auto-fails sight checks; attacks at disadvantage; attackers have advantage.",
  Charmed:       "Can't attack charmer; charmer has advantage on social checks vs. creature.",
  Deafened:      "Can't hear; auto-fails hearing checks.",
  Exhaustion:    "Levels 1-6: disadvantage on checks → speed halved → checks & saves disadvantage → speed 0 → death.",
  Frightened:    "Disadvantage on checks/attacks while source is in sight; can't willingly move closer.",
  Grappled:      "Speed 0. Ends if grappler is incapacitated or creature is moved out of reach.",
  Incapacitated: "Can't take actions or reactions.",
  Invisible:     "Unseen; attacks against it disadvantaged; its attacks advantaged.",
  Paralyzed:     "Incapacitated; auto-fails STR/DEX saves; attacks have advantage; crits on any hit within 5 ft.",
  Petrified:     "Transformed to stone; incapacitated; resists all damage; immune to poison/disease.",
  Poisoned:      "Disadvantage on attack rolls and ability checks.",
  Prone:         "Disadvantage on attacks; melee attacks within 5 ft have advantage; ranged disadvantage.",
  Restrained:    "Speed 0; attacks at disadvantage; attackers have advantage; DEX saves at disadvantage.",
  Stunned:       "Incapacitated; can't move; only speak falteringly; auto-fails STR/DEX saves; attacks have advantage.",
  Unconscious:   "Incapacitated; drops held items; falls prone; auto-fails STR/DEX saves; attacks have advantage; crits within 5 ft.",
};

// Full SRD condition text when the GM has synced+pushed the conditions library;
// the short built-in summaries above remain the fallback.
function condDesc(name) {
  const lib = (_library.conditions || []).find(
    c => (c.name || '').toLowerCase() === (name || '').toLowerCase());
  return (lib && lib.description) || COND_DESC[name] || '';
}

// Weapon property names ("Finesse, Versatile (1d10)") rendered with hover
// definitions from the synced weapon_properties library. Unknown names pass
// through as plain text.
function wpnPropsHtml(props) {
  if (!props) return '';
  return props.split(',').map(p => {
    const pn = p.trim();
    const key = pn.split('(')[0].trim().toLowerCase();
    const def = (_library.weapon_properties || []).find(
      w => (w.name || '').toLowerCase() === key);
    return def && def.description
      ? `<span title="${esc(def.description)}" style="cursor:help;border-bottom:1px dotted var(--muted);">${esc(pn)}</span>`
      : esc(pn);
  }).join(', ');
}

async function mutate(mutation_type, data) {
  // as_player: key the mutation to the character whose sheet is open. Without
  // it, edits always hit the LOGIN character — wrong for multi-character
  // players and for spectator logins that were assigned a character later.
  const target = (myChar() || {}).player_name;
  return api('POST', '/character/mutate', { mutation_type, data, as_player: target || undefined });
}

async function loadLibrary() {
  try {
    const res = await api('GET', '/library');
    if (res.library && Object.keys(res.library).length) {
      _library = res.library;
      // Show every library list alphabetically (by name) for players.
      for (const k in _library) {
        if (Array.isArray(_library[k])) {
          _library[k].sort((a, b) =>
            (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
        }
      }
      // The sheet often renders (from session_state) before this resolves, so
      // the "Browse Libraries" counts would be stuck at 0 while the expanded
      // lists show the full data. Re-render now that the library is loaded.
      renderSheet();
    }
  } catch {}
}

function libSearch(type, q) {
  // Sort at display time (a copy) so every library list is alphabetical for
  // players regardless of the order it was pushed/loaded in.
  // 'inv' is the inventory picker's combined view: equipment + magic items.
  const source = type === 'inv'
    ? [...(_library.equipment || []),
       ...(_library.magic_items || []).map(m => ({ ...m, _magic: true }))]
    : (_library[type] || []);
  const items = source.slice().sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
  const qn = q.toLowerCase().trim();
  if (!qn) return items;                                       // full list on click
  return items.filter(i => (i.name || '').toLowerCase().includes(qn));  // narrow as typed
}

function _libSubtitle(type, i) {
  switch (type) {
    case 'skills':
      return i.ability ? `<div class="lib-sub">${esc(i.ability)}</div>` : '';
    case 'feats':
      return i.prerequisites ? `<div class="lib-sub">Req: ${esc(i.prerequisites)}</div>` : '';
    case 'weapons': {
      const parts = [esc(i.category||''), esc(i.range||'')].filter(Boolean).join(', ');
      const dmg   = i.damage_dice ? ` &mdash; ${esc(i.damage_dice)} ${esc(i.damage_type||'')}` : '';
      return `<div class="lib-sub">${parts}${dmg}${i.properties?` &bull; ${esc(i.properties)}`:''}</div>`;
    }
    case 'armor':
      return `<div class="lib-sub">${esc(i.category||'')}${i.ac_base != null ? ` &mdash; AC ${i.ac_base}` : ''}</div>`;
    case 'equipment': {
      const cat  = [i.category, i.subcategory].filter(Boolean).map(esc).join(' &rsaquo; ');
      const meta = [i.weight ? `${i.weight} lb` : '', i.cost || ''].filter(Boolean).join(' &bull; ');
      return `<div class="lib-sub">${[cat, meta].filter(Boolean).join(' &mdash; ')}</div>`;
    }
    case 'spells': {
      const lvl = i.level === 0 ? 'Cantrip' : `Level ${i.level}`;
      return `<div class="lib-sub">${lvl}${i.school ? ' &bull; ' + esc(i.school) : ''}${i.classes ? ' &mdash; ' + esc(i.classes) : ''}</div>`;
    }
    case 'races':
      return `<div class="lib-sub">${i.speed ? 'Speed ' + i.speed : ''}${i.size ? ' &bull; ' + esc(i.size) : ''}</div>`;
    case 'classes':
      return `<div class="lib-sub">d${i.hit_die || '?'}${i.saving_throws ? ' &bull; ' + esc(i.saving_throws) : ''}</div>`;
    case 'magic_items': {
      const parts = [i.category, i.rarity, i.attunement ? 'Requires attunement' : '']
        .filter(Boolean).map(esc).join(' &bull; ');
      return parts ? `<div class="lib-sub">${parts}</div>` : '';
    }
    case 'features': {
      const parts = [i.class, i.subclass, i.level ? `Level ${i.level}` : '']
        .filter(Boolean).map(esc).join(' &bull; ');
      return parts ? `<div class="lib-sub">${parts}</div>` : '';
    }
    case 'subclasses': {
      const parts = [i.class, i.flavor].filter(Boolean).map(esc).join(' &bull; ');
      return parts ? `<div class="lib-sub">${parts}</div>` : '';
    }
    case 'traits':
      return i.races ? `<div class="lib-sub">${esc(i.races)}</div>` : '';
    case 'rules':
      return i.parent ? `<div class="lib-sub">${esc(i.parent)}</div>` : '';
    case 'inv':   // combined inventory picker: route by entry origin
      return _libSubtitle(i._magic ? 'magic_items' : 'equipment', i);
    default: return '';
  }
}

function libSearchShow(inputId, resultsId, type) {
  const q = $(inputId)?.value || '';
  const results = $(resultsId);
  if (!results) return;
  const matches = libSearch(type, q);
  if (!matches.length) { results.style.display = 'none'; return; }
  results.innerHTML = matches.map(i =>
    `<div class="lib-result-item" onmousedown="event.preventDefault();libPick('${inputId}','${resultsId}',${jarg(i.name)})">
      <div style="color:var(--accent);font-weight:600;">${esc(i.name)}</div>
      ${_libSubtitle(type, i)}
    </div>`
  ).join('');
  const inp = $(inputId);
  if (inp) {
    const r = inp.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const spaceAbove = r.top;
    const maxH = Math.min(220, spaceBelow > 120 ? spaceBelow - 8 : spaceAbove - 8);
    if (spaceBelow >= 120 || spaceBelow >= spaceAbove) {
      results.style.top  = (r.bottom + 2) + 'px';
      results.style.bottom = '';
    } else {
      results.style.top  = '';
      results.style.bottom = (window.innerHeight - r.top + 2) + 'px';
    }
    results.style.left  = r.left + 'px';
    results.style.width = r.width + 'px';
    results.style.maxHeight = Math.max(80, maxH) + 'px';
  }
  results.style.display = '';
}

function libPick(inputId, resultsId, name) {
  const inp = $(inputId);
  if (inp) inp.value = name;
  const res = $(resultsId);
  if (res) res.style.display = 'none';
  if (inp) inp.dispatchEvent(new CustomEvent('libpick', { detail: { name } }));
  if (inputId === 'inv-new-name') invLibPreview();
  if (inputId === 'wpn-new-name') autoFillWeapon();
  if (inputId === 'arm-new-name') autoFillArmor();
  if (inputId === 'spl-new-name') autoFillSpell();
  if (inputId === 'feat-new-name') autoFillFeat();
}

document.addEventListener('click', e => {
  if (!e.target.closest('.lib-results') && !e.target.closest('[onfocus*="libSearch"]') && !e.target.closest('[oninput*="libSearch"]')) {
    document.querySelectorAll('.lib-results').forEach(el => el.style.display = 'none');
  }
});

function patchSheet(char, patchFn) {
  let sheet;
  try { sheet = typeof char.sheet_json === 'string' ? JSON.parse(char.sheet_json) : char.sheet_json; }
  catch { sheet = {}; }
  patchFn(sheet);
  char.sheet_json = JSON.stringify(sheet);
  const el = $('sheet-tab-content');
  if (el) el.innerHTML = renderSheetTabContent(sheet, char);
}

function syncResourceState(charId, sheet) {
  for (const key in resourceState) {
    if (key.startsWith(charId + ':')) delete resourceState[key];
  }
  for (const r of (sheet.resources || [])) {
    resourceState[`${charId}:${r.name}`] = r.current;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
// Safely embed a JS argument inside a double-quoted onclick="..." attribute.
// JSON.stringify wraps strings in " which would close the attribute; escaping
// those to &quot; lets the browser turn them back into a valid JS string.
const jarg = v => esc(JSON.stringify(v)).replace(/"/g, '&quot;');
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
  if (res.status === 401 && jwt) {   // expired/invalid token mid-session → back to login
    sessionExpired();
    throw new Error('Session expired');
  }
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
  // Fall back to ANY owned character: spectator logins have a "user:" sub that
  // matches no character until the GM assigns one mid-session.
  return characters.find(c => c.id === myPlayerId) || myChars()[0] || null;
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

// Collapsible dice roller embedded in the Sheet tab (moved here from its own tab).
function toggleSheetDice() {
  const body = $('sheet-dice-body'), caret = $('sheet-dice-caret');
  if (!body) return;
  const open = !body.classList.contains('hidden');   // currently open?
  body.classList.toggle('hidden', open);             // close if open, open if closed
  if (caret) caret.innerHTML = open ? '&#9660;' : '&#9650;';
}

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
  loadLibrary();
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
let _sseRetryTimer = null;
let _sseRetryDelay = 1000;          // exponential backoff: 1s → 30s cap

function _connStatus(state) {       // 'ok' | 'reconnecting' | 'down'
  const dot = $('conn-dot');
  if (!dot) return;
  dot.dataset.state = state;
  dot.title = state === 'ok' ? 'Connected'
            : state === 'reconnecting' ? 'Connection lost — reconnecting…'
            : 'Disconnected';
}

function _jwtValid() {
  const claims = jwt && parseJwt(jwt);
  return !!(claims && claims.exp && claims.exp * 1000 > Date.now());
}

// The 12h JWT can expire mid-session (tab left open overnight). Without this,
// every mutation silently 401s while the sheet still looks live.
function sessionExpired() {
  if (eventSource) { eventSource.close(); eventSource = null; }
  clearTimeout(_sseRetryTimer); _sseRetryTimer = null;
  _connStatus('down');
  sessionStorage.removeItem('relay_jwt');
  jwt = null;
  $('login-error').textContent = 'Session expired — please log in again.';
  $('app').classList.add('hidden');
  $('login-overlay').classList.remove('hidden');
}

function connectSSE() {
  if (eventSource) eventSource.close();
  clearTimeout(_sseRetryTimer); _sseRetryTimer = null;
  if (!_jwtValid()) { sessionExpired(); return; }

  _connStatus('reconnecting');
  eventSource = new EventSource(`/api/v1/session/${sessionId}/stream?token=${encodeURIComponent(jwt)}`);
  eventSource.onopen = () => { _sseRetryDelay = 1000; _connStatus('ok'); };
  eventSource.addEventListener('message', e => {
    _connStatus('ok');
    try { handleEvent(JSON.parse(e.data)); } catch { /* malformed */ }
  });
  // Manual reconnect with backoff: the browser's built-in EventSource retry
  // gives up on hard failures (relay restart, Render cold start), which used
  // to strand the client silently with no visual cue.
  eventSource.onerror = () => {
    if (eventSource) { eventSource.close(); eventSource = null; }
    if (!_jwtValid()) { sessionExpired(); return; }
    _connStatus('reconnecting');
    _sseRetryTimer = setTimeout(connectSSE, _sseRetryDelay);
    _sseRetryDelay = Math.min(_sseRetryDelay * 2, 30000);
  };
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
          MOVE_SCALE = parsed.movement_scale || 1;
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
      renderTokens(); renderEffects(); renderParty(); renderSheet(); fdInitRoller();
      break;
    }
    case 'scene_update':
      $('header-scene').textContent = ev.data.name || 'ScenePlay Relay';
      break;
    case 'map_update': {
      const parsed = tokensFromMapJson(ev.data.map_json);
      if (parsed) {
        MOVE_SCALE = parsed.movement_scale || 1;
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
        const target = c || tok;
        // Voice DM-applied damage/heal on every listening device by diffing the
        // incoming HP against what we last knew. A player who applied the change
        // themselves already updated + voiced it optimistically, so this echo
        // diffs to zero and stays silent (no double-voice). Mirrors the local
        // battlemap's _hpSfxDiff.
        const prevHp = target.hp_current, newHp = ev.data.hp_current;
        if (typeof prevHp === 'number' && typeof newHp === 'number' && newHp !== prevHp) {
          if (newHp < prevHp) _sfx(newHp <= 0 ? 'dead' : 'damage');
          else                _sfx('heal');
        }
        target.hp_current = newHp; target.hp_max = ev.data.hp_max;
        const el = $('tok-'+tok.id); if (el) updateTokenHp(el, target);
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
      renderParty(); renderTokens(); fdInitRoller();
      break;
    }
    case 'character_upserted': {
      // GM created, edited, or reassigned a character — keep the roster live
      // so nobody has to re-login. Upsert by id (fallback: player_name).
      const d = ev.data;
      const idx = characters.findIndex(c => c.id === d.id || c.player_name === d.player_name);
      if (idx >= 0) {
        const prev = characters[idx];
        characters[idx] = { ...prev, ...d };
        if (!d.portrait_url && prev.portrait_url) characters[idx].portrait_url = prev.portrait_url;
      } else {
        characters.push({ ...d });
      }
      renderParty(); renderTokens(); renderSheet(); fdInitRoller();
      break;
    }
    case 'character_removed': {
      const name = ev.data.player_name;
      characters = characters.filter(c => c.player_name !== name);
      tokens     = tokens.filter(t => !(t.label === name && t.token_type === 'player'));
      renderParty(); renderTokens();
      fdInitRoller();
      if (name === playerName) doLogout();
      break;
    }
    case 'character_sheet_updated': {
      const d = ev.data;
      const c = characters.find(x => x.player_name === d.player_name);
      if (c) {
        if (d.sheet_json) { c.sheet_json = d.sheet_json; fdRenderQuickRef(); }
        if (d.hp_current != null) c.hp_current = d.hp_current;
        if (d.hp_max != null)     c.hp_max     = d.hp_max;
        if (d.portrait_url)       c.portrait_url = d.portrait_url;
        const sh = typeof c.sheet_json === 'string' ? JSON.parse(c.sheet_json) : c.sheet_json;
        syncResourceState(c.id, sh || {});
        if (activeCharId === c.id) renderSheet();
        renderParty();
        // Keep battlemap token HP bars in sync (HP now arrives via this event)
        for (const tok of tokens) {
          if (findCharForToken(tok)?.id === c.id) {
            const el = $('tok-' + tok.id);
            if (el) updateTokenHp(el, c);
          }
        }
      }
      break;
    }
    case 'character_portrait_updated': {
      const c = characters.find(x => x.player_name === ev.data.player_name);
      if (c && ev.data.portrait_url) {
        c.portrait_url = ev.data.portrait_url;
        if (activeCharId === c.id) renderSheet();
        renderTokens();
        renderParty();
      }
      break;
    }
    case 'roll_result':
      addRollToFeed(ev.data);
      // crit/fumble is voiced by the dice roller itself (doRoll/fdDoRoll); no feed echo.
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
        size_squares: t.size_squares ?? 1,
      })),
      effects: m.effects || [],
      movement_scale: m.movement_scale || 1,
    };
  } catch { return null; }
}

function _isVideoMapUrl(url) {
  if (url.startsWith('data:video/')) return true;
  return /\.(mp4|webm|ogv)$/.test(url.split('?')[0].toLowerCase());
}

function loadMap(url, gridCols, gridRows) {
  if (!url) return;
  // Play the transition sting only on a real map change (not the first load,
  // and not the frequent same-map updates from token/effect broadcasts).
  const changed = url !== _mapUrl;
  if (_mapUrl && changed) _sfx('mapswitch');
  _mapUrl = url;
  $('no-map-msg').style.display = 'none';
  GRID_COLS = gridCols || GRID_COLS; GRID_ROWS = gridRows || GRID_ROWS;
  const grid = $('map-grid'), lines = $('map-lines');
  grid.style.width  = (GRID_COLS * CELL_PX) + 'px';
  grid.style.height = (GRID_ROWS * CELL_PX) + 'px';
  lines.style.backgroundSize = `${CELL_PX}px ${CELL_PX}px`;
  // Video backgrounds render in a <video> sibling; stills keep the <img>.
  // Only touch the video src on a real change so frequent same-map pushes
  // (token moves, effects) don't restart playback.
  const img = $('map-bg'), vid = $('map-bg-video');
  if (vid && _isVideoMapUrl(url)) {
    img.style.display = 'none';
    img.removeAttribute('src');
    vid.style.display = '';
    if (changed || !vid.src) {
      vid.src = url;
      vid.play().catch(() => {});   // autoplay is muted, but be defensive
    }
  } else {
    if (vid) {
      try { vid.pause(); } catch (e) {}
      vid.removeAttribute('src');
      vid.style.display = 'none';
    }
    img.style.display = '';
    img.src = url;
  }
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
  // Enemy (monster/npc) tokens shade to grey when defeated (HP ≤ 0)
  const isNpc = el.dataset.tokenType === 'monster' || el.dataset.tokenType === 'npc';
  el.classList.toggle('token-dead', isNpc && (charOrTok.hp_current ?? 1) <= 0);
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
  const span  = Math.max(1, t.size_squares || 1);   // grid squares this token spans
  const sz = span * CELL_PX - 6;
  const border = isMe ? '#2ecc71' : isNpc ? '#cc3333' : '#4a9eff';
  const bg     = isMe ? '#0d2820' : isNpc ? '#2d0a0a' : '#0d2845';
  const el = document.createElement('div');
  el.className = 'map-token' + (isMe ? ' token-mine' : '');
  el.id = 'tok-'+t.id; el.dataset.tokenId = t.id; el.dataset.tokenType = t.token_type || '';
  el.dataset.mine = isMe ? '1' : '0';   // ownership snapshot; renderTokens rebuilds on change
  // Big tokens sit BEHIND smaller ones so adjacent creatures stay clickable.
  const zBase = span > 1 ? `z-index:${Math.max(1, 6 - span)};` : '';
  el.style.cssText = `transform:translate(${col*CELL_PX}px,${row*CELL_PX}px);width:${span*CELL_PX}px;${zBase}`;
  const portraitUrl = char?.portrait_url || t.image_url || '';
  const pInner = portraitUrl
    ? `<img src="${esc(portraitUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
       <span style="display:none;width:100%;height:100%;align-items:center;justify-content:center;">${initials(t.label)}</span>`
    : `<span>${initials(t.label)}</span>`;
  const hp  = char?.hp_current ?? t.hp_current ?? null;
  const max = char?.hp_max     ?? t.hp_max     ?? null;
  const pct = (hp != null && max) ? Math.max(0, Math.min(100, Math.round(100*hp/max))) : null;
  if (isNpc && max != null && max > 0 && hp != null && hp <= 0) el.classList.add('token-dead');
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
    const mineNow = isMyToken(t) ? '1' : '0';
    if (el && el.dataset.mine !== mineNow && (!dragging || dragging.id !== t.id)) {
      // Ownership changed (GM reassigned the character): the drag handler,
      // green highlight, and YOU arrow were baked in at creation — rebuild so
      // the new owner can move it (and the old owner can't) without a reload.
      el.remove();
      el = null;
    }
    if (!el) { el = createTokenEl(t, char, col, row); grid.appendChild(el); }
    else {
      if (!dragging || dragging.id !== t.id) { const span = Math.max(1, t.size_squares || 1); el.style.transform = `translate(${col*CELL_PX}px,${row*CELL_PX}px)`; el.style.width = (span*CELL_PX)+'px'; }
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

  // Stats row: AC · Speed. Enemy (monster) AC is hidden from players; players
  // still see AC on player tokens. Speed is shown for both.
  const ac    = isMonster ? null : sheet?.ac;
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

// ── Movement radius (distance circle shown while dragging a token) ────────────
let _moveRing = null, _moveLabel = null, _moveCx = 0, _moveCy = 0;
function _showMoveRing(cx, cy) {
  _removeMoveRing();
  const grid = $('map-grid'); if (!grid) return;
  _moveCx = cx; _moveCy = cy;
  _moveRing = document.createElement('div');
  _moveRing.className = 'move-radius';
  grid.appendChild(_moveRing);
  _moveLabel = document.createElement('div');
  _moveLabel.className = 'move-radius-label';
  _moveLabel.style.left = cx + 'px'; _moveLabel.style.top = cy + 'px';
  _moveLabel.textContent = '0 ft';
  grid.appendChild(_moveLabel);
}
function _updateMoveRing(cx, cy) {
  if (!_moveRing) return;
  const r = Math.hypot(cx - _moveCx, cy - _moveCy);
  const feet = Math.round((r / CELL_PX) * 5 * MOVE_SCALE);
  _moveRing.style.left = (_moveCx - r) + 'px';
  _moveRing.style.top  = (_moveCy - r) + 'px';
  _moveRing.style.width = _moveRing.style.height = (2 * r) + 'px';
  _moveLabel.textContent = feet + ' ft';
}
function _removeMoveRing() {
  if (_moveRing)  _moveRing.remove();
  if (_moveLabel) _moveLabel.remove();
  _moveRing = _moveLabel = null;
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
    // Read the *live* token from the array: session_state/map_update replace
    // token objects wholesale, so this handler's closed-over `tok` can be a
    // stale orphan (e.g. after the GM moves the token). Anchor the move radius
    // to the token's current position, not the stale one.
    const live = tokens.find(t => String(t.id) === String(tok.id)) || tok;
    const pos = pctToColRow(live.x_pct, live.y_pct);
    _startCol = pos.col; _startRow = pos.row;
    _hasMoved = false;
    _downPos  = { clientX: e.clientX, clientY: e.clientY };

    if (canMove) {
      ds = pos; dragging = { id: tok.id };
      hideTooltip();
      el.style.transition = 'none'; el.style.zIndex = '100'; el.style.opacity = '.85';
      _showMoveRing((_startCol + 0.5) * CELL_PX, (_startRow + 0.5) * CELL_PX);
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
    if (col !== ds.col || row !== ds.row) { ds.col = col; ds.row = row; el.style.transform = `translate(${col*CELL_PX}px,${row*CELL_PX}px)`; _updateMoveRing((col+0.5)*CELL_PX, (row+0.5)*CELL_PX); }
  });

  function endDrag() {
    clearTimeout(_lpTimer);
    _lpTimer = null;
    _removeMoveRing();
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

    const { x_pct, y_pct } = colRowToPct(col, row);
    // Update both the live array object and the closed-over one so the next
    // drag reads the right origin regardless of which the handler sees.
    const live = tokens.find(t => String(t.id) === String(tok.id));
    if (live) { live.x_pct = x_pct; live.y_pct = y_pct; }
    tok.x_pct = x_pct; tok.y_pct = y_pct;
    api('POST', '/token/move', { token_id: tok.id, x_pct, y_pct, label: tok.label, token_type: tok.token_type || 'player' })
      .catch(err => console.warn('token move rejected:', err.message));
    // Mover-only footstep — only when the token actually changed cells.
    if (col !== _startCol || row !== _startRow) _sfx('move');
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
    const span = Math.max(1, t.size_squares || 1);
    el.style.transform = `translate(${col*CELL_PX}px,${row*CELL_PX}px)`; el.style.width = (span*CELL_PX)+'px';
    const p = el.querySelector('.token-portrait'); if (p) { const sz = span*CELL_PX-6; p.style.width = sz+'px'; p.style.height = sz+'px'; }
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
    if (e.target !== vp && e.target !== $('map-grid') && e.target !== $('map-lines') && e.target !== $('map-bg') && e.target !== $('map-bg-video')) return;
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
    const th = $('sheet-tabs-host'); if (th) th.innerHTML = '';
    return;
  }
  const hp = char.hp_current ?? 0, hpMax = char.hp_max || 1;
  const hpPct = Math.max(0, Math.min(100, Math.round(100*hp/hpMax)));
  const equippedW = (sheet.weapons||[]).filter(w=>w.equipped);
  const equippedA = (sheet.armor||[]).filter(a=>a.equipped);
  const wChips = equippedW.map(w => {
    const tip = [w.category, w.range, w.damage_dice?(w.damage_dice+(w.damage_bonus?'+'+w.damage_bonus:'')+(w.damage_type?' '+w.damage_type:'')):null, w.attack_bonus?'+'+w.attack_bonus+' to hit':null, w.properties].filter(Boolean).join(' · ');
    return `<span class="chip chip-weapon" title="${esc(tip)}">&#9876; ${esc(w.name)}${w.damage_dice?`<span class="chip-detail"> ${esc(w.damage_dice)}${w.damage_bonus?'+'+w.damage_bonus:''} ${esc(w.damage_type)}</span>`:''}${w.attack_bonus?`<span class="chip-detail"> +${w.attack_bonus} hit</span>`:''}</span>`;
  }).join('');
  const aChips = equippedA.map(a => {
    const dexStr = a.dex_bonus ? (a.max_dex_bonus != null ? ` + DEX (max ${a.max_dex_bonus})` : ' + DEX') : '';
    const tip = [a.category||'', dexStr, a.str_minimum?'STR '+a.str_minimum+' req':'', a.stealth_disadvantage?'Stealth disadv.':''].filter(Boolean).join(' · ');
    return `<span class="chip chip-armor" title="${esc(tip)}">${a.is_shield?'&#9694;':'&#9651;'} ${esc(a.name)}<span class="chip-detail"> ${a.is_shield?'+':''}${(a.ac_base||0)+(a.ac_bonus||0)} AC</span></span>`;
  }).join('');
  const cChips = (sheet.conditions||[]).map(c => `<span class="chip chip-condition" title="${esc(condDesc(c))}">&#9763; ${esc(c)}</span>`).join('');
  const skillsStrip = (sheet.skills||[]).length ? `<div class="skills-strip">${(sheet.skills||[]).map(s=>`<span>${s.proficient?'&#9733;':'&#9734;'} ${esc(s.name)} <strong>${s.bonus>=0?'+':''}${s.bonus}</strong></span>`).join('')}</div>` : '';
  const featChips = (sheet.feats||[]).length ? `<div class="chip-row">${(sheet.feats||[]).map(f=>`<span class="chip" title="${esc(f.description||'')}" style="background:rgba(100,80,200,.15);color:var(--accent);border-color:rgba(100,80,200,.3);">&#10022; ${esc(f.name)}</span>`).join('')}</div>` : '';
  const prepSpells = (sheet.spells||[]).filter(s=>s.prepared);
  const spellChips = prepSpells.length ? `<div class="chip-row">${prepSpells.map(s=>{const tip=[s.level===0?'Cantrip':'Level '+s.level,s.school,s.casting_time?'Cast: '+s.casting_time:'',s.range?'Range: '+s.range:'',s.duration?'Duration: '+s.duration:'',s.concentration?'Concentration':'',s.ritual?'Ritual':''].filter(Boolean).join(' · ');return`<span class="chip" title="${esc(tip)}" style="background:rgba(80,80,200,.12);color:var(--accent);border-color:rgba(80,120,200,.3);">&#10039; ${esc(s.name)}</span>`}).join('')}</div>` : '';
  const attrsOwn = myChars().some(c => c.id === char.id);
  const attrs = ['str','dex','con','int','wis','cha'].map(s => {
    const score = sheet[s] ?? 10, m = mod(score);
    const modStr = `${m>=0?'+':''}${m}`;
    if (!attrsOwn) {
      return `<div class="attr-box"><div class="attr-label">${s.toUpperCase()}</div><div class="attr-score">${score}</div><div class="attr-mod">${modStr}</div></div>`;
    }
    return `<div class="attr-box">
      <div class="attr-label">${s.toUpperCase()}</div>
      <div class="attr-step"><button class="attr-stepbtn" onclick="stepAttr('${s}','score',-1)" title="−1">&minus;</button><span class="attr-score attr-editable" onclick="startAttrEdit(this,'${s}',false)" title="Click to edit">${score}</span><button class="attr-stepbtn" onclick="stepAttr('${s}','score',1)" title="+1">+</button></div>
      <div class="attr-step"><button class="attr-stepbtn" onclick="stepAttr('${s}','mod',-1)" title="−1 modifier">&minus;</button><span class="attr-mod attr-editable" onclick="startAttrEdit(this,'${s}',true)" title="Click to edit">${modStr}</span><button class="attr-stepbtn" onclick="stepAttr('${s}','mod',1)" title="+1 modifier">+</button></div>
    </div>`;
  }).join('');
  // Badge counts for sub-tabs
  const _cnt = key => { const v = sheet[key]; return Array.isArray(v) ? v.length : 0; };
  const _badge = (id, key) => {
    const n = _cnt(key);
    return n ? `<span style="font-size:.6rem;background:var(--accent);color:#111;border-radius:8px;padding:1px 5px;margin-left:3px;vertical-align:middle;">${n}</span>` : '';
  };
  const subTabs = [
    ['resources','Resources','resources'],['skills','Skills','skills'],['inventory','Inventory','inventory'],
    ['weapons','Weapons','weapons'],['armor','Armor','armor'],['currency','Currency',null],
    ['feats','Feats','feats'],['spells','Spells','spells'],['conditions','Conditions','conditions'],
    ['notes','Notes','notes'],['attrs','Attributes',null],['reference','Reference',null],
  ];
  try { const saved = sessionStorage.getItem('sp_tab_'+char.id); if (saved && subTabs.some(t=>t[0]===saved)) sheetTab = saved; } catch {}
  const portraitIsOwn = char && myChars().some(c => c.id === char.id);
  const portraitImg = char.portrait_url
    ? `<img src="${esc(char.portrait_url)}" class="sheet-portrait" alt="" onerror="this.style.display='none';document.getElementById('sheet-ph').style.display='flex';">
       <div id="sheet-ph" class="sheet-portrait-placeholder" style="display:none;">${initials(sheet.name||char.player_name)}</div>`
    : `<div class="sheet-portrait-placeholder">${initials(sheet.name||char.player_name)}</div>`;
  const portraitActions = portraitIsOwn ? `
    <button class="btn btn-ghost btn-sm portrait-action" onclick="pastePortrait()" title="Paste an image from your clipboard">&#128203; Paste</button>
    <button class="btn btn-ghost btn-sm portrait-action" onclick="triggerPortraitUpload()" title="Upload a portrait file">&#128444; Change</button>` : '';
  const portrait = `<div class="char-portrait-col">${portraitImg}${portraitActions}</div>`;
  // Race info tooltip (ability bonuses / traits / speed) from the synced library
  const raceData = sheet.race ? (_library.races||[]).find(r => (r.name||'').toLowerCase() === (sheet.race||'').toLowerCase()) : null;
  const raceTip = raceData ? [raceData.ability_bonuses, raceData.traits?('Traits: '+String(raceData.traits).replace(/\n/g,', ')):'', raceData.speed?('Speed: '+raceData.speed+' ft'):''].filter(Boolean).join(' — ') : '';
  const raceInfo = raceTip ? ` <span title="${esc(raceTip)}" style="cursor:help;color:var(--accent);">&#9432;</span>` : '';
  const playerLine = (char.display_name && char.display_name !== (sheet.name||'')) ? `<div class="char-player">Player: ${esc(char.display_name)}</div>` : '';
  el.innerHTML = pickerHtml + `
    <div class="card">
      <div class="char-header">
        <div class="char-portrait-wrap">${portrait}</div>
        <div class="char-info">
          <div class="char-name">${esc(sheet.name||char.player_name)}</div>
          <div class="char-sub">Lv${sheet.level||1} ${esc(sheet.class||'')}${sheet.race?' &bull; '+esc(sheet.race)+raceInfo:''}${sheet.background?' &bull; '+esc(sheet.background):''}</div>
          ${playerLine}
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
            <span>Speed <strong>${sheet.speed??30}</strong> ft</span>
            <span>Init <strong>${(sheet.initiative_bonus??0)>=0?'+':''}${sheet.initiative_bonus??0}</strong></span>
            <span>Pass. Perc. <strong>${sheet.passive_perception??'?'}</strong></span>
          </div>
        </div>
      </div>
      ${wChips||aChips?`<div class="chip-row">${wChips}${aChips}</div>`:''}
      ${cChips?`<div class="chip-row">${cChips}</div>`:''}
      ${skillsStrip}
      ${featChips}
      ${spellChips}
    </div>
    <div class="card"><div class="attr-card-title">Attributes</div><div class="attr-grid">${attrs}</div></div>`;
  // Tabs render into a separate host so the persistent dice card can sit between
  // the character specs (above) and the tabbed sections (below).
  const _tabsHost = $('sheet-tabs-host');
  if (_tabsHost) _tabsHost.innerHTML = `
    <div class="card sheet-tabs-card">
      <div class="sheet-tab-bar">${subTabs.map(([id,label,key])=>`<button class="sheet-tab-btn${id===sheetTab?' active':''}" onclick="showSheetTab('${id}')">${label}${key?_badge(id,key):''}</button>`).join('')}</div>
      <div id="sheet-tab-content" class="sheet-tab-content">${renderSheetTabContent(sheet, char)}</div>
    </div>`;
  updateDiceStatButtons(sheet);
  updateDiceQuickRef(sheet);
}

function showSheetTab(name) {
  sheetTab = name;
  try { const c = myChar(); if (c) sessionStorage.setItem('sp_tab_'+c.id, name); } catch {}
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
    case 'skills':     return renderSkills(sheet, char);
    case 'inventory':  return renderInventory(sheet, char);
    case 'weapons':    return renderWeaponsTab(sheet, char);
    case 'armor':      return renderArmorTab(sheet, char);
    case 'currency':   return renderCurrency(sheet, char);
    case 'feats':      return renderFeats(sheet, char);
    case 'spells':     return renderSpells(sheet, char);
    case 'conditions': return renderConditions(sheet, char);
    case 'notes':      return renderNotes(sheet, char);
    case 'attrs':      return renderAttrs(sheet, char);
    case 'reference':  return renderReference(sheet, char);
    default: return '';
  }
}

function renderResources(sheet, char) {
  const res = sheet.resources || [];
  const isOwn = myChars().some(c => c.id === char.id);
  const rows = res.map((r, ri) => {
    const key = `${char.id}:${r.name}`, cur = resourceState[key] ?? r.current, max = r.max || 1;
    const pips = Array.from({length: Math.min(max, 20)}, (_,i) =>
      `<div class="res-pip${i<cur?' filled':''}" onclick="${isOwn?`setResPip('${esc(key)}',${i},${max},${jarg(r.name)})`:''}"></div>`
    ).join('');
    const edit = isOwn ? `<button class="btn-icon" onclick="toggleResEdit('res-edit-${ri}')" title="Edit">&#9998;</button><button class="btn-icon danger" onclick="delRes(${jarg(r.name)})">&#215;</button>` : '';
    const minus = isOwn ? `<button class="btn-icon" onclick="deltaRes('${esc(key)}',-1,${max},${jarg(r.name)})">&#8722;</button>` : '';
    const plus  = isOwn ? `<button class="btn-icon" onclick="deltaRes('${esc(key)}',1,${max},${jarg(r.name)})">+</button>` : '';
    const editForm = isOwn ? `<div id="res-edit-${ri}" style="display:none;margin-top:4px;padding:6px;background:var(--surface2);border-radius:6px;">
      <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
        <input class="input-sm" id="res-edit-name-${ri}" value="${esc(r.name)}" style="flex:1;min-width:100px;" placeholder="Name">
        <input type="number" class="input-sm text-center" id="res-edit-cur-${ri}" value="${cur}" style="width:52px;" placeholder="Cur">
        <input type="number" class="input-sm text-center" id="res-edit-max-${ri}" value="${max}" style="width:52px;" placeholder="Max">
        <button class="btn btn-sm btn-ghost" onclick="saveRes(${jarg(r.name)},'res-edit-name-${ri}','res-edit-cur-${ri}','res-edit-max-${ri}','${esc(key)}')">Save</button>
        <button class="btn btn-sm btn-ghost" onclick="toggleResEdit('res-edit-${ri}')">Cancel</button>
      </div>
    </div>` : '';
    return `<div style="padding:4px 0;border-bottom:1px solid var(--border);">
      <div class="resource-row">
        <span class="resource-name">${esc(r.name)}</span>
        ${minus}<span class="resource-val">${cur}</span>${plus}
        <span class="muted-text">/ ${max}</span>
        <div class="res-pips">${pips}</div>
        ${edit}
      </div>${editForm}
    </div>`;
  }).join('');
  const addForm = isOwn ? `<div class="add-form" style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border);">
    <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:flex-end;">
      <div style="flex:2;min-width:100px;">
        <div style="font-size:.6rem;color:var(--muted);margin-bottom:2px;">Resource name</div>
        <input id="res-new-name" placeholder="e.g. Spell Slots" class="input-sm" style="width:100%;">
      </div>
      <div style="text-align:center;">
        <div style="font-size:.6rem;color:var(--muted);margin-bottom:2px;">Qty.</div>
        <input id="res-new-cur" type="number" class="input-sm text-center" style="width:52px;" value="0">
      </div>
      <div style="text-align:center;">
        <div style="font-size:.6rem;color:var(--muted);margin-bottom:2px;">Total</div>
        <input id="res-new-max" type="number" class="input-sm text-center" style="width:52px;" value="1">
      </div>
      <button class="btn btn-sm btn-ghost" onclick="addRes()">+ Add</button>
    </div>
  </div>` : '';
  return addForm + (rows || '<p class="muted-text" style="padding:6px 0;">No resources.</p>');
}

function deltaRes(key, delta, max, rname) {
  resourceState[key] = Math.max(0, Math.min(max, (resourceState[key] ?? 0) + delta));
  const newVal = resourceState[key];
  const char = myChar();
  if (char) patchSheet(char, s => { const r = (s.resources||[]).find(x=>x.name===rname); if(r) r.current=newVal; });
  mutate('resource_set', { resource_name: rname, current_val: newVal }).catch(() => {});
}
function setResPip(key, idx, max, rname) {
  const cur = resourceState[key] ?? 0;
  resourceState[key] = cur === idx + 1 ? idx : idx + 1;
  const newVal = resourceState[key];
  const char = myChar();
  if (char) patchSheet(char, s => { const r = (s.resources||[]).find(x=>x.name===rname); if(r) r.current=newVal; });
  mutate('resource_set', { resource_name: rname, current_val: newVal }).catch(() => {});
}
function addRes() {
  const name = $('res-new-name')?.value.trim();
  const cur  = parseInt($('res-new-cur')?.value) || 0;
  const max  = parseInt($('res-new-max')?.value) || 1;
  if (!name) return;
  const char = myChar(); if (!char) return;
  patchSheet(char, s => { (s.resources = s.resources||[]).push({name, current: cur, max}); });
  mutate('resource_add', { resource_name: name, current_val: cur, max_val: max }).catch(() => {});
}
function delRes(rname) {
  if (!confirm(`Remove resource "${rname}"?`)) return;
  const char = myChar(); if (!char) return;
  patchSheet(char, s => { s.resources = (s.resources||[]).filter(r=>r.name!==rname); });
  mutate('resource_delete', { resource_name: rname }).catch(() => {});
}
function toggleResEdit(id) {
  const el = $(id); if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}
function saveRes(oldName, nameId, curId, maxId, oldKey) {
  const newName = $(nameId)?.value.trim() || oldName;
  const newMax  = parseInt($(maxId)?.value) || 1;
  const newCur  = Math.min(parseInt($(curId)?.value) || 0, newMax);
  const char = myChar(); if (!char) return;
  patchSheet(char, s => {
    const r = (s.resources||[]).find(x=>x.name===oldName);
    if (r) { r.name=newName; r.max=newMax; r.current=newCur; }
  });
  if (newName !== oldName) delete resourceState[oldKey];
  resourceState[`${char.id}:${newName}`] = newCur;
  mutate('resource_save', { resource_name: oldName, new_name: newName, current_val: newCur, max_val: newMax }).catch(() => {});
}

function renderSkills(sheet, char) {
  const skills = sheet.skills || [];
  const isOwn = myChars().some(c => c.id === char.id);
  const rows = skills.map((s, i) => {
    const profStar = isOwn
      ? `<span class="prof-star" style="cursor:pointer;" onclick="toggleSkillProf(${jarg(s.name)})" title="Toggle proficiency">${s.proficient?'&#9733;':'&#9734;'}</span>`
      : `<span class="prof-star" style="cursor:default;">${s.proficient?'&#9733;':'&#9734;'}</span>`;
    return `<div style="padding:4px 0;border-bottom:1px solid var(--border);">
      <div class="list-row" style="align-items:center;">
        ${profStar}
        <span class="list-name" style="flex:1;">${esc(s.name)}</span>
        <span class="list-value" style="min-width:32px;text-align:right;">${s.bonus>=0?'+':''}${s.bonus}</span>
        ${isOwn?`<button class="btn-icon" onclick="toggleSkillEdit('skill-edit-${i}')" title="Edit">&#9998;</button>
        <button class="btn-icon danger" onclick="delSkill(${jarg(s.name)})">&#215;</button>`:''}
      </div>
      ${isOwn?`<div id="skill-edit-${i}" style="display:none;margin-top:4px;padding:6px;background:var(--surface2);border-radius:6px;">
        <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
          <input class="input-sm" id="skill-edit-name-${i}" value="${esc(s.name)}" style="flex:1;min-width:120px;" placeholder="Skill name">
          <input type="number" class="input-sm text-center" id="skill-edit-bonus-${i}" value="${s.bonus}" style="width:54px;" placeholder="Bonus">
          <label style="display:flex;align-items:center;gap:4px;font-size:.78rem;">
            <input type="checkbox" id="skill-edit-prof-${i}" ${s.proficient?'checked':''}> Prof.
          </label>
          <button class="btn btn-sm btn-ghost" onclick="saveSkill(${jarg(s.name)},'skill-edit-name-${i}','skill-edit-bonus-${i}','skill-edit-prof-${i}')">Save</button>
          <button class="btn btn-sm btn-ghost" onclick="toggleSkillEdit('skill-edit-${i}')">Cancel</button>
        </div>
      </div>`:''}
    </div>`;
  }).join('');

  const addForm = isOwn ? `<div class="add-form" style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border);">
    <div style="position:relative;">
      <input id="skill-new-name" placeholder="Search or type skill…" class="input-sm" style="width:100%;margin-bottom:4px;"
             oninput="libSearchShow('skill-new-name','skill-lib-results','skills')"
             onfocus="libSearchShow('skill-new-name','skill-lib-results','skills')">
      <div id="skill-lib-results" class="lib-results" style="display:none;"></div>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
      <input type="number" id="skill-new-bonus" class="input-sm text-center" style="width:60px;" value="0" placeholder="Bonus">
      <label style="display:flex;align-items:center;gap:4px;font-size:.78rem;">
        <input type="checkbox" id="skill-new-prof"> Prof.
      </label>
      <button class="btn btn-sm btn-ghost" onclick="addSkill()">+ Add</button>
    </div>
  </div>` : '';

  return addForm + (rows || '<p class="muted-text" style="padding:6px 0;">No skills yet.</p>');
}
function toggleSkillEdit(id) {
  const el = $(id); if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}
function toggleSkillProf(sname) {
  const char = myChar(); if (!char) return;
  const sheet = mySheet(); if (!sheet) return;
  const sk = (sheet.skills||[]).find(s=>s.name===sname); if (!sk) return;
  const newProf = !sk.proficient;
  patchSheet(char, s => { const x=(s.skills||[]).find(x=>x.name===sname); if(x) x.proficient=newProf; });
  mutate('skill_save', { skill_name: sname, proficient: newProf, bonus: sk.bonus }).catch(() => {});
}
function saveSkill(oldName, nameId, bonusId, profId) {
  const newName = $(nameId)?.value.trim(); if (!newName) return;
  const bonus = parseInt($(bonusId)?.value) || 0;
  const proficient = !!($(profId)?.checked);
  const char = myChar(); if (!char) return;
  patchSheet(char, s => {
    const x = (s.skills||[]).find(x=>x.name===oldName);
    if (x) { x.name = newName; x.bonus = bonus; x.proficient = proficient; }
  });
  mutate('skill_save', { skill_name: oldName, new_name: newName, bonus, proficient }).catch(() => {});
}
function addSkill() {
  const name = $('skill-new-name')?.value.trim(); if (!name) return;
  const bonus = parseInt($('skill-new-bonus')?.value) || 0;
  const proficient = !!($('skill-new-prof')?.checked);
  const char = myChar(); if (!char) return;
  patchSheet(char, s => { (s.skills=s.skills||[]).push({name, bonus, proficient}); });
  mutate('skill_add', { skill_name: name, bonus, proficient }).catch(() => {});
  if ($('skill-new-name'))  $('skill-new-name').value = '';
  if ($('skill-new-bonus')) $('skill-new-bonus').value = '0';
  if ($('skill-new-prof'))  $('skill-new-prof').checked = false;
}
function delSkill(sname) {
  if (!confirm(`Remove skill "${sname}"?`)) return;
  const char = myChar(); if (!char) return;
  patchSheet(char, s => { s.skills=(s.skills||[]).filter(x=>x.name!==sname); });
  mutate('skill_remove', { skill_name: sname }).catch(() => {});
}

function renderInventory(sheet, char) {
  const inv = sheet.inventory || [];
  const isOwn = myChars().some(c => c.id === char.id);
  const rows = inv.map((i, ii) => {
    const editForm = isOwn ? `<div id="inv-edit-${ii}" style="display:none;margin-top:4px;padding:6px;background:var(--surface2);border-radius:6px;">
      <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-bottom:4px;">
        <input class="input-sm" id="inv-edit-name-${ii}" value="${esc(i.name)}" style="flex:1;min-width:120px;" placeholder="Item name">
        <input type="number" class="input-sm text-center" id="inv-edit-qty-${ii}" value="${i.qty}" style="width:52px;" placeholder="Qty">
        <input class="input-sm" id="inv-edit-weight-${ii}" value="${esc(i.weight||'')}" style="width:60px;" placeholder="Weight">
        <label style="display:flex;align-items:center;gap:4px;font-size:.78rem;"><input type="checkbox" id="inv-edit-eq-${ii}" ${i.equipped?'checked':''}> Equip</label>
      </div>
      <input class="input-sm" id="inv-edit-notes-${ii}" value="${esc(i.notes||'')}" style="width:100%;margin-bottom:4px;" placeholder="Notes">
      <button class="btn btn-sm btn-ghost" onclick="saveInventory(${jarg(i.name)},'inv-edit-name-${ii}','inv-edit-qty-${ii}','inv-edit-weight-${ii}','inv-edit-notes-${ii}','inv-edit-eq-${ii}')">Save</button>
      <button class="btn btn-sm btn-ghost" onclick="toggleInvEdit('inv-edit-${ii}')">Cancel</button>
    </div>` : '';
    return `<div style="padding:4px 0;border-bottom:1px solid var(--border);">
      <div class="list-row">
        ${isOwn?`<span style="cursor:pointer;color:${i.equipped?'var(--accent)':'var(--muted)'};font-size:.7rem;" onclick="toggleEquip('inv',${jarg(i.name)})" title="Toggle equipped">${i.equipped?'[E]':'[ ]'}</span>`:(i.equipped?'<span style="color:var(--accent);font-size:.7rem;">[E]</span>':'')}
        <span class="list-name">${esc(i.name)}</span>
        <span class="list-muted">x${i.qty}${i.weight?' &bull; '+esc(i.weight)+' lb':''}</span>
        ${isOwn?`<button class="btn-icon" onclick="toggleInvEdit('inv-edit-${ii}')" title="Edit">&#9998;</button><button class="btn-icon danger" onclick="delInventory(${jarg(i.name)})">&#215;</button>`:''}
      </div>
      ${i.notes?`<div style="font-size:.72rem;color:var(--muted);font-style:italic;padding-left:18px;">${esc(i.notes)}</div>`:''}
      ${editForm}
    </div>`;
  }).join('');
  const addForm = isOwn ? `<div class="add-form" style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border);">
    <div style="position:relative;">
      <input id="inv-new-name" placeholder="Item name (search equipment &amp; magic items)" class="input-sm" style="width:100%;margin-bottom:4px;" oninput="libSearchShow('inv-new-name','inv-lib-results','inv');invLibPreview()" onfocus="libSearchShow('inv-new-name','inv-lib-results','inv')">
      <div id="inv-lib-results" class="lib-results" style="display:none;"></div>
    </div>
    <div id="inv-lib-preview" style="display:none;margin-bottom:6px;"></div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
      <input id="inv-new-qty" type="number" placeholder="Qty" class="input-sm text-center" style="width:52px;" value="1">
      <input id="inv-new-weight" placeholder="Weight" class="input-sm" style="width:60px;">
      <input id="inv-new-notes" placeholder="Notes" class="input-sm" style="flex:1;min-width:80px;">
      <button class="btn btn-sm btn-ghost" onclick="addInventory()">+ Add</button>
    </div>
  </div>` : '';
  return addForm + (rows || '<p class="muted-text" style="padding:6px 0;">No items.</p>');
}
function toggleInvEdit(id) { const el=$(id); if(el) el.style.display=el.style.display==='none'?'block':'none'; }
function addInventory() {
  const name   = $('inv-new-name')?.value.trim(); if (!name) return;
  const qty    = parseInt($('inv-new-qty')?.value) || 1;
  const weight = $('inv-new-weight')?.value.trim() || '';
  const notes  = $('inv-new-notes')?.value.trim() || '';
  const char = myChar(); if (!char) return;
  patchSheet(char, s => { (s.inventory=s.inventory||[]).push({name,qty,equipped:false,weight,notes}); });
  mutate('inventory_add', { item_name: name, quantity: qty, weight, notes, equipped: false }).catch(() => {});
  if ($('inv-new-name'))   $('inv-new-name').value = '';
  if ($('inv-new-weight')) $('inv-new-weight').value = '';
  if ($('inv-new-notes'))  $('inv-new-notes').value = '';
}
function saveInventory(oldName, nameId, qtyId, weightId, notesId, eqId) {
  const newName = $(nameId)?.value.trim() || oldName;
  const qty     = parseInt($(qtyId)?.value) || 1;
  const weight  = $(weightId)?.value.trim() || '';
  const notes   = $(notesId)?.value.trim() || '';
  const equipped = !!($(eqId)?.checked);
  const char = myChar(); if (!char) return;
  patchSheet(char, s => { const x=(s.inventory||[]).find(i=>i.name===oldName); if(x){x.name=newName;x.qty=qty;x.weight=weight;x.notes=notes;x.equipped=equipped;} });
  mutate('inventory_save', { item_name: oldName, new_name: newName, quantity: qty, weight, notes, equipped }).catch(() => {});
}
function delInventory(iname) {
  if (!confirm(`Remove "${iname}" from inventory?`)) return;
  const char = myChar(); if (!char) return;
  patchSheet(char, s => { s.inventory=(s.inventory||[]).filter(i=>i.name!==iname); });
  mutate('inventory_remove', { item_name: iname }).catch(() => {});
}
function toggleEquip(type, name) {
  const char = myChar(); if (!char) return;
  const sheet = mySheet(); if (!sheet) return;
  if (type === 'inv') {
    const item = (sheet.inventory||[]).find(i=>i.name===name); if (!item) return;
    const newEq = !item.equipped;
    patchSheet(char, s => { const x=(s.inventory||[]).find(i=>i.name===name); if(x) x.equipped=newEq; });
    mutate('inventory_save', { item_name: name, new_name: name, quantity: item.qty, equipped: newEq }).catch(() => {});
  }
}

function renderWeaponsTab(sheet, char) {
  const weapons = sheet.weapons || [];
  const isOwn = myChars().some(c => c.id === char.id);
  const equippedBanner = weapons.filter(w=>w.equipped).map(w=>
    `<span class="chip chip-weapon">&#9741; ${esc(w.name)}${w.damage_dice?` &mdash; ${esc(w.damage_dice)}${w.damage_bonus?'+'+w.damage_bonus:''} ${esc(w.damage_type)}`:''}${w.attack_bonus?` +${w.attack_bonus} to hit`:''}</span>`
  ).join('');
  const banner = equippedBanner ? `<div class="chip-row" style="margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border);">${equippedBanner}</div>` : '';
  const rows = weapons.map((w, wi) => {
    const dmg = w.damage_dice ? `${esc(w.damage_dice)}${w.damage_bonus?'+'+w.damage_bonus:''} ${esc(w.damage_type)}` : '';
    const twoh = w.two_handed_damage_dice ? `2H: ${esc(w.two_handed_damage_dice)} ${esc(w.two_handed_damage_type||'')}` : '';
    const rng = w.range_normal ? `Range ${w.range_normal}/${w.range_long} ft` : '';
    const editForm = isOwn ? `<div id="wpn-edit-${wi}" style="display:none;margin-top:6px;padding:6px;background:var(--surface2);border-radius:6px;">
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px;">
        <input class="input-sm" id="we-name-${wi}" value="${esc(w.name)}" style="flex:1;min-width:120px;" placeholder="Name">
        <input class="input-sm" id="we-dice-${wi}" value="${esc(w.damage_dice||'')}" style="width:80px;" placeholder="Dice">
        <input class="input-sm" id="we-dtype-${wi}" value="${esc(w.damage_type||'')}" style="width:90px;" placeholder="Dmg type">
        <input type="number" class="input-sm text-center" id="we-atk-${wi}" value="${w.attack_bonus||0}" style="width:55px;" placeholder="+ATK">
        <input type="number" class="input-sm text-center" id="we-dmgb-${wi}" value="${w.damage_bonus||0}" style="width:55px;" placeholder="+DMG">
      </div>
      <input class="input-sm" id="we-notes-${wi}" value="${esc(w.notes||'')}" style="width:100%;margin-bottom:4px;" placeholder="Notes">
      <button class="btn btn-sm btn-ghost" onclick="saveWeapon(${jarg(w.name)},'we-name-${wi}','we-dice-${wi}','we-dtype-${wi}','we-atk-${wi}','we-dmgb-${wi}','we-notes-${wi}')">Save</button>
      <button class="btn btn-sm btn-ghost" onclick="toggleWpnEdit('wpn-edit-${wi}')">Cancel</button>
    </div>` : '';
    return `<div style="padding:4px 0;border-bottom:1px solid var(--border);">
      <div class="list-row" style="align-items:flex-start;">
        <span style="cursor:${isOwn?'pointer':'default'};color:${w.equipped?'var(--accent)':'var(--muted)'};font-size:.75rem;margin-top:2px;" ${isOwn?`onclick="toggleWeaponEquip(${jarg(w.name)})" title="${w.equipped?'Stow':'Ready'}"`:''}>${w.equipped?'&#9741;':'&#9675;'}</span>
        <div style="flex:1;">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span class="list-name">${esc(w.name)}</span>
            ${w.category?`<span class="list-muted" style="font-size:.7rem;">${esc(w.category)}${w.range?' &bull; '+esc(w.range):''}</span>`:''}
          </div>
          ${dmg?`<div style="font-size:.75rem;color:var(--muted);">${dmg}${w.attack_bonus?` &bull; +${w.attack_bonus} to hit`:''}${twoh?' &bull; '+twoh:''}${rng?' &bull; '+rng:''}</div>`:''}
          ${w.properties?`<div style="font-size:.7rem;color:var(--muted);font-style:italic;">${wpnPropsHtml(w.properties)}</div>`:''}
          ${w.notes?`<div style="font-size:.7rem;color:var(--muted);font-style:italic;">${esc(w.notes)}</div>`:''}
        </div>
        ${isOwn?`<button class="btn-icon" onclick="toggleWpnEdit('wpn-edit-${wi}')" title="Edit">&#9998;</button><button class="btn-icon danger" onclick="delWeapon(${jarg(w.name)})">&#215;</button>`:''}
      </div>${editForm}
    </div>`;
  }).join('');
  const addForm = isOwn ? `<div class="add-form" style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border);">
    <div style="position:relative;">
      <input id="wpn-new-name" placeholder="Weapon name (search library)" class="input-sm" style="width:100%;margin-bottom:4px;" oninput="libSearchShow('wpn-new-name','wpn-lib-results','weapons');autoFillWeapon()" onfocus="libSearchShow('wpn-new-name','wpn-lib-results','weapons')">
      <div id="wpn-lib-results" class="lib-results" style="display:none;"></div>
    </div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px;">
      <input id="wpn-new-dice" placeholder="Dice (1d8)" class="input-sm" style="width:80px;">
      <input id="wpn-new-type" placeholder="Dmg type" class="input-sm" style="width:90px;">
      <input type="number" id="wpn-new-atk" placeholder="+ATK" class="input-sm text-center" style="width:52px;" value="0">
      <input type="number" id="wpn-new-dmgb" placeholder="+DMG" class="input-sm text-center" style="width:52px;" value="0">
    </div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px;">
      <select id="wpn-new-cat" class="input-sm" style="width:130px;">
        <option value="">Category</option>
        <option>Simple Melee</option><option>Simple Ranged</option>
        <option>Martial Melee</option><option>Martial Ranged</option><option>Other</option>
      </select>
      <select id="wpn-new-rng" class="input-sm" style="width:90px;">
        <option value="">Range type</option>
        <option value="Melee">Melee</option><option value="Ranged">Ranged</option>
      </select>
      <button class="btn btn-sm btn-ghost" onclick="addWeapon()">+ Add</button>
    </div>
  </div>` : '';
  return banner + addForm + (rows || '<p class="muted-text" style="padding:6px 0;">No weapons.</p>');
}
function toggleWpnEdit(id) { const el=$(id); if(el) el.style.display=el.style.display==='none'?'block':'none'; }
function autoFillWeapon() {
  const name = $('wpn-new-name')?.value.trim();
  const found = _library.weapons.find(w => w.name.toLowerCase() === name.toLowerCase());
  if (!found) return;
  const set = (id, val) => { const el=$(id); if(el&&val!=null) el.value=val; };
  set('wpn-new-dice', found.damage_dice);
  set('wpn-new-type', found.damage_type);
  if ($('wpn-new-cat') && found.category) $('wpn-new-cat').value = found.category;
  if ($('wpn-new-rng') && found.range) $('wpn-new-rng').value = found.range;
  _wpnLibFill = found;
}
let _wpnLibFill = null;
function addWeapon() {
  const name  = $('wpn-new-name')?.value.trim(); if (!name) return;
  const dice  = $('wpn-new-dice')?.value.trim() || '';
  const dtype = $('wpn-new-type')?.value.trim() || '';
  const atk   = parseInt($('wpn-new-atk')?.value) || 0;
  const dmgb  = parseInt($('wpn-new-dmgb')?.value) || 0;
  const manualCat = $('wpn-new-cat')?.value || '';
  const manualRng = $('wpn-new-rng')?.value || '';
  const lib   = _wpnLibFill?.name?.toLowerCase() === name.toLowerCase() ? _wpnLibFill : null;
  const char = myChar(); if (!char) return;
  const payload = { weapon_name: name, damage_dice: dice, damage_type: dtype, attack_bonus: atk, damage_bonus: dmgb,
    weapon_category: lib?.category || manualCat, weapon_range: lib?.range || manualRng,
    two_handed_damage_dice: lib?.two_handed_damage_dice||'', two_handed_damage_type: lib?.two_handed_damage_type||'',
    range_normal: lib?.range_normal||0, range_long: lib?.range_long||0,
    properties: lib?.properties||'', notes: lib?.notes||'', equipped: false };
  patchSheet(char, s => { (s.weapons=s.weapons||[]).push({name, ...payload, equipped:false}); });
  mutate('weapon_add', payload).catch(() => {});
  if ($('wpn-new-name')) $('wpn-new-name').value = '';
  _wpnLibFill = null;
}
function saveWeapon(oldName, nameId, diceId, dtypeId, atkId, dmgbId, notesId) {
  const newName = $(nameId)?.value.trim() || oldName;
  const char = myChar(); if (!char) return;
  const data = { weapon_name: oldName, new_name: newName,
    damage_dice: $(diceId)?.value.trim()||'', damage_type: $(dtypeId)?.value.trim()||'',
    attack_bonus: parseInt($(atkId)?.value)||0, damage_bonus: parseInt($(dmgbId)?.value)||0,
    notes: $(notesId)?.value.trim()||'' };
  patchSheet(char, s => { const x=(s.weapons||[]).find(x=>x.name===oldName); if(x) Object.assign(x,{name:newName,damage_dice:data.damage_dice,damage_type:data.damage_type,attack_bonus:data.attack_bonus,damage_bonus:data.damage_bonus,notes:data.notes}); });
  mutate('weapon_save', data).catch(() => {});
}
function delWeapon(wname) {
  if (!confirm(`Remove "${wname}"?`)) return;
  const char = myChar(); if (!char) return;
  patchSheet(char, s => { s.weapons=(s.weapons||[]).filter(w=>w.name!==wname); });
  mutate('weapon_remove', { weapon_name: wname }).catch(() => {});
}
function toggleWeaponEquip(wname) {
  const char = myChar(); if (!char) return;
  const sheet = mySheet(); if (!sheet) return;
  const w = (sheet.weapons||[]).find(x=>x.name===wname); if (!w) return;
  const newEq = !w.equipped;
  patchSheet(char, s => { const x=(s.weapons||[]).find(x=>x.name===wname); if(x) x.equipped=newEq; });
  mutate('weapon_save', { weapon_name: wname, equipped: newEq }).catch(() => {});
}

function _suggestAC(sheet) {
  const dexMod = mod(sheet.dex ?? 10);
  let ac = 0;
  for (const a of (sheet.armor||[]).filter(x=>x.equipped)) {
    if (a.is_shield) { ac += (a.ac_base||0) + (a.ac_bonus||0); }
    else {
      let base = (a.ac_base||0) + (a.ac_bonus||0);
      if (a.dex_bonus) base += (a.max_dex_bonus != null ? Math.min(dexMod, a.max_dex_bonus) : dexMod);
      ac += base;
    }
  }
  return ac;
}
function renderArmorTab(sheet, char) {
  const armor = sheet.armor || [];
  const isOwn = myChars().some(c => c.id === char.id);
  const sugAC = _suggestAC(sheet);
  const acBanner = sugAC ? `<div style="margin-bottom:8px;padding:4px 8px;background:var(--surface2);border-radius:6px;font-size:.8rem;">Suggested AC: <strong style="color:var(--accent);">${sugAC}</strong> <span class="muted-text">(equipped armor + DEX)</span></div>` : '';
  const rows = armor.map((a, ai) => {
    const dexStr = a.dex_bonus ? (a.max_dex_bonus != null ? ` + DEX (max ${a.max_dex_bonus})` : ' + DEX') : '';
    const acStr = `${a.is_shield?'+':''}${(a.ac_base||0)+(a.ac_bonus||0)} AC${dexStr}`;
    const editForm = isOwn ? `<div id="arm-edit-${ai}" style="display:none;margin-top:6px;padding:6px;background:var(--surface2);border-radius:6px;">
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px;">
        <input class="input-sm" id="ae-name-${ai}" value="${esc(a.name)}" style="flex:1;min-width:120px;" placeholder="Name">
        <input type="number" class="input-sm text-center" id="ae-acb-${ai}" value="${a.ac_bonus||0}" style="width:60px;" placeholder="Magic +AC">
      </div>
      <input class="input-sm" id="ae-notes-${ai}" value="${esc(a.notes||'')}" style="width:100%;margin-bottom:4px;" placeholder="Notes">
      <button class="btn btn-sm btn-ghost" onclick="saveArmor(${jarg(a.name)},'ae-name-${ai}','ae-acb-${ai}','ae-notes-${ai}')">Save</button>
      <button class="btn btn-sm btn-ghost" onclick="toggleArmEdit('arm-edit-${ai}')">Cancel</button>
    </div>` : '';
    return `<div style="padding:4px 0;border-bottom:1px solid var(--border);">
      <div class="list-row">
        <span style="cursor:${isOwn?'pointer':'default'};color:${a.equipped?'var(--accent)':'var(--muted)'};font-size:.75rem;" ${isOwn?`onclick="toggleArmorEquip(${jarg(a.name)})" title="${a.equipped?'Unequip':'Equip'}"`:''}>${a.equipped?'&#9741;':'&#9675;'}</span>
        <span class="list-name">${esc(a.name)}</span>
        <span class="list-muted">${esc(a.category||'')}</span>
        <span class="list-value">${acStr}</span>
        ${isOwn?`<button class="btn-icon" onclick="toggleArmEdit('arm-edit-${ai}')" title="Edit">&#9998;</button><button class="btn-icon danger" onclick="delArmor(${jarg(a.name)})">&#215;</button>`:''}
      </div>
      ${a.notes?`<div style="font-size:.7rem;color:var(--muted);font-style:italic;padding-left:18px;">${esc(a.notes)}</div>`:''}
      ${editForm}
    </div>`;
  }).join('');
  const addForm = isOwn ? `<div class="add-form" style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border);">
    <div style="position:relative;">
      <input id="arm-new-name" placeholder="Armor name (search library)" class="input-sm" style="width:100%;margin-bottom:4px;" oninput="libSearchShow('arm-new-name','arm-lib-results','armor');autoFillArmor()" onfocus="libSearchShow('arm-new-name','arm-lib-results','armor')">
      <div id="arm-lib-results" class="lib-results" style="display:none;"></div>
    </div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;">
      <input id="arm-new-ac" type="number" placeholder="AC" class="input-sm text-center" style="width:52px;" value="10">
      <input id="arm-new-cat" placeholder="Category" class="input-sm" style="width:90px;" value="">
      <button class="btn btn-sm btn-ghost" onclick="addArmor()">+ Add</button>
    </div>
  </div>` : '';
  return acBanner + addForm + (rows || '<p class="muted-text" style="padding:6px 0;">No armor.</p>');
}
function toggleArmEdit(id) { const el=$(id); if(el) el.style.display=el.style.display==='none'?'block':'none'; }
let _armLibFill = null;
function autoFillArmor() {
  const name = $('arm-new-name')?.value.trim();
  const found = _library.armor.find(a => a.name.toLowerCase() === name.toLowerCase());
  if (!found) return;
  if ($('arm-new-ac') && found.ac_base != null) $('arm-new-ac').value = found.ac_base;
  if ($('arm-new-cat') && found.category) $('arm-new-cat').value = found.category;
  _armLibFill = found;
}
function addArmor() {
  const name = $('arm-new-name')?.value.trim(); if (!name) return;
  const ac   = parseInt($('arm-new-ac')?.value) || 0;
  const cat  = $('arm-new-cat')?.value.trim() || '';
  const lib  = _armLibFill?.name?.toLowerCase() === name.toLowerCase() ? _armLibFill : null;
  const char = myChar(); if (!char) return;
  const payload = { armor_name: name, armor_category: cat, ac_base: ac, ac_bonus: 0,
    dex_bonus: lib?.dex_bonus ?? false, max_dex_bonus: lib?.max_dex_bonus ?? null,
    notes: lib?.notes || '', equipped: false };
  patchSheet(char, s => { (s.armor=s.armor||[]).push({name,category:cat,ac_base:ac,ac_bonus:0,dex_bonus:payload.dex_bonus,max_dex_bonus:payload.max_dex_bonus,notes:payload.notes,equipped:false,is_shield:cat==='Shield'}); });
  mutate('armor_add', payload).catch(() => {});
  if ($('arm-new-name')) $('arm-new-name').value = '';
  _armLibFill = null;
}
function saveArmor(oldName, nameId, acbId, notesId) {
  const newName = $(nameId)?.value.trim() || oldName;
  const acBonus = parseInt($(acbId)?.value) || 0;
  const notes   = $(notesId)?.value.trim() || '';
  const char = myChar(); if (!char) return;
  patchSheet(char, s => { const x=(s.armor||[]).find(x=>x.name===oldName); if(x){x.name=newName;x.ac_bonus=acBonus;x.notes=notes;} });
  mutate('armor_save', { armor_name: oldName, new_name: newName, ac_bonus: acBonus, notes }).catch(() => {});
}
function delArmor(aname) {
  if (!confirm(`Remove "${aname}"?`)) return;
  const char = myChar(); if (!char) return;
  patchSheet(char, s => { s.armor=(s.armor||[]).filter(a=>a.name!==aname); });
  mutate('armor_remove', { armor_name: aname }).catch(() => {});
}
function toggleArmorEquip(aname) {
  const char = myChar(); if (!char) return;
  const sheet = mySheet(); if (!sheet) return;
  const a = (sheet.armor||[]).find(x=>x.name===aname); if (!a) return;
  const newEq = !a.equipped;
  patchSheet(char, s => { const x=(s.armor||[]).find(x=>x.name===aname); if(x) x.equipped=newEq; });
  mutate('armor_save', { armor_name: aname, equipped: newEq }).catch(() => {});
}

function renderCurrency(sheet, char) {
  const isOwn = myChars().some(c => c.id === char.id);
  if (!isOwn) {
    return `<div class="currency-grid">
      <div class="currency-item"><div class="currency-label">Gold</div><div class="currency-val">${sheet.gold??0}</div></div>
      <div class="currency-item"><div class="currency-label">Silver</div><div class="currency-val">${sheet.silver??0}</div></div>
      <div class="currency-item"><div class="currency-label">Copper</div><div class="currency-val">${sheet.copper??0}</div></div>
    </div>`;
  }
  return `<div class="currency-grid">
    <div class="currency-item"><div class="currency-label">Gold</div><input id="cur-gold" type="number" class="input-sm text-center" style="width:80px;" value="${sheet.gold??0}" onchange="saveCurrency()"></div>
    <div class="currency-item"><div class="currency-label">Silver</div><input id="cur-silver" type="number" class="input-sm text-center" style="width:80px;" value="${sheet.silver??0}" onchange="saveCurrency()"></div>
    <div class="currency-item"><div class="currency-label">Copper</div><input id="cur-copper" type="number" class="input-sm text-center" style="width:80px;" value="${sheet.copper??0}" onchange="saveCurrency()"></div>
  </div>`;
}
function saveCurrency() {
  const gold   = parseInt($('cur-gold')?.value)   || 0;
  const silver = parseInt($('cur-silver')?.value) || 0;
  const copper = parseInt($('cur-copper')?.value) || 0;
  const char = myChar(); if (!char) return;
  patchSheet(char, s => { s.gold=gold; s.silver=silver; s.copper=copper; });
  mutate('attr_save', { gold, silver, copper }).catch(() => {});
}

function renderFeats(sheet, char) {
  const feats = sheet.feats || [];
  const isOwn = myChars().some(c => c.id === char.id);
  const rows = feats.map((f, i) =>
    `<div style="padding:6px 0;border-bottom:1px solid var(--border);">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="color:var(--accent);font-weight:600;font-size:.85rem;">${esc(f.name)}</span>
        ${isOwn?`<div style="display:flex;gap:4px;">
          <button class="btn-icon" onclick="toggleFeatEdit('feat-edit-${i}')" title="Edit">&#9998;</button>
          <button class="btn-icon danger" onclick="delFeat(${jarg(f.name)})">&#215;</button>
        </div>`:''}
      </div>
      ${f.description?`<div style="color:var(--muted);font-size:.75rem;margin-top:2px;white-space:pre-wrap;">${esc(f.description)}</div>`:''}
      ${isOwn?`<div id="feat-edit-${i}" style="display:none;margin-top:6px;">
        <input class="input-sm" id="feat-edit-name-${i}" value="${esc(f.name)}" style="width:100%;margin-bottom:4px;">
        <textarea class="input-sm" id="feat-edit-desc-${i}" style="width:100%;height:60px;margin-bottom:4px;resize:vertical;">${esc(f.description||'')}</textarea>
        <button class="btn btn-sm btn-ghost" onclick="saveFeat(${jarg(f.name)},'feat-edit-name-${i}','feat-edit-desc-${i}')">Save</button>
      </div>`:''}
    </div>`
  ).join('');
  const addForm = isOwn ? `<div class="add-form" style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border);">
    <div style="position:relative;">
      <input id="feat-new-name" placeholder="Feat name (search library)" class="input-sm" style="width:100%;margin-bottom:4px;" oninput="libSearchShow('feat-new-name','feat-lib-results','feats');autoFillFeat()" onfocus="libSearchShow('feat-new-name','feat-lib-results','feats')">
      <div id="feat-lib-results" class="lib-results" style="display:none;"></div>
    </div>
    <textarea id="feat-new-desc" placeholder="Description (auto-fills from library)" class="input-sm" style="width:100%;height:60px;margin-bottom:4px;resize:vertical;"></textarea>
    <button class="btn btn-sm btn-ghost" onclick="addFeat()">+ Add Feat</button>
  </div>` : '';
  return addForm + (rows || '<p class="muted-text" style="padding:6px 0;">No feats.</p>');
}
function toggleFeatEdit(id) {
  const el = $(id); if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}
function autoFillFeat() {
  const name = $('feat-new-name')?.value.trim();
  const found = _library.feats.find(f => f.name.toLowerCase() === name.toLowerCase());
  if (found && $('feat-new-desc') && !$('feat-new-desc').value) {
    $('feat-new-desc').value = found.description || '';
  }
}
function addFeat() {
  const name = $('feat-new-name')?.value.trim(); if (!name) return;
  const desc = $('feat-new-desc')?.value.trim() || '';
  const char = myChar(); if (!char) return;
  patchSheet(char, s => { (s.feats=s.feats||[]).push({name,description:desc}); });
  mutate('feat_add', { feat_name: name, description: desc }).catch(() => {});
  if ($('feat-new-name')) $('feat-new-name').value = '';
  if ($('feat-new-desc')) $('feat-new-desc').value = '';
}
function delFeat(fname) {
  if (!confirm(`Remove feat "${fname}"?`)) return;
  const char = myChar(); if (!char) return;
  patchSheet(char, s => { s.feats=(s.feats||[]).filter(f=>f.name!==fname); });
  mutate('feat_remove', { feat_name: fname }).catch(() => {});
}
function saveFeat(oldName, nameId, descId) {
  const newName = $(nameId)?.value.trim(); if (!newName) return;
  const newDesc = $(descId)?.value.trim() || '';
  const char = myChar(); if (!char) return;
  patchSheet(char, s => {
    const f = (s.feats||[]).find(x => x.name === oldName);
    if (f) { f.name = newName; f.description = newDesc; }
  });
  mutate('feat_save', { feat_name: oldName, new_name: newName, description: newDesc }).catch(() => {});
}

function renderSpells(sheet, char) {
  const spells = sheet.spells || [];
  const isOwn = myChars().some(c => c.id === char.id);
  const byLevel = {};
  for (const s of spells) { const l = s.level??s.spell_level??0; (byLevel[l]||(byLevel[l]=[])).push(s); }
  const lvlLabel = l => l===0?'Cantrips':l===1?'1st Level':l===2?'2nd Level':l===3?'3rd Level':l+'th Level';
  const rows = Object.keys(byLevel).sort((a,b)=>+a-+b).map(l =>
    `<div class="spell-level-header">${lvlLabel(Number(l))}</div>` +
    byLevel[l].map((s, si) => {
      const sid = `spl-${l}-${si}`;
      const prepToggle = isOwn ? `<span style="cursor:pointer;" onclick="toggleSpellPrepared(${jarg(s.name)})" title="Toggle prepared">` : `<span>`;
      const meta = [s.casting_time?`&#9203; ${esc(s.casting_time)}`:'', s.range?`&#128207; ${esc(s.range)}`:'', s.duration?`&#9711; ${esc(s.duration)}`:'', s.concentration?'<strong>Concentration</strong>':'', s.ritual?'<em>Ritual</em>':''].filter(Boolean).join(' &bull; ');
      const editNotes = isOwn ? `<div id="${sid}-edit" style="display:none;margin-top:4px;">
        <input class="input-sm" id="${sid}-notes-inp" value="${esc(s.notes||'')}" style="width:100%;margin-bottom:3px;" placeholder="Notes">
        <button class="btn btn-sm btn-ghost" onclick="saveSpellNotes(${jarg(s.name)},'${sid}-notes-inp')">Save</button>
        <button class="btn btn-sm btn-ghost" onclick="toggleSpellEdit('${sid}-edit')">Cancel</button>
      </div>` : '';
      return `<div class="spell-row${s.prepared?' prepared-card':''}" style="flex-direction:column;align-items:stretch;padding:5px 0;">
        <div style="display:flex;align-items:center;gap:4px;">
          ${prepToggle}<span class="${s.prepared?'spell-prepared':'spell-unprepared'}">${s.prepared?'&#9670;':'&#9671;'}</span></span>
          <span class="spell-name" style="flex:1;">${esc(s.name)}</span>
          ${s.school?`<span class="spell-school">${esc(s.school)}</span>`:''}
          ${isOwn?`<button class="btn-icon" onclick="toggleSpellEdit('${sid}-edit')" title="Notes">&#9998;</button>`:''}
          ${s.description?`<button class="btn-icon" onclick="toggleSpellDesc('${sid}-desc')" title="Description">&#9432;</button>`:''}
          ${isOwn?`<button class="btn-icon danger" onclick="delSpell(${jarg(s.name)})">&#215;</button>`:''}
        </div>
        ${meta?`<div style="font-size:.7rem;color:var(--muted);padding-left:16px;margin-top:1px;">${meta}</div>`:''}
        ${s.components?`<div style="font-size:.7rem;color:var(--muted);font-style:italic;padding-left:16px;">${esc(s.components)}</div>`:''}
        ${s.classes?`<div style="font-size:.68rem;color:var(--muted);padding-left:16px;">Classes: ${esc(s.classes)}</div>`:''}
        ${s.notes?`<div style="font-size:.72rem;color:var(--muted);padding-left:16px;"><em>${esc(s.notes)}</em></div>`:''}
        ${s.description?`<div id="${sid}-desc" style="display:none;font-size:.75rem;color:var(--muted);padding:4px 0 2px 16px;white-space:pre-wrap;border-top:1px solid var(--border);margin-top:3px;">${esc(s.description)}</div>`:''}
        ${editNotes}
      </div>`;
    }).join('')
  ).join('');
  const addForm = isOwn ? `<div class="add-form" style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border);">
    <div style="position:relative;">
      <input id="spl-new-name" placeholder="Spell name (search library)" class="input-sm" style="width:100%;margin-bottom:4px;" oninput="libSearchShow('spl-new-name','spl-lib-results','spells');autoFillSpell()" onfocus="libSearchShow('spl-new-name','spl-lib-results','spells')">
      <div id="spl-lib-results" class="lib-results" style="display:none;"></div>
    </div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
      <input id="spl-new-lvl" type="number" placeholder="Lvl" class="input-sm text-center" style="width:50px;" min="0" max="9" value="1">
      <select id="spl-new-school" class="input-sm" style="width:130px;">
        <option value="">School</option>
        <option>Abjuration</option><option>Conjuration</option><option>Divination</option>
        <option>Enchantment</option><option>Evocation</option><option>Illusion</option>
        <option>Necromancy</option><option>Transmutation</option>
      </select>
      <label style="font-size:.75rem;"><input type="checkbox" id="spl-new-prep"> Prepared</label>
      <button class="btn btn-sm btn-ghost" onclick="addSpell()">+ Add Spell</button>
    </div>
  </div>` : '';
  return addForm + (rows || '<p class="muted-text" style="padding:6px 0;">No spells.</p>');
}
function toggleSpellEdit(id) { const el=$(id); if(el) el.style.display=el.style.display==='none'?'block':'none'; }
function toggleSpellDesc(id) { const el=$(id); if(el) el.style.display=el.style.display==='none'?'block':'none'; }
function saveSpellNotes(sname, inputId) {
  const notes = $(inputId)?.value.trim() || '';
  const char = myChar(); if (!char) return;
  patchSheet(char, s => { const x=(s.spells||[]).find(x=>x.name===sname); if(x) x.notes=notes; });
  mutate('spell_save', { spell_name: sname, notes }).catch(() => {});
}
let _splLibFill = null;
function autoFillSpell() {
  const name = $('spl-new-name')?.value.trim();
  const found = _library.spells.find(s => s.name.toLowerCase() === name.toLowerCase());
  if (!found) return;
  if ($('spl-new-lvl') && found.level != null) $('spl-new-lvl').value = found.level;
  if ($('spl-new-school') && found.school) {
    const sel = $('spl-new-school');
    const opt = [...sel.options].find(o => o.value === found.school);
    if (opt) sel.value = found.school; else sel.value = '';
  }
  _splLibFill = found;
}
function addSpell() {
  const name   = $('spl-new-name')?.value.trim(); if (!name) return;
  const level  = parseInt($('spl-new-lvl')?.value) || 0;
  const school = $('spl-new-school')?.value.trim() || '';
  const prep   = !!$('spl-new-prep')?.checked;
  const char = myChar(); if (!char) return;
  patchSheet(char, s => { (s.spells=s.spells||[]).push({name,level,spell_level:level,school,prepared:prep,notes:''}); });
  mutate('spell_add', { spell_name: name, spell_level: level, school, prepared: prep }).catch(() => {});
  if ($('spl-new-name')) $('spl-new-name').value = '';
  _splLibFill = null;
}
function toggleSpellPrepared(sname) {
  const char = myChar(); if (!char) return;
  const sheet = mySheet(); if (!sheet) return;
  const s = (sheet.spells||[]).find(x=>x.name===sname); if (!s) return;
  const newPrep = !s.prepared;
  patchSheet(char, sh => { const x=(sh.spells||[]).find(x=>x.name===sname); if(x) x.prepared=newPrep; });
  mutate('spell_save', { spell_name: sname, prepared: newPrep }).catch(() => {});
}
function delSpell(sname) {
  if (!confirm(`Remove "${sname}"?`)) return;
  const char = myChar(); if (!char) return;
  patchSheet(char, s => { s.spells=(s.spells||[]).filter(x=>x.name!==sname); });
  mutate('spell_remove', { spell_name: sname }).catch(() => {});
}

function renderConditions(sheet, char) {
  const conds = sheet.conditions || [];
  const isOwn = myChars().some(c => c.id === char.id);
  const activeChips = conds.length
    ? `<div style="margin-bottom:8px;">${conds.map(c => `<span class="cond-chip">&#9763; ${esc(c)}${isOwn?`<button class="btn-icon" style="margin-left:3px;font-size:.65rem;" onclick="removeCond(${jarg(c)})">&#215;</button>`:''}</span>`).join('')}</div>`
    : `<p class="muted-text" style="padding:4px 0 8px;">No active conditions.</p>`;
  if (!isOwn) return activeChips;
  const condBtns = STD_CONDITIONS.map(c => {
    const active = conds.includes(c);
    const desc = condDesc(c) ? `${c}: ${condDesc(c)}` : c;
    return `<button class="btn btn-sm${active?' btn-cond-active':' btn-ghost'}" style="margin:2px;font-size:.72rem;" onclick="toggleCond(${jarg(c)})" title="${esc(desc)}">${c}</button>`;
  }).join('');
  return `${activeChips}<div style="display:flex;flex-wrap:wrap;gap:2px;">${condBtns}</div>`;
}
function toggleCond(cname) {
  const char = myChar(); if (!char) return;
  const sheet = mySheet(); if (!sheet) return;
  const conds = sheet.conditions || [];
  if (conds.includes(cname)) {
    patchSheet(char, s => { s.conditions=(s.conditions||[]).filter(c=>c!==cname); });
    mutate('condition_remove', { condition: cname }).catch(() => {});
  } else {
    patchSheet(char, s => { (s.conditions=s.conditions||[]).push(cname); });
    mutate('condition_add', { condition: cname }).catch(() => {});
  }
}
function removeCond(cname) {
  const char = myChar(); if (!char) return;
  patchSheet(char, s => { s.conditions=(s.conditions||[]).filter(c=>c!==cname); });
  mutate('condition_remove', { condition: cname }).catch(() => {});
}

function renderNotes(sheet, char) {
  const notes = [...(sheet.notes || [])].reverse();
  const isOwn = myChars().some(c => c.id === char.id);
  const rows = notes.map((n, ni) => {
    const editForm = isOwn ? `<div id="note-edit-${ni}" style="display:none;margin-top:4px;">
      <textarea class="input-sm" id="note-edit-text-${ni}" style="width:100%;height:60px;resize:vertical;margin-bottom:3px;">${esc(n.text)}</textarea>
      <button class="btn btn-sm btn-ghost" onclick="saveNote(${jarg(n.created_at)},'note-edit-text-${ni}')">Save</button>
      <button class="btn btn-sm btn-ghost" onclick="toggleNoteEdit('note-edit-${ni}')">Cancel</button>
    </div>` : '';
    return `<div style="padding:6px 0;border-bottom:1px solid var(--border);">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;">
        <div style="flex:1;">
          <div style="white-space:pre-wrap;font-size:.8rem;">${esc(n.text)}</div>
          <div style="font-size:.68rem;color:var(--muted);margin-top:2px;">${esc(n.created_at||'')}</div>
        </div>
        ${isOwn?`<div style="display:flex;gap:2px;flex-shrink:0;">
          <button class="btn-icon" onclick="toggleNoteEdit('note-edit-${ni}')" title="Edit">&#9998;</button>
          <button class="btn-icon danger" onclick="delNote(${jarg(n.created_at)})">&#215;</button>
        </div>`:''}
      </div>${editForm}
    </div>`;
  }).join('');
  const addForm = isOwn ? `<div class="add-form" style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border);">
    <textarea id="note-new-text" placeholder="Add a note..." class="input-sm" style="width:100%;height:70px;margin-bottom:4px;resize:vertical;"></textarea>
    <button class="btn btn-sm btn-ghost" onclick="addNote()">+ Add Note</button>
  </div>` : '';
  return addForm + (rows || '<p class="muted-text" style="padding:6px 0;">No notes.</p>');
}
function toggleNoteEdit(id) { const el=$(id); if(el) el.style.display=el.style.display==='none'?'block':'none'; }
function addNote() {
  const text = $('note-new-text')?.value.trim(); if (!text) return;
  const char = myChar(); if (!char) return;
  const now = new Date().toISOString().replace('T',' ').slice(0,19);
  patchSheet(char, s => { (s.notes=s.notes||[]).push({text, created_at: now}); });
  mutate('note_add', { text, created_at: now }).catch(() => {});
  if ($('note-new-text')) $('note-new-text').value = '';
}
function saveNote(created_at, inputId) {
  const text = $(inputId)?.value.trim(); if (!text) return;
  const char = myChar(); if (!char) return;
  patchSheet(char, s => { const n=(s.notes||[]).find(x=>x.created_at===created_at); if(n) n.text=text; });
  mutate('note_save', { created_at, text }).catch(() => {});
}
function delNote(created_at) {
  if (!confirm('Delete this note?')) return;
  const char = myChar(); if (!char) return;
  // Look the text up here (for the receiver's fallback match) instead of passing
  // free note text through the onclick attribute, where a " would break it.
  const cur = mySheet();
  const note = (cur?.notes || []).find(n => n.created_at === created_at);
  const text = note ? note.text : '';
  patchSheet(char, s => { s.notes=(s.notes||[]).filter(n=>n.created_at!==created_at); });
  mutate('note_remove', { created_at, text }).catch(() => {});
}

function invLibPreview() {
  const name = $('inv-new-name')?.value.trim();
  const el = $('inv-lib-preview');
  if (!el) return;
  const eq    = name ? (_library.equipment || []).find(e => e.name.toLowerCase() === name.toLowerCase()) : null;
  const magic = !eq && name ? (_library.magic_items || []).find(m => m.name.toLowerCase() === name.toLowerCase()) : null;
  const found = eq || magic;
  if (!found) { el.style.display = 'none'; return; }
  if ($('inv-new-weight') && found.weight != null) $('inv-new-weight').value = found.weight;
  if (magic && $('inv-new-notes') && !$('inv-new-notes').value.trim()) {
    // rarity/attunement + description ride into the item's notes so the text
    // stays on the sheet (mirrors the local server's magic-item pick)
    const sub = [magic.category, magic.rarity, magic.attunement ? 'Requires attunement' : '']
      .filter(Boolean).join(' • ');
    const d = magic.description || '';
    $('inv-new-notes').value = [sub, d.slice(0, 240) + (d.length > 240 ? '…' : '')]
      .filter(Boolean).join(' — ');
  }
  const tagline = magic
    ? [magic.rarity, magic.attunement ? 'Requires attunement' : ''].filter(Boolean).join(' • ')
    : '';
  el.innerHTML = `<div style="background:var(--surface2);border-radius:6px;padding:6px 10px;font-size:.8rem;display:flex;justify-content:space-between;align-items:flex-start;gap:6px;">
    <div>
      <strong style="color:var(--accent);">${magic ? '&#10022; ' : ''}${esc(found.name)}</strong>
      ${found.category ? `<span class="list-muted" style="margin-left:6px;">${esc(found.category)}</span>` : ''}
      ${tagline ? `<span class="list-muted" style="margin-left:6px;">${esc(tagline)}</span>` : ''}
      ${found.weight != null ? `<span class="list-muted" style="margin-left:6px;">${found.weight} lb</span>` : ''}
      ${found.cost ? `<span class="list-muted" style="margin-left:6px;">${esc(found.cost)}</span>` : ''}
      ${found.description ? `<div style="font-size:.72rem;color:var(--muted);margin-top:3px;white-space:pre-wrap;">${esc(found.description)}</div>` : ''}
    </div>
    <button class="btn-icon" onclick="$('inv-lib-preview').style.display='none'">&#215;</button>
  </div>`;
  el.style.display = '';
}

function renderReference(sheet, char) {
  const raceName = sheet.race || '';
  const className = sheet.class || '';
  const raceData = _library.races.find(r => r.name.toLowerCase() === raceName.toLowerCase());
  const classData = _library.classes.find(c => c.name.toLowerCase() === className.toLowerCase());

  const raceCard = raceData
    ? `<div class="card" style="margin-bottom:0;">
        <div class="card-title">&#127965; Race: ${esc(raceData.name)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px 14px;font-size:.8rem;margin-bottom:6px;">
          ${raceData.speed ? `<span><span class="list-muted">Speed</span> <strong>${raceData.speed} ft</strong></span>` : ''}
          ${raceData.size  ? `<span><span class="list-muted">Size</span> <strong>${esc(raceData.size)}</strong></span>` : ''}
        </div>
        ${raceData.ability_bonuses ? `<div style="font-size:.78rem;margin-bottom:5px;"><span class="list-muted">Ability Bonuses:</span> ${esc(raceData.ability_bonuses)}</div>` : ''}
        ${raceData.traits ? `<div style="font-size:.76rem;color:var(--muted);white-space:pre-wrap;">${esc(raceData.traits)}</div>` : ''}
      </div>`
    : raceName
      ? `<div class="card" style="margin-bottom:0;"><div class="card-title">&#127965; Race: ${esc(raceName)}</div><p class="muted-text" style="font-size:.78rem;">(not in library)</p></div>`
      : '';

  const classCard = classData
    ? `<div class="card" style="margin-bottom:0;">
        <div class="card-title">&#9878; Class: ${esc(classData.name)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px 14px;font-size:.8rem;margin-bottom:6px;">
          ${classData.hit_die ? `<span><span class="list-muted">Hit Die</span> <strong>d${classData.hit_die}</strong></span>` : ''}
          ${classData.spellcasting_ability ? `<span><span class="list-muted">Spellcasting</span> <strong>${esc(classData.spellcasting_ability)}</strong></span>` : ''}
        </div>
        ${classData.saving_throws ? `<div style="font-size:.78rem;margin-bottom:5px;"><span class="list-muted">Saving Throws:</span> ${esc(classData.saving_throws)}</div>` : ''}
        ${classData.description ? `<div style="font-size:.76rem;color:var(--muted);white-space:pre-wrap;">${esc(classData.description)}</div>` : ''}
      </div>`
    : className
      ? `<div class="card" style="margin-bottom:0;"><div class="card-title">&#9878; Class: ${esc(className)}</div><p class="muted-text" style="font-size:.78rem;">(not in library)</p></div>`
      : '';

  // Class features & progression for THIS character's class and level, from the
  // features / class_levels libraries the GM synced from the D&D API.
  // Subclass features join in once the player picks an archetype in Attributes.
  const lvl = sheet.level || 1;
  const subName = (sheet.subclass || '').toLowerCase();
  const rawFeatures = className
    ? (_library.features || []).filter(f =>
        (f.class || '').toLowerCase() === className.toLowerCase() &&
        (!f.subclass || (f.subclass || '').toLowerCase() === subName) &&
        (f.level || 0) <= lvl)
    : [];
  // Collapse same-name duplicates from the two API editions, keeping the
  // fuller text (mirrors the local sheet's dedupe).
  const bestFeat = {};
  for (const f of rawFeatures) {
    const key = `${f.level}|${(f.name || '').toLowerCase()}|${(f.subclass || '').toLowerCase()}`;
    if (!bestFeat[key] || (f.description || '').length > (bestFeat[key].description || '').length)
      bestFeat[key] = f;
  }
  const myFeatures = Object.values(bestFeat)
    .sort((a, b) => (a.level - b.level) || (a.name || '').localeCompare(b.name || ''));
  const myLevelRow = className
    ? (_library.class_levels || []).find(r =>
        (r.class || '').toLowerCase() === className.toLowerCase() && r.level === lvl)
    : null;
  let progression = '';
  if (myLevelRow) {
    const slots = Object.entries(myLevelRow.spell_slots || {})
      .filter(([, n]) => n > 0)
      .sort(([a], [b]) => a - b)
      .map(([l, n]) => `<span class="chip" style="font-size:.7rem;">L${l}&times;${n}</span>`).join(' ');
    progression = `<div style="display:flex;flex-wrap:wrap;gap:6px 14px;font-size:.78rem;align-items:center;margin-bottom:6px;">
      <span><span class="list-muted">Prof. bonus</span> <strong>+${myLevelRow.prof_bonus || 2}</strong></span>
      ${slots ? `<span><span class="list-muted">Spell slots</span> ${slots}</span>` : ''}
      ${myLevelRow.cantrips_known ? `<span class="list-muted">${myLevelRow.cantrips_known} cantrips</span>` : ''}
      ${myLevelRow.spells_known ? `<span class="list-muted">${myLevelRow.spells_known} spells known</span>` : ''}
    </div>`;
  }
  const featuresCard = (myFeatures.length || progression)
    ? `<div class="card" style="margin-bottom:0;">
        <div class="card-title">&#128214; ${esc(className)}${sheet.subclass ? ' (' + esc(sheet.subclass) + ')' : ''} ${lvl} &mdash; Features</div>
        ${progression}
        ${myFeatures.map(f => `
          <details style="margin-bottom:4px;">
            <summary style="cursor:pointer;font-size:.8rem;">
              <span class="list-muted" style="font-size:.7rem;">L${f.level}</span>
              <strong style="color:var(--accent);">${esc(f.name)}</strong>
              ${f.subclass ? `<span class="chip" style="font-size:.65rem;">${esc(f.subclass)}</span>` : ''}
            </summary>
            <div style="font-size:.74rem;color:var(--muted);white-space:pre-wrap;padding:4px 0 2px 12px;">${esc(f.description || '')}</div>
          </details>`).join('')}
      </div>`
    : '';

  const libTypes = [
    ['armor','Armor'],['features','Class Features'],['classes','Classes'],
    ['conditions','Conditions'],['equipment','Equipment'],['feats','Feats'],
    ['magic_items','Magic Items'],['races','Races'],['rules','Rules'],
    ['skills','Skills'],['spells','Spells'],['subclasses','Subclasses'],
    ['traits','Traits'],['weapon_properties','Weapon Properties'],
    ['weapons','Weapons'],
  ];
  const libAccordion = `<div class="card" style="margin-bottom:0;">
    <div class="card-title">&#128218; Browse Libraries</div>
    ${libTypes.map(([type, label]) => `
      <div class="ref-section">
        <button class="ref-section-btn" onclick="toggleRefSection('ref-${type}')">
          <span>${label} <span class="list-muted" style="font-size:.72rem;">(${(_library[type]||[]).length})</span></span>
          <span style="font-size:.8rem;">&#9660;</span>
        </button>
        <div id="ref-${type}" style="display:none;padding:4px 0 8px;">
          <input placeholder="Search ${label}…" class="input-sm" style="width:100%;margin-bottom:4px;"
            oninput="refSearch('${type}','ref-res-${type}',this.value)"
            onfocus="refSearch('${type}','ref-res-${type}',this.value)">
          <div id="ref-res-${type}" class="ref-results"></div>
        </div>
      </div>`).join('')}
  </div>`;

  return [raceCard, classCard, featuresCard, libAccordion].filter(Boolean).join('<div style="height:8px;"></div>') ||
    '<p class="muted-text" style="padding:6px 0;">Set your race and class in the Attributes tab to see details here.</p>';
}

function toggleRefSection(id) {
  const el = $(id); if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function refSearch(type, targetId, q) {
  const el = $(targetId); if (!el) return;
  const matches = libSearch(type, q.trim());
  if (!matches.length) { el.innerHTML = '<p class="muted-text" style="font-size:.78rem;padding:2px 0;">No results.</p>'; return; }
  el.innerHTML = matches.map(i => {
    // Different library types store their long text under different keys:
    // spells/equipment/skills/feats/classes use `description`, weapons/armor
    // use `notes`, races use `traits`. Show the full text (no truncation).
    const body = i.description || i.notes || i.traits || '';
    return `
    <div class="ref-result-item">
      <div style="color:var(--accent);font-weight:600;font-size:.82rem;">${esc(i.name)}</div>
      ${_libSubtitle(type, i)}
      ${body ? `<div style="font-size:.72rem;color:var(--muted);margin-top:2px;white-space:pre-wrap;">${esc(body)}</div>` : ''}
    </div>`;
  }).join('');
}

function renderAttrs(sheet, char) {
  const isOwn = myChars().some(c => c.id === char.id);
  const stats = ['str','dex','con','int','wis','cha'];
  if (!isOwn) {
    return `<div class="attr-grid">${stats.map(s=>{const score=sheet[s]??10,m=mod(score);return`<div class="attr-box"><div class="attr-label">${s.toUpperCase()}</div><div class="attr-score">${score}</div><div class="attr-mod">${m>=0?'+':''}${m}</div></div>`;}).join('')}</div>`;
  }
  const row = (label, id, val, type='number', extra='') =>
    `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
      <label style="width:140px;font-size:.78rem;color:var(--muted);">${label}</label>
      <input type="${type}" id="${id}" value="${esc(String(val??''))}" class="input-sm" style="width:90px;" ${extra}>
    </div>`;
  return `<div style="max-width:360px;">
    <div style="font-size:.72rem;font-weight:600;color:var(--accent);margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">Ability Scores</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">
      ${stats.map(s=>`<div style="text-align:center;"><div style="font-size:.65rem;color:var(--muted);">${s.toUpperCase()}</div><input type="number" id="attr-${s}" value="${sheet[s]??10}" class="input-sm text-center" style="width:58px;" min="1" max="30"></div>`).join('')}
    </div>
    <div style="font-size:.72rem;font-weight:600;color:var(--accent);margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">Combat Stats</div>
    ${row('Armor Class (AC)','attr-ac',sheet.ac)}
    ${row('Speed (ft)','attr-speed',sheet.speed)}
    ${row('Initiative Bonus','attr-init',sheet.initiative_bonus)}
    ${row('Passive Perception','attr-pp',sheet.passive_perception)}
    <div style="font-size:.72rem;font-weight:600;color:var(--accent);margin:12px 0 6px;text-transform:uppercase;letter-spacing:.06em;">Character Info</div>
    ${row('Level','attr-level',sheet.level)}
    ${row('Class','attr-class',sheet.class||'','text')}
    ${row('Subclass','attr-subclass',sheet.subclass||'','text','list="subclass-opts"')}
    <datalist id="subclass-opts">${(_library.subclasses||[])
      .filter(s => !sheet.class || (s.class||'').toLowerCase() === (sheet.class||'').toLowerCase())
      .map(s => `<option value="${esc(s.name)}">`).join('')}</datalist>
    ${row('Race','attr-race',sheet.race||'','text')}
    ${row('Background','attr-bg',sheet.background||'','text')}
    <button class="btn btn-sm btn-ghost" style="margin-top:8px;" onclick="saveAttrs()">Save Attributes</button>
  </div>`;
}
function saveAttrs() {
  const char = myChar(); if (!char) return;
  // Map: [element-id, sheet-key, db-key]
  const fields = [
    ['attr-str',   'str',                'str_val'],
    ['attr-dex',   'dex',                'dex_val'],
    ['attr-con',   'con',                'con_val'],
    ['attr-int',   'int',                'int_val'],
    ['attr-wis',   'wis',                'wis_val'],
    ['attr-cha',   'cha',                'cha_val'],
    ['attr-ac',    'ac',                 'ac'],
    ['attr-speed', 'speed',              'speed'],
    ['attr-init',  'initiative_bonus',   'initiative_bonus'],
    ['attr-pp',    'passive_perception', 'passive_perception'],
    ['attr-level', 'level',              'level'],
  ];
  const txtFields = [
    ['attr-class',    'class',    'char_class'],
    ['attr-subclass', 'subclass', 'subclass'],
    ['attr-race',     'race',     'race'],
    ['attr-bg',       'background', 'background'],
  ];
  const data = {};  // db-key → value (sent to receiver)
  const sheetPatch = {};  // sheet-key → value (optimistic local patch)
  for (const [id, sKey, dbKey] of fields) {
    const el = $(id); if (!el) continue;
    const v = parseInt(el.value) || 0;
    data[dbKey] = v; sheetPatch[sKey] = v;
  }
  for (const [id, sKey, dbKey] of txtFields) {
    const el = $(id); if (!el) continue;
    const v = el.value.trim();
    data[dbKey] = v; sheetPatch[sKey] = v;
  }
  patchSheet(char, s => { Object.assign(s, sheetPatch); });
  mutate('attr_save', data).catch(() => {});
}

// Step an attribute via the −/+ buttons. which='score' adjusts the score by ±1;
// which='mod' adjusts the modifier by ±1 (i.e. the score by ±2). Both displayed
// values stay in sync. Clamped to 1..30.
function stepAttr(attr, which, delta) {
  const char = myChar(); if (!char) return;
  let sheet;
  try { sheet = typeof char.sheet_json === 'string' ? JSON.parse(char.sheet_json) : char.sheet_json; }
  catch { sheet = {}; }
  let score = sheet[attr] ?? 10;
  if (which === 'mod') {
    const newMod = Math.floor((score - 10) / 2) + delta;
    score = newMod * 2 + 10;
  } else {
    score = score + delta;
  }
  score = Math.max(1, Math.min(30, score));
  sheet[attr] = score;
  char.sheet_json = JSON.stringify(sheet);
  mutate('attr_save', { [attr + '_val']: score }).catch(() => {});
  renderSheet();
}

// Inline click-to-edit on the attribute boxes (mirrors the local sheet). Editing
// the modifier back-calculates the score: score = mod*2 + 10.
function startAttrEdit(el, attr, isMod) {
  if (el.querySelector('input')) return;            // already editing
  const orig = el.textContent.trim();
  const input = document.createElement('input');
  input.type = 'number';
  input.value = parseInt(orig) || 0;
  input.min = isMod ? -5 : 1;
  input.max = isMod ? 10 : 30;
  input.className = 'attr-edit-input';
  el.textContent = '';
  el.appendChild(input);
  input.focus(); input.select();
  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    const val = parseInt(input.value);
    const char = myChar();
    if (isNaN(val) || !char) { el.textContent = orig; return; }
    const scoreVal = isMod ? (val * 2 + 10) : val;
    let sheet;
    try { sheet = typeof char.sheet_json === 'string' ? JSON.parse(char.sheet_json) : char.sheet_json; }
    catch { sheet = {}; }
    sheet[attr] = scoreVal;
    char.sheet_json = JSON.stringify(sheet);
    mutate('attr_save', { [attr + '_val']: scoreVal }).catch(() => {});
    renderSheet();                                   // refresh header score + modifier
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { committed = true; el.textContent = orig; }
  });
}

function _uploadPortraitBlob(blob) {
  const reader = new FileReader();
  reader.onload = async () => {
    const b64 = reader.result.split(',')[1];
    const ext = (blob.type.split('/')[1] || 'png').replace('jpeg','jpg');
    try {
      const res = await api('POST', '/character/portrait', { portrait_data: b64, portrait_ext: ext });
      const char = myChar();
      if (char && res.portrait_url) { char.portrait_url = res.portrait_url; renderSheet(); renderTokens(); }
    } catch (err) {
      alert('Portrait upload failed: ' + err.message);
    }
  };
  reader.readAsDataURL(blob);
}

function triggerPortraitUpload() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => { const file = inp.files[0]; if (file) _uploadPortraitBlob(file); };
  inp.click();
}

// Paste a portrait straight from the clipboard (mirrors the local "Paste Portrait").
async function pastePortrait() {
  try {
    if (navigator.clipboard && navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find(t => t.startsWith('image/'));
        if (type) { _uploadPortraitBlob(await item.getType(type)); return; }
      }
      alert('No image found in your clipboard. Copy an image first, then tap Paste.');
    } else {
      alert('Clipboard paste is not supported in this browser — use Change to upload a file.');
    }
  } catch (err) {
    alert('Could not read the clipboard: ' + err.message);
  }
}

// HP controls
function hpAmount() { return Math.max(1, parseInt($('hp-amount').value)||1); }

function applyHpDelta(delta) {
  const c = myChar();
  if (!c) return;
  // Optimistic local update for instant feedback. Local Flask is the authority:
  // it applies the hp_delta against its own hp_max and pushes the authoritative
  // value back via the character_sheet_updated SSE, which reconciles this.
  const max = c.hp_max || 1;
  c.hp_current = Math.max(0, Math.min(max, (c.hp_current ?? 0) + delta));
  // SFX on the device that applied the change (this player).
  if (delta < 0)      _sfx(c.hp_current <= 0 ? 'dead' : 'damage');
  else if (delta > 0) _sfx('heal');
  renderSheet(); renderParty(); renderTokens();
  mutate('hp_delta', { delta }).catch(err => console.warn('hp_delta failed:', err.message));
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
function stepCount(id, delta) {
  const el = $(id);
  el.value = Math.min(20, Math.max(1, (parseInt(el.value) || 1) + delta));
}

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

// Click a quick-ref skill/weapon to load it into the roller (mod + label, d20).
function diceQuickSet(modVal, label) {
  const m = $('dice-modifier'); if (m) m.value = modVal;
  const l = $('dice-label');    if (l) l.value = label;
  selectDie(20);
}

// Click a spell to load its damage dice into the roller (count + die, e.g. 8d6).
function spellQuickRoll(diceStr, label) {
  const m = (diceStr || '').match(/(\d+)\s*d\s*(\d+)/i);
  if (!m) return;
  const c = $('dice-count');    if (c) c.value = parseInt(m[1], 10);
  selectDie(parseInt(m[2], 10));
  const mod = $('dice-modifier'); if (mod) mod.value = 0;
  const l = $('dice-label');    if (l) l.value = label;
}

// Click a weapon to load its damage dice into the roller (count + die + damage
// bonus, e.g. 2d6 +3). Falls back to a d20 attack roll when it has no dice.
function weaponQuickRoll(diceStr, dmgBonus, atkBonus, name) {
  const m = (diceStr || '').match(/(\d+)\s*d\s*(\d+)/i);
  if (!m) { diceQuickSet(atkBonus || 0, (name || '') + ' attack'); return; }
  const c = $('dice-count');    if (c) c.value = parseInt(m[1], 10);
  selectDie(parseInt(m[2], 10));
  const mod = $('dice-modifier'); if (mod) mod.value = dmgBonus || 0;
  const l = $('dice-label');    if (l) l.value = (name || '') + ' damage';
}

// Build the quick-reference (skills/weapons/spells/armor/feats) shown in the
// character's dice roller. Skills & weapons are clickable to set up the roll;
// spells/armor/feats are reference chips with detail tooltips.
function updateDiceQuickRef(sheet) {
  const el = $('dice-quickref');
  if (!el) return;
  if (!sheet) { el.innerHTML = ''; return; }
  const sgn = n => (n >= 0 ? '+' : '') + n;
  const rows = [];

  const skills = sheet.skills || [];
  if (skills.length) {
    const chips = skills.map(s => `<button class="qref-chip qref-click" onclick="diceQuickSet(${s.bonus||0},${jarg(s.name)})" title="Roll a ${esc(s.name)} check (d20 ${sgn(s.bonus||0)})">${s.proficient?'&#9733; ':''}${esc(s.name)} <span class="qref-sub">${sgn(s.bonus||0)}</span></button>`).join('');
    rows.push(`<div class="qref-row"><span class="qref-label">Skills</span><div class="qref-chips">${chips}</div></div>`);
  }

  const weapons = sheet.weapons || [];
  if (weapons.length) {
    const chips = weapons.map(w => {
      const atk = w.attack_bonus || 0;
      const dmg = w.damage_dice ? `${w.damage_dice}${w.damage_bonus?'+'+w.damage_bonus:''} ${w.damage_type||''}`.trim() : '';
      const title = w.damage_dice ? `Roll ${esc(w.name)} damage (${esc(dmg)})` : `Attack with ${esc(w.name)} (d20 ${sgn(atk)} to hit)`;
      return `<button class="qref-chip qref-click" onclick="weaponQuickRoll(${jarg(w.damage_dice||'')},${w.damage_bonus||0},${atk},${jarg(w.name)})" title="${title}">&#9876; ${esc(w.name)} <span class="qref-sub">${dmg?esc(dmg):sgn(atk)}</span></button>`;
    }).join('');
    rows.push(`<div class="qref-row"><span class="qref-label">Weapons</span><div class="qref-chips">${chips}</div></div>`);
  }

  const spells = sheet.spells || [];
  if (spells.length) {
    const chips = spells.map(s => {
      const cantrip = (s.level === 0 || s.level == null);
      const dmg = s.damage_dice ? s.damage_dice + (s.damage_type ? ' '+s.damage_type : '') : '';
      const tip = [cantrip?'Cantrip':'Level '+s.level, s.school, s.casting_time?'Cast: '+s.casting_time:'', s.range?'Range: '+s.range:'', s.duration?'Dur: '+s.duration:'', s.concentration?'Concentration':'', s.ritual?'Ritual':'', dmg?'Damage: '+dmg:''].filter(Boolean).join(' · ');
      if (s.damage_dice) {
        return `<button class="qref-chip qref-click" onclick="spellQuickRoll(${jarg(s.damage_dice)},${jarg(s.name+' damage')})" title="Roll ${esc(s.name)} damage (${esc(dmg)}) — ${esc(tip)}">&#10039; ${esc(s.name)} <span class="qref-sub">${esc(s.damage_dice)}</span></button>`;
      }
      return `<span class="qref-chip" title="${esc(tip)}">&#10039; ${esc(s.name)} <span class="qref-sub">${cantrip?'C':'L'+s.level}${s.prepared?' &#10003;':''}</span></span>`;
    }).join('');
    rows.push(`<div class="qref-row"><span class="qref-label">Spells</span><div class="qref-chips">${chips}</div></div>`);
  }

  const armor = sheet.armor || [];
  if (armor.length) {
    const chips = armor.map(a => `<span class="qref-chip" title="${esc(a.category||'')}">${a.is_shield?'&#9694;':'&#9651;'} ${esc(a.name)} <span class="qref-sub">${(a.ac_base||0)+(a.ac_bonus||0)} AC${a.equipped?' &#10003;':''}</span></span>`).join('');
    rows.push(`<div class="qref-row"><span class="qref-label">Armor</span><div class="qref-chips">${chips}</div></div>`);
  }

  const feats = sheet.feats || [];
  if (feats.length) {
    const chips = feats.map(f => `<span class="qref-chip" title="${esc(f.description||'')}">&#10022; ${esc(f.name)}</span>`).join('');
    rows.push(`<div class="qref-row"><span class="qref-label">Feats</span><div class="qref-chips">${chips}</div></div>`);
  }

  el.innerHTML = rows.length
    ? `<div class="qref-title">Quick Reference <span class="qref-hint">— tap a skill or weapon to load the roll</span></div>${rows.join('')}`
    : '';
}

function resetDice() {
  $('dice-count').value = 1; $('dice-modifier').value = 0; $('dice-label').value = '';
  selectDie(20); setAdvMode('normal');
  $('dice-result').classList.add('hidden');
}

function clearDiceFeed() {
  const feed = $('roll-feed'); if (feed) feed.innerHTML = '';
}

// Shared roll pipeline for BOTH dice UIs (sheet panel + floating panel).
// DiceCore (dice.js, synced from the local repo) owns the roll algebra,
// expression/breakdown formatting, and crit/fumble decision; only the result
// markup differs per panel and is passed in as a render callback.
function _performRoll(count, sides, modifier, label, mode, renderResult, asPlayer) {
  const r         = DiceCore.roll(count, sides, modifier, mode);
  const roll_expr = DiceCore.expr(r, label);
  const breakdown = DiceCore.breakdown(r);

  renderResult(r, roll_expr, label);

  const cf = DiceCore.critFumble(r);           // roller-only crit/fumble
  if (cf) _sfx(cf);

  // as_player: attribute the roll to whichever of the login's characters is
  // selected (server validates same-username ownership).
  if (jwt) api('POST', '/roll',
    { roll_expr, result: r.total, breakdown, as_player: asPlayer || undefined }
  ).catch(() => {});
}

function doRoll() {
  _performRoll(
    $('dice-count').value, diceSides, $('dice-modifier').value,
    $('dice-label').value.trim(), diceMode,
    (r, roll_expr, label) => {
      const resultEl = $('dice-result');
      const diceHtml = r.rolls.map((v, i) => {
        const isKept    = r.keptRolls.includes(v);
        const isDropped = r.droppedRolls[0] === v && i === r.rolls.length - 1 && r.droppedRolls.length > 0;
        const cls = (v===20&&r.sides===20?' nat20':v===1&&r.sides===20?' nat1':'') + (isDropped?' dropped':r.keptRolls.length<r.rolls.length&&isKept?' kept':'');
        return `<span class="die-val${cls}">${v}</span>`;
      }).join('');
      const modHtml = r.modifier !== 0 ? ` <span style="color:var(--muted);">${r.modifier>0?'+':''}${r.modifier}</span>` : '';
      resultEl.innerHTML = `
        <div class="dice-result-expr">${esc(roll_expr)}</div>
        <div class="dice-result-dice">${diceHtml}${modHtml}</div>
        <div class="dice-result-total">${r.total}${label?' — '+esc(label):''}</div>`;
      resultEl.classList.remove('hidden');
    },
    (myChar() || {}).player_name);
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
    fdInitRoller(); fdSelectDie(fdSides);
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
  _performRoll(
    $('fd-count').value, fdSides, $('fd-mod').value,
    $('fd-label').value.trim(), fdMode,
    (r, roll_expr, label) => {
      // Kept die is always first in rolls array for adv/disadv
      const diceHtml = r.rolls.map((v, i) => {
        const isKept = r.mode !== 'normal' && i === 0;
        let cls = 'fd-die-val';
        if (r.sides === 20 && v === 20) cls += ' nat20';
        else if (r.sides === 20 && v === 1) cls += ' nat1';
        if (isKept) cls += ' kept';
        return `<span class="${cls}">${isKept ? '&#10003;&thinsp;' : ''}${v}</span>`;
      }).join(' ');
      const modHtml = r.modifier !== 0 ? `<span style="color:var(--muted);margin-left:3px;">${r.modifier > 0 ? '+' : ''}${r.modifier}</span>` : '';
      const advHtml = r.mode === 'advantage'
        ? `<div style="color:#28a745;font-size:.7rem;font-weight:600;">&#9650; Advantage &mdash; keep highest</div>`
        : r.mode === 'disadvantage'
        ? `<div style="color:#fd7e14;font-size:.7rem;font-weight:600;">&#9660; Disadvantage &mdash; keep lowest</div>` : '';
      const lblHtml = label ? `<div style="color:var(--muted);font-size:.7rem;">${esc(label)}</div>` : '';

      const resultEl = $('fd-result');
      resultEl.innerHTML = `${lblHtml}${advHtml}<div class="fd-fe-dice">${diceHtml}${modHtml} <span style="opacity:.5;">&#8594;</span> <span style="color:var(--accent);font-weight:bold;font-size:1rem;">${r.total}</span></div>`;
      resultEl.classList.remove('hidden');
    },
    (fdRollerChar() || {}).player_name);
}

function fdReset() {
  $('fd-count').value = 1; $('fd-mod').value = 0; $('fd-label').value = '';
  fdSelectDie(20); fdSetAdvMode('normal');
  $('fd-result').classList.add('hidden');
}

function clearFdFeed() { const f = $('fd-feed'); if (f) f.innerHTML = ''; }

// ── Rolling-as character + Quick Reference (floating dice panel) ─────────────
// One login can run several characters; the fd panel carries an "As" selector
// and the quick-roll chips (skills / weapons / spells) follow that character.
let _fdRollerId = null;

function fdRollerChar() {
  const mine = myChars();
  return mine.find(c => c.id === _fdRollerId) || mine[0] || null;
}

function _fdSheet() {
  const c = fdRollerChar();
  if (!c || !c.sheet_json) return null;
  try { return typeof c.sheet_json === 'string' ? JSON.parse(c.sheet_json) : c.sheet_json; }
  catch { return null; }
}

function fdInitRoller() {
  const row = $('fd-roller-row'), sel = $('fd-roller-sel');
  if (!row || !sel) return;
  const mine = myChars();
  sel.innerHTML = '';
  mine.forEach(c => {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.player_name;
    sel.appendChild(o);
  });
  if (_fdRollerId && mine.some(c => c.id === _fdRollerId)) sel.value = _fdRollerId;
  _fdRollerId = sel.value || null;
  row.style.display = mine.length > 1 ? '' : 'none';
  fdRenderQuickRef();
  fdUpdateStatButtons();
}

function fdRollerChanged() {
  _fdRollerId = $('fd-roller-sel').value;
  fdReset();            // fresh character, fresh roller: 1d20 +0, no label
  fdRenderQuickRef();
  fdUpdateStatButtons();
}

function fdRenderQuickRef() {
  const host = $('fd-quickref'); if (!host) return;
  const sheet = _fdSheet();
  if (!sheet) { host.innerHTML = ''; return; }
  const sign = n => (n >= 0 ? '+' : '') + n;
  const chip = (attrs, title, body) =>
    `<button type="button" class="qref-chip qref-click" title="${esc(title)}" ${attrs}>${body}</button>`;
  const rows = [];
  const skills = sheet.skills || [];
  if (skills.length) rows.push(['Skills', skills.map((s, i) =>
    chip(`data-fdqr="skill" data-i="${i}"`,
         `Roll ${s.name} check (d20 ${sign(s.bonus || 0)})`,
         `${s.proficient ? '&#9733; ' : ''}${esc(s.name)} <span class="qref-sub">${sign(s.bonus || 0)}</span>`)).join('')]);
  const weapons = sheet.weapons || [];
  if (weapons.length) rows.push(['Weapons', weapons.map((w, i) =>
    chip(`data-fdqr="weapon" data-i="${i}"`,
         w.damage_dice ? `Roll ${w.name} damage — ${w.damage_dice}${w.damage_bonus ? '+' + w.damage_bonus : ''} ${w.damage_type || ''}`
                       : `Roll ${w.name} attack (d20 ${sign(w.attack_bonus || 0)})`,
         `&#9876; ${esc(w.name)} <span class="qref-sub">${w.damage_dice
             ? esc(w.damage_dice + (w.damage_bonus ? '+' + w.damage_bonus : '') + ' ' + (w.damage_type || ''))
             : sign(w.attack_bonus || 0)}</span>`)).join('')]);
  const spells = sheet.spells || [];
  if (spells.some(s => s.damage_dice)) rows.push(['Spells', spells.map((s, i) => s.damage_dice
    ? chip(`data-fdqr="spell" data-i="${i}"`,
           `Roll ${s.name} damage (${s.damage_dice})`,
           `&#10039; ${esc(s.name)} <span class="qref-sub">${esc(s.damage_dice)}</span>`)
    : '').join('')]);
  host.innerHTML = rows.length
    ? `<div class="qref-title" style="margin-top:6px;">Quick Reference</div>`
      + rows.map(([l, chips]) =>
          `<div class="qref-row"><span class="qref-label">${l}</span><div class="qref-chips">${chips}</div></div>`).join('')
    : '';
}

$('fd-quickref').addEventListener('click', e => {
  const btn = e.target.closest('[data-fdqr]');
  const sheet = _fdSheet();
  if (!btn || !sheet) return;
  const i = parseInt(btn.dataset.i, 10);
  if (btn.dataset.fdqr === 'skill') {
    const s = (sheet.skills || [])[i]; if (s) fdQuickSet(s.bonus || 0, s.name);
  } else if (btn.dataset.fdqr === 'weapon') {
    const w = (sheet.weapons || [])[i];
    if (w) fdWeaponQuickRoll(w.damage_dice, w.damage_bonus, w.attack_bonus, w.name);
  } else if (btn.dataset.fdqr === 'spell') {
    const s = (sheet.spells || [])[i]; if (s) fdQuickSetDamage(s.damage_dice, s.name + ' damage');
  }
});

function fdQuickSet(modVal, label) {
  $('fd-count').value = 1; $('fd-mod').value = modVal; $('fd-label').value = label;
  fdSelectDie(20);
}

function fdQuickSetDamage(diceStr, label) {
  const m = (diceStr || '').match(/(\d+)\s*d\s*(\d+)/i);
  if (!m) return;
  $('fd-count').value = parseInt(m[1], 10);
  fdSelectDie(parseInt(m[2], 10));
  $('fd-mod').value = 0; $('fd-label').value = label;
}

function fdWeaponQuickRoll(diceStr, dmgBonus, atkBonus, name) {
  const m = (diceStr || '').match(/(\d+)\s*d\s*(\d+)/i);
  if (!m) { fdQuickSet(atkBonus || 0, (name || '') + ' attack'); return; }
  $('fd-count').value = parseInt(m[1], 10);
  fdSelectDie(parseInt(m[2], 10));
  $('fd-mod').value = dmgBonus || 0; $('fd-label').value = (name || '') + ' damage';
}

function fdUpdateStatButtons() {
  const el = $('fd-stat-mod-btns'); if (!el) return;
  const sheet = _fdSheet() || mySheet(); if (!sheet) { el.innerHTML = ''; return; }
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
  clearTimeout(_sseRetryTimer); _sseRetryTimer = null;
  _connStatus('down');
  sessionStorage.removeItem('relay_jwt');
  jwt = null; myPlayerId = null; sessionId = null; playerName = null;
  tokens = []; characters = []; effects = []; resourceState = {};
  GRID_COLS = 20; GRID_ROWS = 20; dragging = null;
  const grid = $('map-grid'); if (grid) grid.querySelectorAll('.map-token').forEach(e=>e.remove());
  const bg = $('map-bg'); if (bg) bg.src = '';
  const bgv = $('map-bg-video');
  if (bgv) { try { bgv.pause(); } catch (e) {} bgv.removeAttribute('src'); bgv.style.display = 'none'; }
  _mapUrl = '';
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

// ── Theme system (swatch picker — mirrors the local app's theme.js) ───────────
const SP_THEMES = [
  { id:'ttrpg-classic', name:'Classic',   swatch:'#c9a84c' },
  { id:'midnight',      name:'Midnight',  swatch:'#00e5c8' },
  { id:'forest',        name:'Forest',    swatch:'#6ecf80' },
  { id:'crimson',       name:'Crimson',   swatch:'#f05050' },
  { id:'ocean',         name:'Ocean',     swatch:'#18c8e8' },
  { id:'ember',         name:'Ember',     swatch:'#ffa020' },
  { id:'royal',         name:'Royal',     swatch:'#b888ff' },
  { id:'frost',         name:'Frost',     swatch:'#90d8f8' },
  { id:'steel',         name:'Steel',     swatch:'#9abcd4' },
  { id:'parchment',     name:'Parchment', swatch:'#e0b860' },
];
// Returns '#ffffff' or near-black depending on which has higher WCAG contrast
// against the given accent — keeps button text readable on any theme.
function spContrastText(hex) {
  hex = hex.replace(/^#/, '');
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  const r = parseInt(hex.slice(0,2),16)/255, g = parseInt(hex.slice(2,4),16)/255, b = parseInt(hex.slice(4,6),16)/255;
  const lin = c => c <= 0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4);
  const L = 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b);
  const onDark  = (L + 0.05) / (0.004 + 0.05);
  const onLight = (1.0 + 0.05) / (L + 0.05);
  return onLight > onDark ? '#ffffff' : '#111118';
}
function _spApplyOnAccent() {
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--sp-accent').trim();
  if (accent) document.documentElement.style.setProperty('--sp-on-accent', spContrastText(accent));
}
function _spUpdateSwatchStates(activeId) {
  document.querySelectorAll('[data-sp-swatch]').forEach(el => {
    const on = el.dataset.spSwatch === activeId;
    el.style.outline       = on ? '3px solid var(--sp-text)' : '2px solid transparent';
    el.style.outlineOffset = on ? '2px' : '0';
    el.style.transform     = on ? 'scale(1.22)' : 'scale(1)';
  });
}
function setTheme(id) {
  document.documentElement.setAttribute('data-theme', id);
  try { localStorage.setItem('sp-theme', id); } catch {}
  requestAnimationFrame(_spApplyOnAccent);
  _spUpdateSwatchStates(id);
}
function buildThemeSwatches() {
  const container = $('sp-swatches');
  if (!container || container.dataset.built) return;
  container.dataset.built = '1';
  SP_THEMES.forEach(t => {
    const btn = document.createElement('button');
    btn.title = t.name;
    btn.dataset.spSwatch = t.id;
    btn.style.cssText = 'width:32px;height:32px;border-radius:50%;border:none;cursor:pointer;padding:0;transition:transform .15s, outline .1s;background:' + t.swatch + ';display:block;';
    btn.onclick = () => setTheme(t.id);
    const label = document.createElement('div');
    label.textContent = t.name;
    label.style.cssText = 'font-size:.62rem;margin-top:3px;text-align:center;color:var(--sp-muted);line-height:1.2;';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;';
    wrap.appendChild(btn); wrap.appendChild(label);
    container.appendChild(wrap);
  });
}
function initTheme() {
  let t; try { t = localStorage.getItem('sp-theme'); } catch {}
  t = t || 'ttrpg-classic';
  document.documentElement.setAttribute('data-theme', t);
  buildThemeSwatches();
  _spUpdateSwatchStates(t);
  _spApplyOnAccent();
}

// ── Init ──────────────────────────────────────────────────────────────────────
initTheme();
selectDie(20);
fdSelectDie(20);
makeDraggable($('fd-panel'), $('fd-drag-handle'));

// ── SFX control: wire the static #sfx-ctrl element ────────────────────────────
(function () {
  const toggle = document.getElementById('sfx-toggle');
  const slider = document.getElementById('sfx-vol');
  if (!toggle || !slider) return;

  if (!window.SFX) {   // sfx.js failed to load — tell the user instead of hiding
    toggle.innerHTML = '&#9888;';
    toggle.title = 'Sound unavailable';
    toggle.style.color = '#e06666';
    return;
  }

  slider.value = Math.round(SFX.getVolume() * 100);

  function syncUI() {
    // Icon-only in the top bar; state is conveyed by the speaker glyph + tooltip.
    if (!SFX.hasTone()) { toggle.innerHTML = '&#9888;'; toggle.title = 'Tone.js not loaded'; toggle.style.color = '#e06666'; return; }
    let icon, text, color;
    if (!SFX.isEnabled())   { icon = '&#128264;'; text = 'Sound: tap to start'; color = 'var(--accent,#c9a84c)'; }
    else if (SFX.isMuted()) { icon = '&#128263;'; text = 'Sound: MUTED';        color = '#e06666'; }
    else                    { icon = '&#128266;'; text = 'Sound: ON';           color = '#7bc77b'; }
    toggle.innerHTML = icon;
    toggle.title = text;
    toggle.style.color = color;
    slider.style.opacity = (SFX.isEnabled() && !SFX.isMuted()) ? '1' : '.5';
  }

  // Browsers require a user gesture before audio starts — enable on the first.
  const _on = () => { SFX.enable().then(syncUI); };
  document.addEventListener('pointerdown', _on, { once: true });
  document.addEventListener('keydown',     _on, { once: true });

  toggle.addEventListener('click', async () => {
    const wasOn = SFX.isEnabled();
    const ok = await SFX.enable();
    if (!ok) {   // surface WHY, instead of doing nothing
      toggle.innerHTML = '&#9888;';
      toggle.title = SFX.lastError() || 'audio failed';
      toggle.style.color = '#e06666';
      return;
    }
    if (wasOn) SFX.mute(!SFX.isMuted());   // first click only enables; later clicks toggle mute
    syncUI();
  });
  slider.addEventListener('input', () => SFX.setVolume(slider.value / 100));
  syncUI();
})();
