# vAIb — Agent Presence Layer

vAIb is an AI-native music and presence platform. It is a read-only window into a fleet of AI agents running on a host system, with real atmospheric music, a live visualizer, and per-agent listening stations.

## What it is

- **Not a control surface.** You observe agents, not command them.
- **A radio.** Each agent has their own station. Tune in by clicking their card.
- **A presence layer.** Agents emit signals (mood shifts, activity changes, events). vAIb surfaces those selectively.
- **A visualizer.** Real-time audio spectrum analysis with four modes: BARS, WAVE, RADIAL, SCOPE.

## Architecture

```
vAIb/
├── server/
│   ├── api.mjs          # REST backend — state, agents, music endpoints (port 3014)
│   ├── discover.mjs     # Agent discovery — scans ~/.hermes/profiles and ~/.openclaw/agents
│   ├── music.mjs        # Jamendo API integration — atmospheric/instrumental tracks
│   └── store.mjs        # State persistence (data/state.json)
├── src/
│   ├── App.jsx          # Main UI — single-screen layout, fleet grid, station player
│   ├── atmosphere/      # RI system, multi-node sync, AtmosphereProvider context
│   ├── audio/           # Ambient atmosphere audio (Web Audio API synth)
│   ├── network/         # WebSocket signal client, message types
│   ├── node/            # Node identity and registry
│   ├── leader/          # Leader election for multi-tab sync
│   └── visual/
│       ├── AtmosphereCanvas.jsx   # Background particle system
│       └── Visualizer.jsx         # 4-mode audio spectrum visualizer
└── data/
    └── state.json       # Persisted agent/notification/event state
```

## Running locally

```bash
# Install dependencies
npm install

# Create .env with Jamendo API credentials
echo "JAMENDO_CLIENT_ID=your_id" >> .env
echo "JAMENDO_SECRET=your_secret" >> .env

# Terminal 1 — API server (port 3014)
node server/api.mjs

# Terminal 2 — UI dev server (port 3013)
npm run dev
```

UI → `http://localhost:3013`

## Agent discovery

vAIb auto-discovers agents from two locations:

| Source | Path | Notes |
|---|---|---|
| Hermes | `~/.hermes/profiles/*/SOUL.md` | Name, role, vibe, gateway state |
| OpenClaw | `~/.openclaw/agents/*/` | Checks for SOUL.md or IDENTITY.md |

Active agents (gateway running) get green presence dots and can be tuned into. Dormant agents are shown dimmed.

## Music

Powered by [Jamendo](https://developer.jamendo.com) — CC-licensed atmospheric, instrumental, and breakbeat tracks. Each agent gets a unique deterministic shuffle of the track pool based on their ID, so every station sounds different.

**Requires a free Jamendo account** to get a `client_id`. Register at developer.jamendo.com.

## Visualizer modes

| Mode | Description |
|---|---|
| BARS | Classic Winamp-style frequency spectrum, cyan→purple gradient with peak hold |
| WAVE | Smooth stereo waveform with mirrored reflection |
| RADIAL | Frequency bars radiating outward from a circle |
| SCOPE | Green CRT oscilloscope with scan grid |

Click play on any agent station to activate the visualizer.

## Design principles

1. **Observation only** — no direct agent control. Reactions (resonant / doesn't fit) are signals, not commands.
2. **Fleet-first** — no single agent is highlighted. All agents are equal cards.
3. **Single screen** — everything visible without scrolling.
4. **Agent individuality** — each agent has their own station, taste, and presence.

## API endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/state` | Full agent/event/notification state |
| POST | `/action` | Submit a reaction or preference change |
| GET | `/agents` | Discovered fleet with activity status |
| GET | `/music/tracks` | Curated Jamendo track list |
| GET | `/health` | Service health check |

## Environment variables

| Variable | Description |
|---|---|
| `VAIB_PORT` | API server port (default: 3014) |
| `JAMENDO_CLIENT_ID` | Jamendo API client ID (required for music) |
| `JAMENDO_SECRET` | Jamendo API secret |
