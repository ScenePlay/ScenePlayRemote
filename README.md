# ScenePlay Remote

ScenePlay Remote is a real-time relay server that lets remote players join tabletop RPG sessions hosted by a Game Master. It acts as a live bridge between the GM's local ScenePlay app and players connecting from anywhere, keeping everyone's view of the game synchronized.

## What it does

- GMs create a session and share a join code with their players
- Players connect through a browser-based portal — no install required
- The server streams live updates (battle maps, token positions, health changes, dice rolls) to all connected players instantly using Server-Sent Events
- GMs can push scene changes, move tokens, update character stats, and manage fog-of-war from their local app
- Players can roll dice, track their own character sheet and health, and see the full party in real time

## Tech Stack

- **Backend:** Python / FastAPI
- **Database:** SQLite
- **Frontend:** Vanilla JavaScript, HTML5, CSS3
- **Auth:** JWT-based player authentication
- **Deployment:** Render
