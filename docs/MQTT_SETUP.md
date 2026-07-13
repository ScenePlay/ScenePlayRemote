# WLED-over-MQTT — Setup Guide

Lets players' home WLED strips follow the DM's scene lighting in **any
browser** (Firefox/Safari included): instead of the portal page pushing into
the player's LAN (blocked as mixed content), the player's WLED dials **out**
to an MQTT broker and the relay publishes every lighting change there.
Feature overview: README → "Home lighting". Code: `mqtt_bridge.py`.

---

## Quick trial (no server needed, ~10 min)

Prove the pipeline on a free public broker first. Public = anyone can
read/write your topics, so testing only.

1. Set on the relay and redeploy:
   - `MQTT_HOST=broker.hivemq.com`
   - `MQTT_TOPIC_PREFIX=sceneplay-<something-unguessable>`
2. Do "Part 3 — Player WLED" below with that broker and **no credentials**.
3. Trigger a scene; if the lights follow, move to the real setup.

---

## Part 1 — Your own broker (one-time)

Any small always-on Linux VPS with a public address (Hetzner, DigitalOcean,
Oracle free tier…). The broker cannot run on Render — MQTT is raw TCP.

```bash
# 1. Install
sudo apt update && sudo apt install -y mosquitto mosquitto-clients

# 2. Accounts: one for the relay + one per player.
#    WLED sends these passwords UNENCRYPTED (no TLS in stock firmware) —
#    use throwaway strings, never reused passwords.
sudo mosquitto_passwd -c /etc/mosquitto/passwd relay     # -c only the first time
sudo mosquitto_passwd    /etc/mosquitto/passwd eric
sudo mosquitto_passwd    /etc/mosquitto/passwd ben
```

3. Create `/etc/mosquitto/conf.d/sceneplay.conf`:

```
listener 1883
allow_anonymous false
password_file /etc/mosquitto/passwd
```

Optional hardening — players may only READ their own topic. Create
`/etc/mosquitto/aclfile` and add `acl_file /etc/mosquitto/aclfile` to the
conf. `%u` is the broker username, so name each player's broker account
exactly their topic slug (lowercase username, spaces→dashes; the portal's
Home Lights card shows it):

```
user relay
topic readwrite sceneplay/#

pattern read sceneplay/%u/#
```

4. Start and expose:

```bash
sudo systemctl enable --now mosquitto
sudo ufw allow 1883/tcp        # plus the cloud provider's firewall rules
```

5. Live debugging window (keep open during first tests):

```bash
mosquitto_sub -h localhost -u relay -P <relay-password> -t 'sceneplay/#' -v
```

## Part 2 — Point the relay at it

Relay environment (Render dashboard → Environment, or `.env`):

```
MQTT_HOST=<VPS IP or domain>
MQTT_PORT=1883
MQTT_USERNAME=relay
MQTT_PASSWORD=<relay broker password>
MQTT_TOPIC_PREFIX=sceneplay
```

Restart; the startup log must show
`WLED MQTT bridge: publishing to <host>:1883 (prefix 'sceneplay')`.
With `MQTT_HOST` unset the feature is fully dormant.

## Part 3 — Player WLED (once per player, ~5 min)

1. Portal → **Settings → Home Lights** → tick **"Control my WLED via MQTT"**.
   The info line shows the exact broker, port, and Device Topic to copy.
2. WLED web UI (`http://<wled-ip>`) → **Config → Sync Interfaces → MQTT**:
   - Enable MQTT ✓
   - Broker = VPS address, Port = 1883
   - Username / Password = their broker account (from Part 1)
   - **Device Topic** = exactly the portal's value, e.g. `sceneplay/eric`
   - Client ID / Group Topic: leave as-is
3. Save (WLED reboots). Sync Interfaces should now report MQTT connected.

## Part 4 — Verify

- DM activates a scene with WLED patterns → `mosquitto_sub` shows the publish
  on `sceneplay/<player>/api` and the strip changes within ~1 s.
- Power-cycle the strip: publishes are **retained**, so it snaps back to the
  current scene on reconnect.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No "bridge" line in relay startup log | `MQTT_*` env vars not set where the relay actually runs |
| Publish visible in `mosquitto_sub`, strip dark | Player's Device Topic ≠ portal's info line (most common), or bad broker credentials — `journalctl -u mosquitto` shows refused connects |
| Colors right, effect wrong/unchanged | Player runs a non-mainline WLED build with shifted effect IDs; the bridge degrades to colors/brightness rather than firing a wrong effect |
| Worked, then stopped after username change | Topic slug follows the username — re-check the portal info line and update the WLED Device Topic |
