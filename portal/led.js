/* portal/led.js — Home lighting bridge (portal-only file; NOT synced from
   the local ScenePlay repo like sfx.js/dice.js/Tone.js are).

   Forwards the DM's scene lighting to devices on the PLAYER'S own LAN:
     - a ScenePlay Raspberry Pi  (POST {pi}/receive_led_patterns, LAN payload shape)
     - a WLED controller         (POST {wled}/json/state, effect/palette by name)

   Direct sends only work when the portal itself is served over plain HTTP —
   i.e. a LOCALLY HOSTED relay on the player's own network (docs/SELF_HOSTED.md).
   From the hosted (HTTPS) portal, browsers refuse to let the page POST into a
   plain-HTTP LAN device: Firefox/Safari always blocked it, and Chrome's
   Local/Private Network Access carve-out (`targetAddressSpace: 'private'`)
   no longer permits it either — that option is dead, don't resurrect it.
   On HTTPS the only working transport is the server-side MQTT path (WLED),
   and _sendPi/_sendWled surface a pointer to it instead of attempting a
   doomed fetch. Every send is wrapped so failure can never break the portal.

   Usage (wired in app.js):
     LED.init(sessionId, username);        // after login
     LED.syncFromRelay(devices);           // from the session_state snapshot
     LED.apply({patterns, seq});           // 'led_update' SSE event  → Pi
     LED.applyWled({off, patterns, seq});  // 'wled_update' SSE event → WLED
*/
window.LED = (function () {
  'use strict';

  const LS_PI      = 'sceneplay_led_pi';
  const LS_WLED    = 'sceneplay_led_wled';
  const LS_ENABLED = 'sceneplay_led_enabled';
  const SS_CURSOR  = 'sceneplay_led_last';   // sessionStorage: per-tab seq cursor

  const SEND_TIMEOUT_MS = 4000;   // mirrors ScenePlay's REMOTE_TIMEOUT

  let _sessionId = null;
  let _username  = '';
  let _isLeader  = true;          // multi-tab: only the leader tab sends
  let _statusCb  = null;
  let _lastMsg   = '';
  let _wledCatalog = null;        // {effects:[], palettes:[]} from GET /json
  let _mqtt      = false;         // server-side: relay drives WLED via broker
  let _mqttInfo  = null;          // {available, broker, port, topic} from relay

  const _get = (k, d) => {
    try { const v = localStorage.getItem(k); return v === null ? d : v; }
    catch (e) { return d; }
  };
  const _set = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

  // ── Status line ─────────────────────────────────────────────────────────────
  function _status(msg) {
    _lastMsg = msg;
    try { if (_statusCb) _statusCb(msg); } catch (e) {}
  }

  // Hosted (HTTPS) portal → browsers block HTTPS pages from reaching
  // plain-HTTP LAN devices, all of them, Chrome included. Direct control is
  // only possible from a locally hosted relay (plain HTTP on the LAN).
  function _directBlocked() { return location.protocol === 'https:'; }

  function _blockedMsg() {
    return 'Browsers block the hosted portal from reaching devices on your ' +
           'network. Use the MQTT option below (WLED), or run a locally ' +
           'hosted relay to control lights directly.';
  }

  // ── Seq cursor (skip SSE-reconnect replays; per-tab, dies with the tab) ────
  function _cursor() {
    try {
      const c = JSON.parse(sessionStorage.getItem(SS_CURSOR) || 'null');
      if (c && c.sid === _sessionId) return c;
    } catch (e) {}
    return { sid: _sessionId, led: 0, wled: 0 };
  }

  function _advanceCursor(kind, seq) {
    // Advances for EVERY tab (leader or not) so a tab that inherits
    // leadership doesn't replay patterns the old leader already sent.
    const c = _cursor();
    if (seq <= (c[kind] || 0)) return false;   // already applied → skip
    c[kind] = seq;
    try { sessionStorage.setItem(SS_CURSOR, JSON.stringify(c)); } catch (e) {}
    return true;
  }

  // ── Multi-tab leader election ───────────────────────────────────────────────
  function _electLeader() {
    if (!navigator.locks || !_username) { _isLeader = true; return; }
    _isLeader = false;
    // Held forever; released automatically when the tab closes, at which
    // point the next tab's pending request acquires it and starts sending.
    navigator.locks.request('sceneplay-led-' + _username, () => {
      _isLeader = true;
      return new Promise(() => {});
    }).catch(() => { _isLeader = true; });
  }

  // ── LAN fetch (Chrome/Edge Local Network Access) ────────────────────────────
  async function _lanFetch(url, opts) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
    try {
      // Unknown RequestInit members are ignored per spec, so this one code
      // path serves all browsers; non-supporting ones throw on mixed content.
      return await fetch(url, Object.assign({
        mode: 'cors',
        targetAddressSpace: 'private',
        signal: ctl.signal,
      }, opts));
    } finally {
      clearTimeout(t);
    }
  }

  // ── Pi (ScenePlay NeoPixel) ────────────────────────────────────────────────
  async function _sendPi(patterns) {
    const base = _get(LS_PI, '');
    if (!base) return;
    if (_directBlocked()) { _status(_blockedMsg()); return; }
    _status('Sending to your Pi…');
    try {
      const res = await _lanFetch(base + '/receive_led_patterns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patterns: patterns }),   // exactly the LAN shape
      });
      _status(res.ok ? 'Lights updated.' : `Pi answered ${res.status}.`);
    } catch (err) {
      _status(err.name === 'AbortError'
        ? `Couldn't reach your Pi at ${base}.`
        : _blockedMsg());
    }
  }

  // ── WLED ────────────────────────────────────────────────────────────────────
  const _clip = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n || 0)));
  const _base = s => String(s || '').split('@')[0].trim().toLowerCase();

  async function _wledResolve(baseUrl) {
    // Effect/palette INDICES vary per firmware; resolve the pushed NAMES
    // against this device's own lists (fetched once per page life).
    if (_wledCatalog) return _wledCatalog;
    const res = await _lanFetch(baseUrl + '/json', { method: 'GET' });
    const all = await res.json();
    _wledCatalog = { effects: all.effects || [], palettes: all.palettes || [] };
    return _wledCatalog;
  }

  async function _sendWled(data) {
    const base = _get(LS_WLED, '');
    if (!base) return;
    // MQTT on = the relay drives the WLED server-side; nothing to do here.
    if (_directBlocked()) { if (!_mqtt) _status(_blockedMsg()); return; }
    _status('Sending to your WLED…');
    try {
      let state;
      if (data.off || !data.patterns || !data.patterns.length) {
        state = { on: false };
      } else {
        const cat = await _wledResolve(base);
        const p = data.patterns[0];   // one home device: apply the first row
        const fx = cat.effects.findIndex(e => _base(e) === _base(p.effect));
        if (fx < 0) {
          _status(`Effect "${p.effect}" not on your WLED — update its firmware?`);
          return;
        }
        let pal = p.palette ? cat.palettes.findIndex(e => _base(e) === _base(p.palette)) : 0;
        if (pal < 0) pal = 0;
        const seg = { fx: fx, pal: pal, sx: _clip(p.speed, 0, 255) };
        if (Array.isArray(p.colors) && p.colors.length) seg.col = p.colors;
        state = { on: true, bri: _clip(p.brightness, 0, 255), seg: [seg] };
      }
      const res = await _lanFetch(base + '/json/state', {
        method: 'POST',
        // text/plain avoids a preflight WLED may not answer; WLED parses the body as JSON
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(state),
      });
      _status(res.ok ? 'Lights updated.' : `WLED answered ${res.status}.`);
    } catch (err) {
      _status(err.name === 'AbortError'
        ? `Couldn't reach your WLED at ${base}.`
        : _blockedMsg());
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  return {
    init(sessionId, username) {
      _sessionId = sessionId;
      _username  = username || '';
      _wledCatalog = null;
      _electLeader();
      // Pull relay-stored addresses for players on a fresh browser
      try {
        if (typeof api === 'function') {
          api('GET', '/led-device').then(d => this.syncFromRelay(d)).catch(() => {});
        }
      } catch (e) {}
    },

    // Relay-stored addresses fill EMPTY local fields only — the local value
    // is what the player typed most recently on this browser, so it wins.
    // The MQTT flag/info are server-authoritative and always adopted.
    syncFromRelay(devices) {
      if (!devices) return;
      let adopted = false;
      if (devices.pi_url   && !_get(LS_PI, ''))   { _set(LS_PI, devices.pi_url); adopted = true; }
      if (devices.wled_url && !_get(LS_WLED, '')) { _set(LS_WLED, devices.wled_url); adopted = true; }
      if (typeof devices.mqtt !== 'undefined') { _mqtt = !!devices.mqtt; adopted = true; }
      if (typeof devices.mqtt_available !== 'undefined') {
        _mqttInfo = {
          available: !!devices.mqtt_available,
          broker:    devices.mqtt_broker || '',
          port:      devices.mqtt_port || 1883,
          topic:     devices.mqtt_topic || '',
        };
        adopted = true;
      }
      // Fresh browser: the Settings inputs were populated before this arrived
      if (adopted) {
        try { window.dispatchEvent(new CustomEvent('led-devices-changed')); } catch (e) {}
      }
    },

    getDevices() {
      return { pi_url: _get(LS_PI, ''), wled_url: _get(LS_WLED, ''),
               mqtt: _mqtt, mqttInfo: _mqttInfo };
    },

    async setDevices(devices) {
      // Persist to the relay first: it normalizes (adds http:// and the Pi
      // port) and rejects garbage, and its answer is what we store locally.
      const saved = await api('POST', '/led-device', {
        pi_url:   devices.pi_url || '',
        wled_url: devices.wled_url || '',
        mqtt:     !!devices.mqtt,
      });
      _set(LS_PI, saved.pi_url || '');
      _set(LS_WLED, saved.wled_url || '');
      this.syncFromRelay(saved);   // adopt mqtt flag + broker info
      _wledCatalog = null;   // address may point at a different device now
      return { pi_url: saved.pi_url || '', wled_url: saved.wled_url || '',
               mqtt: _mqtt, mqttInfo: _mqttInfo };
    },

    isEnabled() { return _get(LS_ENABLED, '0') === '1'; },
    setEnabled(on) { _set(LS_ENABLED, on ? '1' : '0'); },

    onStatus(cb) { _statusCb = cb; if (_lastMsg) _status(_lastMsg); },
    status() { return _lastMsg; },
    isLeader() { return _isLeader; },

    // 'led_update' / session_state.led → the player's Pi
    apply(data) {
      try {
        if (!data || !data.patterns) return;
        if (!_advanceCursor('led', data.seq || 0)) return;   // replay → skip
        if (!this.isEnabled() || !_isLeader || !_get(LS_PI, '')) return;
        _sendPi(data.patterns);
      } catch (e) {}
    },

    // 'wled_update' / session_state.wled → the player's WLED controller
    applyWled(data) {
      try {
        if (!data) return;
        if (!_advanceCursor('wled', data.seq || 0)) return;   // replay → skip
        if (!this.isEnabled() || !_isLeader || !_get(LS_WLED, '')) return;
        _sendWled(data);
      } catch (e) {}
    },

    // Settings-tab button: explicit user gesture, so it bypasses the enabled
    // flag and the leader lock. Flashes each configured device, then dark.
    async test() {
      const pi = _get(LS_PI, ''), wled = _get(LS_WLED, '');
      if (!pi && !wled) { _status('Enter a device address first.'); return; }
      if (pi)   _sendPi([{ type: 'solid', color: [255, 140, 0] }]);
      if (wled) _sendWled({ patterns: [{ effect: 'Solid', palette: null,
        colors: [[255, 140, 0], [0, 0, 0], [0, 0, 0]], speed: 128, brightness: 128 }] });
      await new Promise(r => setTimeout(r, 2500));
      if (pi)   _sendPi([{ type: 'solid', color: [0, 0, 0] }]);
      if (wled) _sendWled({ off: true });
    },
  };
})();
