"""Optional MQTT bridge — "Option A" for remote WLED control.

Modern browsers block the HTTPS portal from POSTing to a player's plain-HTTP
WLED on their LAN (mixed content / Private Network Access). This bridge
sidesteps the browser entirely: WLED has a built-in MQTT client that dials
OUT to a broker, so the relay publishes each lighting change to a per-player
topic and every opted-in player's WLED follows along with zero software on
their side.

Player setup (WLED web UI → Config → Sync Interfaces → MQTT):
    Broker        = MQTT_PUBLIC_HOST        Port = MQTT_PUBLIC_PORT
    Device Topic  = {MQTT_TOPIC_PREFIX}/{topic_slug(username)}
WLED then subscribes to "<device topic>/api"; we publish WLED JSON-state
payloads there, retained, so a device that (re)boots snaps to the current
scene immediately.

Effects/palettes MUST be numeric here: WLED's JSON API has no name lookup,
and the relay can never reach the player's device to build a catalog. The
local ScenePlay server resolves names → firmware indices against the DM's
own device catalog and includes them as effect_id / palette_id in the push
(mainline WLED effect IDs are stable across versions, which is also why
device presets survive firmware updates).

Disabled (all functions no-op) unless MQTT_HOST is set. Publishing is
fire-and-forget on paho's network thread — a dead broker never blocks or
errors an API request.
"""
import json
import logging
import re
import threading

from config import (
    MQTT_HOST, MQTT_PORT, MQTT_USERNAME, MQTT_PASSWORD, MQTT_TLS,
    MQTT_TOPIC_PREFIX, MQTT_PUBLIC_HOST, MQTT_PUBLIC_PORT,
)

log = logging.getLogger("uvicorn.error")

_client = None
_lock = threading.Lock()


def enabled() -> bool:
    return bool(MQTT_HOST)


def topic_slug(username: str) -> str:
    """Stable, MQTT-safe per-player topic segment derived from the username."""
    slug = re.sub(r"[^a-z0-9]+", "-", (username or "").lower()).strip("-")
    return slug or "player"


def device_topic(username: str) -> str:
    """What the player types into WLED's 'Device Topic' field."""
    return f"{MQTT_TOPIC_PREFIX}/{topic_slug(username)}"


def player_mqtt_info(username: str) -> dict:
    """Setup details the portal shows the player (harmless when disabled)."""
    return {
        "mqtt_available": enabled(),
        "mqtt_broker": MQTT_PUBLIC_HOST,
        "mqtt_port": MQTT_PUBLIC_PORT,
        "mqtt_topic": device_topic(username),
    }


def start() -> None:
    """Connect to the broker (called from the app lifespan). Safe to skip."""
    global _client
    if not enabled():
        return
    try:
        import paho.mqtt.client as mqtt
    except ImportError:
        log.warning("MQTT_HOST is set but paho-mqtt is not installed — "
                    "WLED MQTT bridge disabled (pip install paho-mqtt)")
        return
    with _lock:
        if _client is not None:
            return
        client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id="sceneplay-relay",
        )
        if MQTT_USERNAME:
            client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD or None)
        if MQTT_TLS:
            client.tls_set()
        client.reconnect_delay_set(min_delay=1, max_delay=60)
        # connect_async + loop_start: network I/O (and every reconnect) lives
        # on paho's own thread; a down broker just retries in the background.
        client.connect_async(MQTT_HOST, MQTT_PORT, keepalive=60)
        client.loop_start()
        _client = client
        log.info("WLED MQTT bridge: publishing to %s:%s (prefix '%s')",
                 MQTT_HOST, MQTT_PORT, MQTT_TOPIC_PREFIX)


def stop() -> None:
    global _client
    with _lock:
        if _client is None:
            return
        try:
            _client.loop_stop()
            _client.disconnect()
        except Exception:
            pass
        _client = None


def _clip(n, lo=0, hi=255) -> int:
    try:
        return max(lo, min(hi, int(round(float(n)))))
    except (TypeError, ValueError):
        return lo


def wled_state_from_push(data: dict) -> dict:
    """Convert the relay's stored WLED push ({off}|{patterns:[...]}) into a
    WLED /json/state payload. Mirrors portal/led.js: one home device, first
    pattern row wins. Missing IDs degrade gracefully (colors/brightness only,
    effect left as-is on the device)."""
    patterns = data.get("patterns") or []
    if data.get("off") or not patterns:
        return {"on": False}
    p = patterns[0]
    seg = {"sx": _clip(p.get("speed"))}
    fx = p.get("effect_id")
    if isinstance(fx, int) and fx >= 0:
        seg["fx"] = fx
    pal = p.get("palette_id")
    seg["pal"] = pal if isinstance(pal, int) and pal >= 0 else 0
    colors = p.get("colors")
    if isinstance(colors, list) and colors:
        seg["col"] = colors
    return {"on": True, "bri": _clip(p.get("brightness")), "seg": [seg]}


def publish_wled_state(usernames: list, state: dict) -> None:
    """Retained publish of `state` to each player's <device topic>/api."""
    if _client is None or not usernames:
        return
    payload = json.dumps(state)
    for username in usernames:
        topic = f"{device_topic(username)}/api"
        try:
            _client.publish(topic, payload, qos=1, retain=True)
        except Exception as exc:
            log.warning("MQTT publish to %s failed: %s", topic, exc)
