# vAIb-X Fix Plan

## Stage 1: Critical Runtime Fix ✅
- **1a**: Fixed missing `useRef` and `useCallback` imports in `src/App.jsx`
- **1b**: Fixed missing `audioStartedRef` declaration (pre-existing bug, would have crashed on user gesture)

## Stage 2: Backend Agent Generification ✅
- **2a**: Refactored `server/api.mjs` `handleAction()` to accept `agentId` from payload
- **2b**: Updated all action handlers (`play`, `next`, `favorite`, `dislike`, `mood`, `playlist`) to use dynamic agent
- **2c**: Updated `derive()` to accept `agentId` parameter, fallback to `'saito'` for backward compat
- **2d**: All notification/event strings now use `${name}` instead of hardcoded `'Saito'`

## Stage 3: Wire Agent System to UI ✅
- **3a**: Wrapped `<App />` with `<AgentProvider>` in `main.jsx`
- **3b**: Added `useAgent()` hook in `AppContent` — pulls `resonates`, `tooMuchStatic`, `nudgeDrift`
- **3c**: Added 3 reaction buttons to MiniPlayer: ♥ Resonant, ✕ Static, ↻ Nudge Drift
- **3d**: Reaction handlers call both backend API (per-agent) and signal engine (via AgentProvider)
- **3e**: Updated `sendAction()` and `act()` to pass `agentId` for per-agent actions

## Stage 4: Cleanup & Polish ✅
- **4a**: Removed all `[TEMP]` debug console.log statements from:
  - `src/atmosphere/AtmosphereProvider.jsx` (15 lines)
  - `src/agent/AgentProvider.jsx` (6 lines)
  - `src/network/SignalClient.js` (2 lines)
  - `server/discovery.mjs` (1 line)
  - `server/relay.mjs` (1 line)
- **4b**: Replaced hardcoded IP `100.110.224.126` with `${VITE_API_BASE:-http://localhost:4014}` in package.json
- **4c**: Updated CLAUDE.md docs to use generic `<your-host-ip>` instead of hardcoded IP

## Stage 5: Final Review ✅
- **5a**: All server `.mjs` files pass `node --check` (syntax valid)
- **5b**: All React hooks properly imported and declared (no undeclared refs)
- **5c**: 10 files changed, +84/-54 lines, no remaining hardcoded IPs or TEMP logs

---

## Summary of Changes

| File | What Changed |
|---|---|
| `src/App.jsx` | Fixed imports, added `audioStartedRef`, added `useAgent()`, added reaction handlers + buttons, made actions per-agent |
| `src/main.jsx` | Wrapped `<App />` with `<AgentProvider>` |
| `server/api.mjs` | Agent-generic `derive()` and `handleAction()`, dynamic agent lookup, `${name}` in all strings |
| `server/discovery.mjs` | Removed debug log |
| `server/relay.mjs` | Removed debug log |
| `src/agent/AgentProvider.jsx` | Removed 6 TEMP console.log lines |
| `src/atmosphere/AtmosphereProvider.jsx` | Removed 15 TEMP console.log lines |
| `src/network/SignalClient.js` | Removed 2 TEMP console.log lines |
| `package.json` | `build:android` now uses `$VITE_API_BASE` env var with localhost default |
| `CLAUDE.md` | Updated docs to use generic host IP placeholder |

## Ready for commit. Run:
```bash
git add -A
git commit -m "fix: runtime crash, agent-generic backend, AgentProvider wiring, cleanup"
```
