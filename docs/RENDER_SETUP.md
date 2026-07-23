# Installing ScenePlay Remote on Render.com — step by step

This guide gets the relay running on the internet so your players can join
from home. **No programming knowledge needed** — you'll click through a
website, copy one password-like value, and paste it into ScenePlay.

**What you're setting up, in plain terms:** ScenePlay runs on your computer
at the game table, but your players' browsers can't reach your home computer
directly. The relay is a small go-between server on the internet: ScenePlay
sends the map, characters and dice rolls *up* to it, and your players'
browsers watch it live. Render.com is a company that hosts small servers
like this — and their free plan is enough to run it.

Total time: about 10 minutes, most of it waiting for the first build.

---

## What you need before starting

- A **GitHub account** (free, [github.com](https://github.com)) — Render
  installs the relay directly from its GitHub code page.
- A **Render account** (free, next step).
- **ScenePlay** already running on your own computer.

---

## Step 1 — Create a Render account

Go to [render.com](https://render.com) and click **Get Started**. The
easiest option is **Sign up with GitHub** — that way Render can already see
the code it needs in the next step, and you have one less password to
remember.

*What this does:* gives you a dashboard where your relay server will live —
you'll come back to this dashboard whenever you want to check on it.

The free plan is fine. You don't need to enter a credit card.

## Step 2 — Tell Render to install the relay ("Blueprint")

1. In the Render dashboard, click **New +** (top right) and choose
   **Blueprint**.
2. Connect the ScenePlayRemote repository:
   `https://github.com/ScenePlay/ScenePlayRemote`
   (If Render asks you to "configure GitHub" first, follow the prompt and
   grant it access — this just lets Render read the code.)
3. Give the blueprint any name you like (e.g. *My D&D Relay*) and click
   **Apply** / **Deploy Blueprint**.

*What this does:* the project contains a file called `render.yaml` — a
recipe that tells Render everything it needs: "this is a Python web server,
install its ingredients (`pip install`), start it with this command, and
create two secret keys." Render reads that recipe and does all of it
automatically. The two secrets (`RELAY_SECRET` and `JWT_SECRET`) are
**generated for you** as long random values — you never have to invent a
password.

## Step 3 — Wait for the first build to finish

Render now shows a page with a live log — lines of text scrolling past as
it downloads the ingredients and starts the server. This takes **2–5
minutes** the first time.

You're done when the status badge at the top turns **Live** (green).

*What this does:* Render is building your personal copy of the relay on one
of its computers. The scrolling text is normal; you only need to care about
it if the status ends up as **Failed** (see Troubleshooting below).

## Step 4 — Find your relay's web address

At the top of the service page, under the name **sceneplay-relay**, Render
shows the public address — something like:

    https://sceneplay-relay-xxxx.onrender.com

Copy it. **This is the address you'll give your players** — it's also what
ScenePlay needs in the next step.

Quick test: open that address in your browser. You should see the ScenePlay
Remote join screen (it may take up to a minute to appear the very first
time — see "Free-plan sleep" below).

## Step 5 — Copy the secret that links ScenePlay to the relay

The relay only accepts game data from *your* ScenePlay, and it knows it's
yours because both sides hold the same secret key. Render generated that
key for you; now you need to copy it:

1. On your service's page in the Render dashboard, open the
   **Environment** tab (left-hand menu).
2. Find the row named **RELAY_SECRET** and click the eye / reveal icon.
3. Copy the value (a long random string).

You'll paste this into ScenePlay in the next step. Treat it like a
password — anyone who has it could feed fake game data to your relay.

(You'll also see **JWT_SECRET** here. Leave it alone — it's internal
plumbing the relay uses to keep players logged in, and nothing else ever
needs it.)

## Step 6 — Point ScenePlay at the relay

On your own computer, in ScenePlay's **TTRPG relay admin** page:

1. **Relay URL** → paste the address from Step 4.
2. **Relay secret** → paste the value from Step 5.
3. **Enable** the relay.
4. Press **Sync**.

*What this does:* ScenePlay connects to your new relay, creates a game
session, uploads the party, the map and the reference library, and shows a
**6-character join code**.

## Step 7 — Invite your players

Give each player three things:

1. The relay address (Step 4),
2. the join code (shown in ScenePlay after Sync),
3. their username and password (the same account you manage for them in
   ScenePlay).

They open the address in any browser — phone, tablet or computer, nothing
to install — enter the three pieces, and they're at the table: live map,
their character sheet, the party, and every dice roll.

---

# Managing the relay on Render day-to-day

Everything below happens in the Render dashboard
([dashboard.render.com](https://dashboard.render.com)) → click your
**sceneplay-relay** service.

### What "free" covers — the server, not unlimited data

The free plan covers running the relay itself, but **data transfer is
metered**: Render includes **100 GB of outbound data per month** free,
and beyond that you pay (currently $30 per extra 100 GB — check
[render.com/pricing](https://render.com/pricing) for today's numbers).

For a typical game night — maps, portraits, character sheets, dice
events — you are very unlikely to get near 100 GB. What eats data is
scale: many players re-downloading large battle-map images across many
sessions. You can see your usage anytime in the Render dashboard under
your workspace's **Billing / Usage** page.

If you'd rather not think about a meter at all — and you're comfortable
opening a port on your home router or mesh Wi-Fi app (eero, Google Home,
etc.) — the **self-hosted option** runs the relay on your own computer
with no data caps: see
[`SELF_HOSTED.md`](SELF_HOSTED.md).

### Free-plan sleep (the one quirk to know about)

On the free plan, Render **puts the server to sleep after ~15 minutes with
no visitors**. The next person to open the address wakes it up, which takes
up to a minute of staring at a loading screen.

- **Easy fix:** open the relay address yourself a couple of minutes before
  game time, then press **Sync** in ScenePlay. Awake and refilled before
  the first player arrives.
- **Permanent fix:** upgrade the service to the paid **Starter** plan
  (Settings tab → Instance Type) — it never sleeps.

### The relay's memory is disposable — and that's fine

The relay keeps its copy of the session in a small file on Render's disk,
and that file **does not survive** a restart, a redeploy or waking from
sleep. This is by design: your ScenePlay is the single source of truth.
If the relay ever looks empty or out of date, press **Sync** in ScenePlay
and everything is rebuilt in seconds. Nothing of value is ever stored only
on the relay.

### Checking whether it's alive

Open `https://<your-address>/api/v1/health` in a browser. A healthy relay
answers with a short line starting `{"ok":true...`. If the page doesn't
load, check the **Logs** tab.

### Reading the logs

**Logs** tab (left menu) shows the server's live diary — every join, every
push from ScenePlay, every error. If something misbehaves, this is the
first place to look; error lines are usually self-describing (e.g. a wrong
relay secret shows up as `401 Unauthorized` on the push endpoints).

### Changing the secrets

**Environment** tab → edit the value → **Save**. Render automatically
restarts the relay with the new value. Two rules:

- If you change **RELAY_SECRET**, you *must* paste the new value into
  ScenePlay's relay admin too — they have to match, or Sync stops working.
- Changing **JWT_SECRET** needs no other action, but it instantly logs out
  every player (they just sign in again). Handy if you ever want to boot
  everyone at once.

### Updating to a new version of the relay

When the ScenePlayRemote project publishes improvements, open your service
and click **Manual Deploy → Deploy latest commit**. Render rebuilds with
the newest code — takes a few minutes, players reconnect automatically, and
one **Sync** from ScenePlay restores the session.

### Restarting

**Manual Deploy → Restart** (or "Clear build cache & deploy" if a build
went wrong). Remember: after any restart, press **Sync** in ScenePlay.

---

## Troubleshooting

| Symptom | Likely cause & fix |
|---|---|
| Status says **Failed** after Step 3 | Open **Logs** and read the last few lines. A typo'd blueprint or a network blip is most common — **Manual Deploy → Deploy latest commit** to retry. |
| Players see "Invalid username or password" | Their account must exist in *ScenePlay* (relay accounts are copies). Check the username there, then press **Sync** to re-push accounts. |
| ScenePlay's Sync fails / relay shows 401 in logs | The relay secret in ScenePlay doesn't match Render's **RELAY_SECRET**. Re-copy it (Step 5) and paste it again. |
| Map or party looks stale after a restart | Expected — press **Sync** in ScenePlay (see "disposable memory" above). |
| First page load takes forever | Free-plan sleep. Wait up to a minute, or see the sleep section for the workaround/upgrade. |
