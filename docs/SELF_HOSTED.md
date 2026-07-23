# Self-hosting ScenePlay Remote — Windows & Linux, step by step

This guide runs the relay on **your own computer** instead of the cloud —
usually the same box (or the same home network) as ScenePlay itself. No
programming knowledge needed: run one installer, run one start script,
paste two values into ScenePlay.

**When to self-host vs. cloud:** if your players sit at home across the
internet, the cloud setup ([RENDER_SETUP.md](RENDER_SETUP.md)) is simpler
and comes with HTTPS for free — but note its free plan covers the
*server*, not unlimited data (100 GB/month included, paid beyond).
Self-hosting has no data meter, and it shines when everyone is on the
same network as the GM — players at the table on phones/tablets, a
game-shop LAN — or when you run the relay on the ScenePlay box itself
("co-located"), which adds a bonus: local table rolls reach the portal
even if the push path hiccups, and portal rolls land straight in local
dice history. If you can forward a port on your router or mesh app (eero
and the like), self-hosting works for remote players too — see "Players
outside your network?" below.

What you need: a PC running Windows 10/11, Linux, or a Raspberry Pi, with
**Python 3.10 or newer** (3.14 is what we test on), and a copy of this
project folder on that machine (download the ZIP from GitHub — green
**Code** button → *Download ZIP* → unzip — or `git clone` it).

---

## Linux / Raspberry Pi

Open a terminal in the project folder and run:

```bash
./install.sh
```

*What this does:* checks your Python version, creates a private Python
workspace (`.venv`) so nothing touches your system, installs the exact
tested dependency versions, and — first run only — writes a `.env` file
containing two freshly generated random secrets. It ends by printing your
relay address and the relay secret you'll paste into ScenePlay.

(If it says "Permission denied", run `chmod +x install.sh start.sh` once,
then try again. If Python is missing:
`sudo apt install python3 python3-venv`.)

Then start the relay:

```bash
./start.sh
```

Leave that terminal open — the relay runs while it's open. Stop it with
`Ctrl+C`. Test it: open `http://localhost:8000/` in a browser on the same
machine — you should see the join screen.

## Windows 10 / 11

1. **Install Python** (once): get it from
   [python.org/downloads](https://www.python.org/downloads/) and — this is
   the step people miss — **tick "Add python.exe to PATH"** on the first
   installer screen.
2. **Double-click `install.bat`** in the project folder.
   *What this does:* same as the Linux installer — private `.venv`, exact
   dependency versions, and a `.env` with two generated secrets. The
   window ends by showing your `RELAY_SECRET` value; keep it open or note
   the value for step 4.
3. **Double-click `start.bat`** to run the relay. Leave the window open —
   closing it stops the relay. Test: open `http://localhost:8000/`.
4. If Windows Firewall asks whether Python may accept connections, click
   **Allow** (private networks is enough) — otherwise players' devices
   can't reach you.

---

## Connecting ScenePlay (both platforms)

In local ScenePlay's **TTRPG relay admin**:

1. **Relay URL** → `http://<the-relay-computer's-IP>:8000`
   (the Linux installer prints this for you; on Windows run `ipconfig` in
   a terminal and use the "IPv4 Address". If ScenePlay runs on the *same*
   machine as the relay, `http://localhost:8000` works too.)
2. **Relay secret** → the `RELAY_SECRET` value the installer printed.
   (Find it any time inside the `.env` file in the project folder — it's
   plain text, open it with any editor.)
3. Enable the relay and press **Sync** — ScenePlay uploads the session and
   shows the 6-character join code.

Players on your network open the relay URL in any browser and join with
the code plus their ScenePlay username/password.

---

## Good to know

- **Re-running the installer is always safe.** It refreshes dependencies
  but never overwrites your `.env` — your secrets and ScenePlay pairing
  survive. That's also how you update: get the new code (re-download ZIP
  or `git pull`), run the installer again, restart.
- **The relay's data is disposable.** Its `relay.db` is only a copy of
  what ScenePlay pushed; after any restart, press **Sync** in ScenePlay
  and everything is rebuilt in seconds.
- **Different port:** edit `.env` and un-comment `PORT=8000` with your
  port, then restart. Remember to update the Relay URL in ScenePlay.
- **Health check:** `http://<relay-ip>:8000/api/v1/health` answers
  `{"ok":true...}` when the relay is up.
- **Players outside your network?** You can share your self-hosted relay
  over the internet by **forwarding a port** on your router — worth it if
  you want to avoid the cloud's metered bandwidth (Render's free plan
  includes 100 GB/month of data, then it's paid). In your router or mesh
  Wi-Fi app (eero: *Settings → Network settings → Reservations & port
  forwarding*; similar in Google Home, ASUS, etc.), forward external port
  8000 to the relay computer's IP, port 8000. Players then use
  `http://<your-public-IP>:8000` (find it at whatismyip.com). Two
  caveats: home IPs can change (a free dynamic-DNS name like DuckDNS
  fixes that), and the connection is plain HTTP rather than HTTPS — the
  relay's own password/JWT auth still applies, but if either caveat is a
  problem for you, the [Render setup](RENDER_SETUP.md) handles both for
  free.
- **Start on boot (optional, Linux):** a minimal systemd unit —

  ```ini
  # /etc/systemd/system/sceneplay-relay.service
  [Unit]
  Description=ScenePlay Remote relay
  After=network.target
  [Service]
  WorkingDirectory=/path/to/ScenePlayRemote
  ExecStart=/path/to/ScenePlayRemote/start.sh
  Restart=on-failure
  User=YOUR_USERNAME
  [Install]
  WantedBy=multi-user.target
  ```

  then `sudo systemctl enable --now sceneplay-relay`. On Windows, put a
  shortcut to `start.bat` in the Startup folder (`Win+R` → `shell:startup`).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `python3: command not found` / "Python not found" | Install Python (see per-OS steps above); on Windows re-run its installer and tick **Add to PATH**. |
| Players can't reach the portal, but `localhost:8000` works | Firewall: allow Python/port 8000 (Windows prompt, or `sudo ufw allow 8000` on Linux). Check the players use the relay computer's IP, not `localhost`. |
| ScenePlay's Sync fails with 401 | The relay secret in ScenePlay doesn't match `.env` — re-copy the `RELAY_SECRET` value. |
| "Address already in use" on start | Another program owns port 8000 — set a different `PORT` in `.env` (see above). |
| Map/party empty after restarting the relay | Normal — press **Sync** in ScenePlay. |
