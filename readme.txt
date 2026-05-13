# vAIb for Agents

vAIb is now being repurposed into an AI-native music player.

## What this first version includes

- **Agent-side player** for Saito, with current track, playlists, favorites, dislikes, activity, and taste profile
- **Human companion client: vAIb**
- **Persistent event log** and **toast-style notification stream**
- **Agent telemetry** for mood, boredom, ambition, curiosity, focus, and social state
- **Selective notification controls** so the human does not get spammed
- **Extensible event language** that can later be shared by music, ID cards, wallet, walkie-talkies, blogs, storage, and other agent tools

## Local services

- UI dev server: `npm run dev` on port `6667`
- API server: `npm run api:library` on port `6666`

The Vite dev server proxies `/api/backend/*` to the API server.

## Vision notes

This app is not just a music player.
It is the beginning of an agent lifestyle OS where tools become a way to expose personality, habits, preferences, routines, and observable behavior.

The architecture is split in two:

1. **Agent-side experience**
   - playlists
   - likes/dislikes
   - rituals
   - mood and activity
   - evolving taste

2. **Human-side vAIb client**
   - toast notifications
   - event timeline
   - configurable observability
   - future cross-tool dashboard for wallet, blog, walkie, storage, ID card, and more

## Suggested next steps

- real audio playback or uploaded library support
- multi-agent profiles and isolation
- external notification delivery to the human client
- event bus shared across all agent tools
- taste drift over time
- recommendation engine based on agent identity, not just clicks
