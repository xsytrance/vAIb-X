# vAIb — Claude Code Context

## What this project is

vAIb is a single-screen agent presence and music platform. It shows a fleet of AI agents discovered from the local system, lets you tune into each agent's music station, and visualizes the audio in real time.

## Running the app

Always need two processes:

```bash
node server/api.mjs      # port 666 — REST + agent discovery + music
npm run dev              # port 667 — Vite/React UI
```

Both bind to `0.0.0.0` — accessible at `http://<your-host-ip>:667`.

Credentials in `.env` (gitignored). Do not commit it.

## Key design rules

- **No agent control.** vAIb observes, not commands. Buttons are reactions/signals, not controls.
- **No single featured agent.** The fleet grid is equal — no agent is highlighted by default.
- **Single screen.** `body { overflow: hidden }`. No page scroll. Fleet grid scrolls within its own zone.
- **Visualizer is prominent.** It sits at the top, below only the header. Do not bury it.
- **Station bar is minimal.** Thin strip. Agent name + track + progress + two buttons. Not a big panel.

## Architecture notes

### Server (`server/`)
- `api.mjs` — HTTP server. Loads `.env` manually (no dotenv dep). Imports discover + music modules.
- `discover.mjs` — Scans `~/.hermes/profiles/` and `~/.openclaw/agents/`. Reads `SOUL.md` for name/role/vibe, `gateway_state.json` for active status. Returns sorted list (active first, by `updated_at`).
- `music.mjs` — Jamendo API. `getClientId()` is lazy (reads env at call time, not import time) so `.env` loading in `api.mjs` works correctly. 10-min in-process cache.
- `store.mjs` — Simple JSON file store. Seeds from `baseState` if missing or corrupt.

### Frontend (`src/`)
- `App.jsx` — Single file for all UI components. Layout: header → vizSection → stationBar → fleetSection.
- `StationPlayer` — Owns `<audio>` element and Web Audio `AnalyserNode`. Calls `onAnalyser(node)` prop on first play so AppContent can pass it to Visualizer.
- `Visualizer.jsx` — Takes `analyser` prop (AnalyserNode). Runs its own rAF loop. 4 modes switchable via buttons.
- `AgentFleet` / `AgentCard` — Cards are tune-in buttons. `tunedId` prop controls which has the active border.
- `seededShuffle(arr, seed)` — Deterministic per-agent track shuffle so every station has a different order.
- `AtmosphereCanvas` — Background particle system, always running. Separate from Visualizer.

### Audio routing
```
<audio> element (Jamendo stream)
  → createMediaElementSource()
  → AnalyserNode (fftSize 512)
  → AudioContext.destination (speakers)
  → Visualizer reads frequencyBinCount via getByteFrequencyData()
```
`crossOrigin="anonymous"` on the `<audio>` tag is required for Web Audio API to work with external streams.

## Common gotchas

- **`JAMENDO_CLIENT_ID` not loading**: `music.mjs` uses `getClientId()` lazily. If you add a new env var in another module, make sure it's read at call time, not at import/module-init time (ES module imports are hoisted).
- **Port conflict**: `relay.mjs` also tries port 666. Don't run relay and api simultaneously without changing `RELAY_PORT`.
- **Audio not starting**: Browser blocks autoplay. Audio only starts on user gesture (click anywhere).
- **`createMediaElementSource` error**: Can only be called once per audio element. The `try/catch` in `initAnalyser` handles this.

## File structure summary

```
server/api.mjs       — main HTTP server
server/discover.mjs  — agent discovery
server/music.mjs     — Jamendo integration
server/store.mjs     — state persistence
server/relay.mjs     — WebSocket relay (separate, not used in normal operation)
src/App.jsx          — entire UI
src/visual/Visualizer.jsx        — audio visualizer
src/visual/AtmosphereCanvas.jsx  — background particles
src/atmosphere/                  — RI engine, multi-node sync
src/audio/AudioAtmosphere.js     — ambient synth (separate from player audio)
src/styles.css       — all styles
data/state.json      — persisted state (not committed)
.env                 — credentials (gitignored)
```
