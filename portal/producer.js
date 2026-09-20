// Producer console on the portal, for DM logins. Everything painted here was
// pushed from local ScenePlay over the GM socket (state document + JPEG
// frames); every button STAGES a command that local executes and acks. The
// relay decides nothing — a command that arrives late is expired by local.
// Uses app.js globals at call time: api(), jwt.
window.Producer = (function () {
  const P = '/producer';
  const PING_MS = 15000, TILE_MAX = 12;
  let sessionId = null, consoleId = null, root = null;
  let state = null, stateAt = 0, linked = false;
  let timers = [], pending = {}, inflight = {}, frameTs = {};
  let faderTimers = {}, faderBusy = false, stripDirty = false;
  let shotsSig = '', scenesSig = '';

  const $ = sel => root ? root.querySelector(sel) : null;
  const $$ = sel => root ? Array.from(root.querySelectorAll(sel)) : [];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const every = (ms, fn) => timers.push(setInterval(fn, ms));

  // ── notes (a small toast; the portal has none of its own) ──
  function note(text, kind) {
    let box = document.getElementById('pc-notes');
    if (!box) { box = document.createElement('div'); box.id = 'pc-notes'; document.body.appendChild(box); }
    const el = document.createElement('div');
    el.className = 'pc-note ' + (kind || 'info'); el.textContent = text;
    box.appendChild(el);
    setTimeout(() => el.remove(), kind === 'warn' ? 5000 : 2500);
  }

  // ── lifecycle ──
  async function init(sid) {
    stop();
    sessionId = sid;
    root = document.getElementById('tab-producer');
    if (!root) return;
    try {
      const r = await api('POST', `${P}/console/open`, {});
      consoleId = r.console_id; linked = !!r.linked;
    } catch (e) { note('Could not open the producer console: ' + e.message, 'warn'); return; }
    try {
      const r = await api('GET', `${P}/state`);
      linked = !!r.linked;
      paint(r.state);
    } catch (e) { /* not pushed yet: producer_state will arrive */ }
    every(PING_MS, async () => {
      try {
        const r = await api('POST', `${P}/console/ping`, { console_id: consoleId });
        linked = !!r.linked;
        if (r.ok === false) { const a = await api('POST', `${P}/console/open`, {}); consoleId = a.console_id; }
        paintLink();
      } catch (e) {}
    });
    every(1000, tickClocks);
    every(2000, () => { if (!document.hidden && state) refreshFrames(['program', 'preview']); });
    document.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', stop);
  }

  function stop() {
    timers.forEach(clearInterval); timers = [];
    document.removeEventListener('keydown', onKey);
    try { stopCam(); } catch (e) {}
    if (consoleId && sessionId) {
      const id = consoleId; consoleId = null;
      try { api('DELETE', `${P}/console/${id}`).catch(() => {}); } catch (e) {}
    }
    state = null; sessionId = null;
  }

  // ── events from the SSE stream (app.js hands them over) ──
  function onEvent(ev) {
    if (!root) return;
    if (ev.type === 'producer_state') { linked = true; paint(ev.data); return; }
    if (ev.type === 'producer_frame_ts') {
      const t = ev.data && ev.data.target; if (!t) return;
      frameTs[t] = ev.data.ts;
      if (!document.hidden) fetchFrame(t);
      return;
    }
    if (ev.type === 'producer_ack') {
      const d = ev.data || {};
      const mine = d.client_id && pending[d.client_id];
      if (mine) delete pending[d.client_id];
      if (d.status === 'applied') { if (mine && ['take', 'marker', 'countdown', 'barge', 'producer_profile'].includes(d.cmd)) note(label(d.cmd) + ' done'); }
      else note(`${label(d.cmd)} ${d.status}${d.error ? ': ' + d.error : ''}`, 'warn');
    }
  }
  const label = c => ({ take: 'Take', arm: 'Arm', marker: 'Marker', countdown: 'Countdown', map_view: 'Map view',
    mute: 'Mute', fader: 'Fader', activate_scene: 'Scene', skip: 'Skip', kill: 'Kill', lights_off: 'Lights off',
    music_toggle: 'Music', set_volume: 'Volume', spotlight: 'Spotlight', auto_cam_pause: 'Auto-cam', clock_reset: 'Clock', markers_clear: 'Clear markers', barge: 'Barge in', producer_profile: 'Name', transition: 'Transition' }[c] || c);

  // ── commands ──
  async function cmd(name, args, ttl) {
    const client_id = Math.random().toString(36).slice(2, 10);
    pending[client_id] = { cmd: name, at: Date.now() };
    try {
      const r = await api('POST', `${P}/command`, { cmd: name, args: args || {}, client_id, ttl_s: ttl });
      if (!r.linked) note('Local ScenePlay is not connected — command staged', 'warn');
      return r;
    } catch (e) { delete pending[client_id]; note(e.message, 'warn'); }
  }
  const arm = key => cmd('arm', { key }, 5);
  const take = () => cmd('take', {}, 5);

  // ── frames ──
  async function fetchFrame(target) {
    if (inflight[target]) return;
    const img = root.querySelector(`img[data-snap="${CSS.escape(target)}"]`);
    if (!img) return;
    inflight[target] = true;
    try {
      const res = await fetch(`/api/v1${P}/frame/${encodeURIComponent(target)}`, { headers: { Authorization: `Bearer ${jwt}` } });
      if (res.status === 200) {
        const url = URL.createObjectURL(await res.blob());
        const old = img.src; img.src = url;
        if (old && old.startsWith('blob:')) URL.revokeObjectURL(old);
      }
    } catch (e) {} finally { inflight[target] = false; }
  }
  function refreshFrames(targets) { for (const t of targets) fetchFrame(t); }

  // ── painting ──
  function shell(d) {
    root.innerHTML = `<div class="pc">
      <div class="pc-banner" id="pc-banner" hidden><span id="pc-banner-text"></span></div>
      <div class="pc-link" id="pc-link"></div>
      <div class="pc-mon pvw"><img alt="" data-snap="preview"><span class="pc-tag">Preview</span><span class="pc-by" id="pc-pvw-name"></span></div>
      <div class="pc-mon pgm"><img alt="" data-snap="program"><span class="pc-tag">Program &#9679; LIVE</span><span class="pc-by" id="pc-pgm-name"></span></div>
      <div class="card pc-side">
        <div class="pc-row"><span class="pc-pill" id="pc-obs-pill">OBS</span><span class="pc-pill" id="pc-stream-pill">STREAM</span><span class="pc-pill" id="pc-rec-pill">REC</span>
          <span class="pc-muted" id="pc-consoles"></span></div>
        <div class="pc-clock" id="pc-clock" title="Session clock (click to reset)">00:00:00</div>
        <div class="pc-muted" id="pc-session"></div>
        <div class="pc-row"><span class="pc-count" id="pc-count">--:--</span>
          <input type="number" id="pc-count-min" min="1" max="180" value="10" title="minutes">
          <button class="btn btn-ghost btn-sm" id="pc-count-start">Start</button>
          <button class="btn btn-ghost btn-sm" id="pc-count-clear" title="clear">&times;</button></div>
        <div class="pc-row"><input type="text" id="pc-marker-note" placeholder="marker note (K)">
          <button class="btn btn-accent btn-sm" id="pc-marker">&#9873;</button></div>
        <div class="pc-markers" id="pc-markers"></div>
        <button class="btn btn-ghost btn-sm" id="pc-markers-clear" title="Remove every marker of this session (the recording's chapters stay)">clear markers</button>
        <label class="pc-row pc-muted"><input type="checkbox" id="pc-autocam"> Let auto-cam run</label>
        <div class="pc-producer">
          <div class="pc-row"><b>You on stream</b><span class="pc-muted" id="pc-producer-feed"></span></div>
          <div class="pc-row"><select class="pc-fade-sel" id="pc-producer-icon" title="Symbol beside your name on stream"></select>
            <input type="text" id="pc-producer-name" maxlength="60" placeholder="name on stream" title="The name on your tile">
            <button class="btn btn-ghost btn-sm" id="pc-producer-save">Save</button></div>
          <div class="pc-row">
            <button class="btn btn-sm" id="pc-barge" title="Barge in: your camera joins the party grid in the last tile and your mic reaches the stream. Leave: the tile goes, and with it your sound on air.">Barge in</button></div>
          <div class="pc-row"><b>Camera &amp; table link</b></div>
          <p class="pc-muted">Starting your camera joins the table's room: you hear every mic and the music and see every camera while you switch. The table hears you whenever your mic is open, on air or not.</p>
          <div class="pc-row" id="pc-cam-start-row">
            <button class="btn btn-accent btn-sm" id="pc-cam-start">&#127909; Start camera</button>
            <a class="btn btn-ghost btn-sm" id="pc-cam-tab" href="#" target="_blank" rel="noopener">Open in a tab</a></div>
          <div id="pc-cam-live" hidden>
            <div class="pc-cam-box" id="pc-cam-box"></div>
            <div class="pc-row">
              <button class="btn btn-sm" id="pc-cam-mic">&#127908; Mute</button>
              <button class="btn btn-sm" id="pc-cam-cam">&#128247; Camera off</button>
              <button class="btn btn-ghost btn-sm" id="pc-cam-stop">Stop</button></div>
          </div>
        </div>
      </div>
      <div class="card pc-shots">
        <div class="pc-shot-row" id="pc-shot-row"></div>
        <div class="pc-row">
          <button class="btn pc-take" id="pc-take">TAKE &#9654; <span id="pc-take-fade"></span></button>
          <select class="pc-fade-sel" id="pc-fade-type" title="Transition every Take uses (saved on the table box)"></select>
          <select class="pc-fade-sel" id="pc-fade-ms" title="Fade length (saved on the table box)"></select>
          <button class="btn btn-ghost" id="pc-mapmode" title="Map on stream: auto, 2D or 3D (V)">AUTO</button>
          <span class="pc-muted pc-hint">1–9 arm · 0 party · B map · P pre · I intermission · O post · F blank · Enter take · V map view · M mute all but DM · K marker · Esc clear</span>
        </div>
      </div>
      <div class="card pc-sp">
        <div class="pc-row"><b>ScenePlay</b><span class="pc-muted" id="pc-active-scene"></span><span class="pc-muted" id="pc-nowplaying"></span></div>
        <div class="pc-scene-row" id="pc-scenes"></div>
        <div class="pc-row">
          <button class="btn btn-ghost btn-sm" data-cmd="skip">Skip &#9197;</button>
          <button class="btn btn-ghost btn-sm" data-cmd="music_toggle">Play/Pause</button>
          <button class="btn btn-ghost btn-sm pc-danger" data-cmd="kill">Kill &#9209;</button>
          <button class="btn btn-ghost btn-sm" data-cmd="lights_off">Lights off</button>
          <input type="range" id="pc-vol" min="0" max="100" title="Room music volume"></div>
      </div>
      <div class="card pc-audio">
        <div class="pc-row"><b>Audio</b>
          <button class="btn btn-sm pc-danger" id="pc-mute-all" title="Mute every player, DM live (M)">MUTE ALL BUT DM</button>
          <button class="btn btn-ghost btn-sm" id="pc-mute-everyone">Mute all</button>
          <button class="btn btn-ghost btn-sm" id="pc-unmute-all">Unmute all</button></div>
        <div class="pc-strip" id="pc-strip"></div>
      </div>
    </div>`;
    wire();
  }

  function paint(d) {
    if (!d) return;
    const first = !state;
    state = d; stateAt = performance.now();
    const w = document.getElementById('pc-waiting'); if (w) w.remove();
    if (first || !$('.pc')) shell(d);
    paintLink();
    $('#pc-banner').hidden = !!d.connected;
    if (!d.connected) $('#pc-banner-text').textContent = 'OBS is not connected on the table box — shots, Take and the OBS audio strip are disabled.';
    const by = d.last_switch ? ({ producer: 'producer', broadcast: 'broadcast page' }[d.last_switch.by] || 'automatic') : '';
    $('#pc-pgm-name').textContent = (d.program || '') + (by ? ' · by ' + by : '');
    $('#pc-pvw-name').textContent = d.preview || 'nothing armed';
    $('#pc-obs-pill').className = 'pc-pill ' + (d.connected ? 'on' : 'off');
    $('#pc-stream-pill').className = 'pc-pill ' + (d.streaming ? 'live' : '');
    $('#pc-rec-pill').className = 'pc-pill ' + (d.recording ? 'live' : '');
    $('#pc-consoles').textContent = `${d.consoles} console${d.consoles === 1 ? '' : 's'}`;
    $('#pc-session').textContent = d.session ? d.session.title : 'no active session';
    $('#pc-autocam').checked = !d.auto_cam_paused;
    paintProducer(d.producer);
    $('#pc-take-fade').textContent = (d.transition || 'Cut') + (d.transition_ms && !d.transition_fixed ? ' ' + d.transition_ms + 'ms' : '');
    paintMapMode(d.map_mode);
    paintFade(d);
    const sig = JSON.stringify((d.shots || []).map(s => [s.key, s.label, s.built, s.hotkey, s.kind]));
    if (sig !== shotsSig) { shotsSig = sig; paintShots(d.shots || []); }
    for (const b of $$('.pc-shot')) {
      const s = (d.shots || []).find(x => x.key === b.dataset.shot);
      b.classList.toggle('live', !!s && s.scene === d.program);
      b.classList.toggle('armed', !!s && s.scene === d.preview && s.scene !== d.program);
      b.classList.toggle('unbuilt', !!s && !s.built);
      b.classList.toggle('featured', !!s && s.character_id != null && s.character_id === d.featured_id);
      const rs = b.querySelector('.pc-reset'); if (rs) rs.classList.toggle('on', d.featured_id == null);
    }
    for (const el of $$('#pc-take, .pc-shot, #pc-mute-all, #pc-mute-everyone, #pc-unmute-all')) el.disabled = !d.connected;
    const ssig = JSON.stringify([d.scenes, d.scene_links, d.scene_links_live]);
    if (ssig !== scenesSig) { scenesSig = ssig; paintScenes(); } else paintActiveScene();
    const np = d.now_playing || {};
    $('#pc-nowplaying').textContent = np.song && np.song.name ? '♪ ' + np.song.name : '';
    if (d.music_volume != null && document.activeElement !== $('#pc-vol')) $('#pc-vol').value = d.music_volume;
    paintStrip(); paintLevels(d.levels || {});
    paintMarkers(d.markers || []);
    tickClocks();
    if (first) refreshFrames(['program', 'preview', ...(d.shots || []).map(s => s.key)]);
  }

  // ── the producer on the stream: name, barge-in, camera (= the table link) ──
  let camFrame = null, camUrl = '', camMic = true, camCam = true;
  function paintProducer(p) {
    if (!p) return;
    const b = $('#pc-barge'); if (!b) return;
    b.className = 'btn btn-sm ' + (p.on_screen ? 'pc-warn' : 'btn-ghost');
    b.textContent = p.on_screen ? 'Leave grid' : 'Barge in';
    $('#pc-producer-feed').textContent = p.feed === 'live' ? 'camera live' : p.feed === 'stale' ? 'camera dropped' : '';
    const name = $('#pc-producer-name');
    if (document.activeElement !== name) name.value = p.name || 'Producer';
    const ic = $('#pc-producer-icon');
    if (ic && document.activeElement !== ic) {
      const icons = p.icons || ['']; const cur = p.icon || '';
      if (ic.options.length !== icons.length) ic.innerHTML = icons.map(i => `<option value="${esc(i)}">${esc(i) || '—'}</option>`).join('');
      ic.value = cur;
    }
    const tab = $('#pc-cam-tab'); if (p.push_url) tab.href = p.push_url; else tab.removeAttribute('href');
    $('#pc-cam-start').disabled = !p.push_url;
    // a regenerated link while the camera runs: follow it
    if (camFrame && p.push_url && camUrl !== p.push_url + '&cleanoutput') startCam(p.push_url);
  }
  function camSend(msg) { if (camFrame && camFrame.contentWindow) camFrame.contentWindow.postMessage(msg, '*'); }
  function paintCam() {
    $('#pc-cam-mic').textContent = camMic ? '\u{1F3A4} Mute' : '\u{1F3A4} Un-mute';
    $('#pc-cam-mic').classList.toggle('pc-danger', !camMic);
    $('#pc-cam-cam').textContent = camCam ? '\u{1F4F7} Camera off' : '\u{1F4F7} Camera on';
    $('#pc-cam-cam').classList.toggle('pc-danger', !camCam);
  }
  function startCam(url) {
    // Camera permission only delegates into a cross-origin iframe from a
    // secure page; on plain http the button opens the page in a tab instead.
    if (!window.isSecureContext) { window.open(url, '_blank', 'noopener'); return; }
    stopCam();
    camFrame = document.createElement('iframe');
    camFrame.allow = 'autoplay;camera;microphone;fullscreen;picture-in-picture;';
    camFrame.src = camUrl = url + '&cleanoutput';
    $('#pc-cam-box').appendChild(camFrame);
    camMic = true; camCam = true; paintCam();
    $('#pc-cam-live').hidden = false; $('#pc-cam-start-row').hidden = true;
  }
  function stopCam() {
    if (camFrame) { camFrame.remove(); camFrame = null; }      // tears down the WebRTC publish
    camUrl = '';
    const live = $('#pc-cam-live'); if (live) live.hidden = true;
    const row = $('#pc-cam-start-row'); if (row) row.hidden = false;
  }

  function paintLink() {
    const el = $('#pc-link'); if (!el) return;
    const age = state ? (performance.now() - stateAt) / 1000 : null;
    const stale = age != null && age > 20;
    el.textContent = !linked ? 'Local ScenePlay is not linked to the relay — nothing here is live.'
      : stale ? `No update from the table box for ${Math.round(age)}s.` : '';
    el.hidden = !el.textContent;
  }

  function paintShots(shots) {
    $('#pc-shot-row').innerHTML = shots.slice(0, TILE_MAX).map(s => `<button type="button" class="pc-shot ${s.built ? '' : 'unbuilt'}" data-shot="${esc(s.key)}"
        title="${esc(s.built ? 'Arm ' + s.label : s.label + ': scene not built on the table box')}">
        <img alt="" data-snap="${esc(s.key)}"><span class="pc-key">${esc(s.hotkey || '')}</span>
        ${s.kind === 'special' ? '' : `<span class="pc-spot" data-spot="${esc(s.key)}" title="Spotlight in the party scene — and put that scene on Program if it is not live">&#9728;</span>`}
        ${s.key === 'party' ? `<span class="pc-spot pc-reset" data-spot="" title="Reset the party grid to the even layout — and put that scene on Program if it is not live (Shift+0)">&#8862;</span>` : ''}
        <span class="pc-shot-label">${esc(s.label)}</span></button>`).join('');
    refreshFrames(shots.map(s => s.key));
  }

  function paintScenes() {
    const d = state; const links = d.scene_links || {}; const live = !!d.scene_links_live;
    $('#pc-scenes').innerHTML = (d.scenes || []).map(s => `<button type="button" class="btn btn-ghost btn-sm pc-scene" data-scene="${esc(s.scene_ID)}">
      ${esc(s.sceneName)}${links[s.scene_ID] ? `<span class="pc-link-tag ${live ? '' : 'off'}">&rarr; ${esc(links[s.scene_ID])}</span>` : ''}</button>`).join('');
    paintActiveScene();
  }
  function paintActiveScene() {
    const np = (state && state.now_playing) || {};
    const active = np.scene || null;
    const id = active && (active.id != null ? active.id : active.scene_ID);
    $('#pc-active-scene').textContent = active ? 'active: ' + (active.name || active.sceneName || id) : 'no scene active';
    for (const b of $$('.pc-scene')) b.classList.toggle('active', id != null && String(b.dataset.scene) === String(id));
  }

  const fmtDb = db => (db > 0 ? '+' : '') + Math.round(db) + ' dB';
  function paintStrip() {
    if (faderBusy) { stripDirty = true; return; }
    stripDirty = false;
    const rows = (state && state.audio_rows) || [];
    const fader = (key, db) => `<input type="range" class="pc-fader" data-fader="${esc(key)}" min="-30" max="10" step="1" value="${Math.round(db)}"><span class="pc-db" data-db-for="${esc(key)}">${fmtDb(db)}</span>`;
    $('#pc-strip').innerHTML = rows.map(r => {
      const shot = (state.shots || []).find(s => s.character_id === r.character_id);
      const source = shot ? shot.scene + ' Cam' : '';
      return `<div class="pc-row"><span class="pc-name">${esc(r.name)}</span><div class="pc-meter" data-level="${esc(source)}"><span></span></div>${fader(r.character_id, r.volume_db)}</div>
        <button type="button" class="btn btn-sm ${r.muted ? 'pc-danger' : 'btn-ghost'}" data-mute="${esc(r.character_id)}" data-muted="${r.muted ? 1 : 0}">${r.muted ? 'Unmute' : 'M'}</button>`;
    }).join('') + `<div class="pc-row"><span class="pc-name">Music</span><div class="pc-meter" data-level="ScenePlay Music|ScenePlay Music Feed"><span></span></div>${fader('music', state.music_volume_db || 0)}</div><span></span>`;
  }
  function paintLevels(lv) {
    for (const m of $$('[data-level]')) {
      const peaks = m.dataset.level.split('|').flatMap(k => lv[k] || []);
      const peak = peaks.length ? Math.max(...peaks) : 0;
      const db = peak > 0 ? 20 * Math.log10(peak) : -60;
      m.firstElementChild.style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + '%';
    }
  }
  function paintMarkers(ms) {
    $('#pc-markers').innerHTML = ms.slice().reverse().slice(0, 30).map(m =>
      `<div>${esc((m.at || '').slice(11))} ${m.timecode ? `<code>${esc(m.timecode.slice(0, 8))}</code>` : ''} ${esc(m.note)}${m.chapter ? ' ✓' : ''}</div>`).join('');
  }
  const FADE_MS = [250, 500, 750, 1000, 1500, 2000];
  function paintFade(d) {
    const type = $('#pc-fade-type'), ms = $('#pc-fade-ms'); if (!type || !ms) return;
    const names = d.transitions || []; const fixed = new Set(d.transitions_fixed || []);
    if (document.activeElement !== type) {
      const cur = d.transition || ''; const opts = names.length ? names : (cur ? [cur] : []);
      type.innerHTML = opts.map(n => `<option value="${esc(n)}"${n === cur ? ' selected' : ''}>${esc(n)}</option>`).join('');
      type.disabled = !names.length;
    }
    if (document.activeElement !== ms) {
      // The saved length, kept while Cut is selected so switching back to Fade
      // brings it along (the table box keeps it too). No 0 ms "Cut" entry: a
      // Fade picked while the length showed "Cut" used to save a 0 ms fade.
      const cur = Number(d.transition_ms) || 0;
      const list = cur > 0 && !FADE_MS.includes(cur) ? [...FADE_MS, cur].sort((a, b) => a - b) : FADE_MS;
      ms.innerHTML = list.map(v => `<option value="${v}"${v === cur ? ' selected' : ''}>${v} ms</option>`).join('');
      ms.disabled = !!d.transition_fixed || fixed.has(d.transition || '');   // Cut: greyed, length remembered
    }
  }
  function paintMapMode(mode) {
    const b = $('#pc-mapmode'); if (!b) return;
    b.textContent = (!mode || mode === 'auto') ? 'AUTO' : String(mode).toUpperCase();
    b.classList.toggle('on', mode === '3d' || mode === 'auto' || !mode);
  }
  const hms = s => [3600, 60, 1].map((u, i) => String(Math.floor(s / u) % (i ? 60 : 100)).padStart(2, '0')).join(':');
  const countdown = s => (s >= 3600 ? hms(s).replace(/^0/, '') : hms(s).slice(3));
  function tickClocks() {
    if (!state || !$('#pc-clock')) return;
    const since = Math.max(0, (performance.now() - stateAt) / 1000);
    if (state.clock_elapsed_s != null) $('#pc-clock').textContent = hms(state.clock_elapsed_s + since);
    const c = $('#pc-count');
    if (state.countdown_left_s != null) {
      const left = state.countdown_left_s - since;
      c.textContent = (left < 0 ? '-' : '') + countdown(Math.abs(left));
      c.className = 'pc-count' + (left < 0 ? ' over' : left < 60 ? ' warn' : '');
    } else { c.textContent = '--:--'; c.className = 'pc-count'; }
    paintLink();
  }

  // ── faders ──
  function setFader(el, db, now) {
    el.value = db;
    const lab = $(`[data-db-for="${CSS.escape(el.dataset.fader)}"]`); if (lab) lab.textContent = fmtDb(db);
    const key = el.dataset.fader;
    const body = key === 'music' ? { target: 'music', db } : { character_id: Number(key), db };
    const send = () => cmd('fader', body, 30);
    if (now) { clearTimeout(faderTimers[key]); delete faderTimers[key]; return send(); }
    if (faderTimers[key]) return;
    faderTimers[key] = setTimeout(() => { delete faderTimers[key]; send(); }, 250);
  }

  // ── wiring ──
  function wire() {
    root.addEventListener('click', e => {
      const spot = e.target.closest('.pc-spot'); if (spot) { e.stopPropagation(); return cmd('spotlight', { key: spot.dataset.spot }); }
      const shot = e.target.closest('.pc-shot'); if (shot && !shot.disabled && !shot.classList.contains('unbuilt')) return arm(shot.dataset.shot);
      const sc = e.target.closest('[data-scene]'); if (sc) return cmd('activate_scene', { scene_id: Number(sc.dataset.scene) });
      const sp = e.target.closest('[data-cmd]'); if (sp) return cmd(sp.dataset.cmd, {});
      const mu = e.target.closest('[data-mute]'); if (mu) return cmd('mute', { character_id: Number(mu.dataset.mute), muted: mu.dataset.muted !== '1' });
      const b = e.target.closest('button, .pc-clock'); if (!b) return;
      switch (b.id) {
        case 'pc-take': return take();
        case 'pc-mapmode': return cmd('map_view', {});
        case 'pc-marker': { const inp = $('#pc-marker-note'); const note_ = inp.value; inp.value = ''; return cmd('marker', { note: note_ }); }
        case 'pc-mute-all': return muteAll();
        case 'pc-mute-everyone': return muteEveryone(true);
        case 'pc-unmute-all': return muteEveryone(false);
        case 'pc-count-start': return cmd('countdown', { seconds: 60 * (Number($('#pc-count-min').value) || 10) });
        case 'pc-count-clear': return cmd('countdown', { clear: true });
        case 'pc-clock': if (confirm('Reset the session clock?')) return cmd('clock_reset', {}); return;
        case 'pc-markers-clear': if (confirm('Clear every marker of this session?')) return cmd('markers_clear', {}); return;
        case 'pc-barge': return cmd('barge', { on: !(state && state.producer && state.producer.on_screen) });
        case 'pc-producer-save': return cmd('producer_profile', { name: $('#pc-producer-name').value, icon: $('#pc-producer-icon').value });
        case 'pc-cam-start': if (state && state.producer && state.producer.push_url) startCam(state.producer.push_url); return;
        case 'pc-cam-mic': camMic = !camMic; camSend({ mic: camMic }); paintCam(); return;
        case 'pc-cam-cam': camCam = !camCam; camSend({ camera: camCam }); paintCam(); return;
        case 'pc-cam-stop': return stopCam();
      }
    });
    root.addEventListener('change', e => {
      if (e.target.id === 'pc-autocam') return cmd('auto_cam_pause', { paused: !e.target.checked });
      if (e.target.id === 'pc-vol') return cmd('set_volume', { volume: Number(e.target.value) });
      if (e.target.id === 'pc-fade-type' || e.target.id === 'pc-fade-ms') {
        // A select keeps keyboard focus after a pick and onKey ignores keys
        // aimed at form fields — hand focus back so the hotkeys stay live.
        e.target.blur();
        return cmd('transition', { name: $('#pc-fade-type').value, ms: Number($('#pc-fade-ms').value) });
      }
      const f = e.target.closest('.pc-fader'); if (f) setFader(f, Number(f.value), true);
    });
    root.addEventListener('input', e => { const f = e.target.closest('.pc-fader'); if (f) setFader(f, Number(f.value), false); });
    root.addEventListener('dblclick', e => { const f = e.target.closest('.pc-fader'); if (f) setFader(f, 0, true); });
    root.addEventListener('pointerdown', e => { if (e.target.closest('.pc-fader')) faderBusy = true; });
    document.addEventListener('pointerup', () => { if (!faderBusy) return; faderBusy = false; if (stripDirty) paintStrip(); });
    $('#pc-marker-note').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#pc-marker').click(); } });
  }
  async function muteAll() { await cmd('mute', { all: true, muted: true }); await cmd('mute', { character_id: -1, muted: false }); }
  async function muteEveryone(muted) { await cmd('mute', { all: true, muted }); await cmd('mute', { character_id: -1, muted }); }

  function onKey(e) {
    if (!root || root.classList.contains('hidden')) return;      // only while the tab shows
    const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'k' || e.key === 'K') { $('#pc-marker').click(); e.preventDefault(); return; }
    if (e.key === 'v' || e.key === 'V') { cmd('map_view', {}); e.preventDefault(); return; }
    if (e.key === 'Escape') { arm(''); return; }
    if (!state || !state.connected) return;
    const hk = e.key.length === 1 ? e.key.toUpperCase() : '';
    if (e.shiftKey && /^Digit[0-9]$/.test(e.code)) {
      const digit = e.code.slice(5);
      if (digit === '0') cmd('spotlight', { key: '' });
      else { const s = (state.shots || []).find(x => x.hotkey === digit); if (s && s.kind !== 'special') cmd('spotlight', { key: s.key }); }
      e.preventDefault(); return;
    }
    const target = hk && /^[0-9BIPOF]$/.test(hk) ? (state.shots || []).find(s => s.hotkey === hk) : null;
    if (target && target.built) { arm(target.key); e.preventDefault(); }
    else if (e.key === 'Enter') { take(); e.preventDefault(); }
    else if (e.key === 'm' || e.key === 'M') { muteAll(); e.preventDefault(); }
  }

  return { init, stop, onEvent };
})();
