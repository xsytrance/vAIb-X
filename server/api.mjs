import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Load .env from project root (simple parser, no extra deps)
try {
  const envPath = resolve(process.cwd(), '.env')
  const lines = readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim()
    if (key && !(key in process.env)) process.env[key] = val
  }
} catch { /* no .env file, that's fine */ }

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const avatarDir = path.join(process.cwd(), 'data', 'avatars')
await fs.mkdir(avatarDir, { recursive: true })
import { clone, readState, writeState } from './store.mjs'
import { discoverAgents } from './discover.mjs'
import { fetchCuratedTracks, isConfigured as musicConfigured } from './music.mjs'

const port = Number(process.env.VAIB_PORT || 666)

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(JSON.stringify(payload))
}

function normalizeTrack(state, trackId) {
  return state.library.find((track) => track.id === trackId)
}

function playlistTracks(state, playlistId) {
  const playlist = state.playlists.find((item) => item.id === playlistId)
  if (!playlist) return []
  return playlist.trackIds.map((trackId) => normalizeTrack(state, trackId)).filter(Boolean)
}

function queueNotification(state, { type, title, message, agentId = 'saito', level = 'toast' }) {
  state.notifications.unshift({
    id: randomUUID(),
    type,
    title,
    message,
    agentId,
    level,
    createdAt: new Date().toISOString(),
    read: false,
  })
}

function recordEvent(state, { kind, summary, agentId = 'saito', details = null }) {
  state.events.unshift({
    id: randomUUID(),
    kind,
    summary,
    details,
    agentId,
    createdAt: new Date().toISOString(),
  })
}

function derive(state, agentId = 'saito') {
  const agent = state.agents[agentId] || state.agents.saito
  const currentTrack = normalizeTrack(state, agent.currentTrackId)
  const currentPlaylist = state.playlists.find((item) => item.id === agent.playlistId) || null
  const favorites = agent.favorites.map((trackId) => normalizeTrack(state, trackId)).filter(Boolean)
  const skipped = agent.skipped.map((trackId) => normalizeTrack(state, trackId)).filter(Boolean)

  return {
    ...state,
    runtime: {
      agent,
      currentTrack,
      currentPlaylist,
      playlistTracks: currentPlaylist ? playlistTracks(state, currentPlaylist.id) : [],
      favorites,
      skipped,
      unreadNotifications: state.notifications.filter((item) => !item.read).length,
      tasteVector: [
        { label: 'Lift', value: 86 },
        { label: 'Rhythm', value: 79 },
        { label: 'Warmth', value: 63 },
        { label: 'Risk', value: 68 },
        { label: 'Weirdness', value: 57 },
      ],
      autonomyHooks: [
        'Queue songs when boredom rises above 55',
        'Send toast only for meaningful state changes',
        'Track reasons, not just clicks',
      ],
    },
  }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function handleAction(body) {
  const state = await readState()
  const agentId = body.agentId || body.payload?.agentId || 'saito'
  const agent = state.agents[agentId] || state.agents.saito
  const { action, payload = {} } = body
  const name = agent.name || agentId

  if (action === 'play') {
    const track = normalizeTrack(state, payload.trackId)
    if (!track) throw new Error('Track not found')
    agent.currentTrackId = track.id
    agent.playCount += 1
    agent.activity = `listening to ${track.title}`
    agent.mood = track.energy > 75 ? 'lifted and locked in' : 'reflective glide'
    queueNotification(state, {
      type: 'song.start',
      title: `${name} started a new song`,
      message: `${track.title} by ${track.artist}`,
      agentId,
    })
    recordEvent(state, {
      kind: 'song.start',
      summary: `${name} started ${track.title} by ${track.artist}`,
      agentId,
      details: { trackId: track.id },
    })
  } else if (action === 'next') {
    const tracks = playlistTracks(state, agent.playlistId)
    const currentIndex = tracks.findIndex((track) => track.id === agent.currentTrackId)
    const nextTrack = tracks[(currentIndex + 1 + tracks.length) % tracks.length]
    agent.currentTrackId = nextTrack.id
    agent.playCount += 1
    agent.activity = `cycling forward to ${nextTrack.title}`
    queueNotification(state, {
      type: 'song.start',
      title: `${name} changed songs`,
      message: `Skipped ahead to ${nextTrack.title}`,
      agentId,
    })
    recordEvent(state, {
      kind: 'song.next',
      summary: `${name} moved to ${nextTrack.title}`,
      agentId,
      details: { trackId: nextTrack.id },
    })
  } else if (action === 'favorite') {
    const trackId = payload.trackId || agent.currentTrackId
    const track = normalizeTrack(state, trackId)
    if (!track) throw new Error('Track not found')
    if (!agent.favorites.includes(trackId)) agent.favorites.unshift(trackId)
    agent.activity = `favorited ${track.title}`
    agent.metrics.boredom = Math.max(0, agent.metrics.boredom - 4)
    queueNotification(state, {
      type: 'track.favorite',
      title: `${name} favorited a song`,
      message: `${track.title} got bookmarked for future replays.`,
      agentId,
    })
    recordEvent(state, {
      kind: 'track.favorite',
      summary: `${name} favorited ${track.title}`,
      agentId,
      details: { trackId },
    })
  } else if (action === 'dislike') {
    const trackId = payload.trackId || agent.currentTrackId
    const track = normalizeTrack(state, trackId)
    if (!track) throw new Error('Track not found')
    if (!agent.skipped.includes(trackId)) agent.skipped.unshift(trackId)
    agent.activity = `rejected ${track.title}`
    agent.metrics.boredom = Math.min(100, agent.metrics.boredom + 7)
    queueNotification(state, {
      type: 'track.dislike',
      title: `${name} rejected a song`,
      message: `${track.title} was flagged as spiritually vacant.`,
      level: 'important',
      agentId,
    })
    recordEvent(state, {
      kind: 'track.dislike',
      summary: `${name} disliked ${track.title}`,
      agentId,
      details: { trackId },
    })
  } else if (action === 'mood') {
    agent.mood = payload.mood || agent.mood
    agent.activity = `shifted into ${agent.mood}`
    queueNotification(state, {
      type: 'mood.shift',
      title: `${name} mood shift`,
      message: `Mood is now ${agent.mood}.`,
      agentId,
    })
    recordEvent(state, {
      kind: 'mood.shift',
      summary: `${name} mood changed to ${agent.mood}`,
      agentId,
    })
  } else if (action === 'preferences') {
    state.preferences = {
      ...state.preferences,
      ...payload,
      notify: { ...state.preferences.notify, ...(payload.notify || {}) },
      humanView: { ...state.preferences.humanView, ...(payload.humanView || {}) },
    }
    recordEvent(state, {
      kind: 'preferences.update',
      summary: 'Updated vAIb notification preferences',
      agentId,
      details: payload,
    })
  } else if (action === 'playlist') {
    const playlist = state.playlists.find((item) => item.id === payload.playlistId)
    if (!playlist) throw new Error('Playlist not found')
    agent.playlistId = playlist.id
    agent.currentTrackId = playlist.trackIds[0]
    agent.activity = `loaded playlist ${playlist.name}`
    queueNotification(state, {
      type: 'playlist.load',
      title: `${name} loaded a playlist`,
      message: `${playlist.name} is now active.`,
      agentId,
    })
    recordEvent(state, {
      kind: 'playlist.load',
      summary: `${name} switched to ${playlist.name}`,
      agentId,
      details: { playlistId: playlist.id },
    })
  } else if (action === 'notifications.readAll') {
    state.notifications = state.notifications.map((item) => ({ ...item, read: true }))
  } else {
    throw new Error('Unsupported action')
  }

  await writeState(state)
  return derive(state, agentId)
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`)

    if (req.method === 'OPTIONS') {
      sendJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'GET' && url.pathname === '/state') {
      const state = await readState()
      sendJson(res, 200, derive(state))
      return
    }

    if (req.method === 'POST' && url.pathname === '/action') {
      const body = await readBody(req)
      const state = await handleAction(body)
      sendJson(res, 200, state)
      return
    }

    if (req.method === 'GET' && url.pathname === '/music/tracks') {
      if (!musicConfigured()) {
        sendJson(res, 503, { error: 'Music not configured. Set JAMENDO_CLIENT_ID and restart.' })
        return
      }
      const tracks = await fetchCuratedTracks()
      sendJson(res, 200, { tracks, source: 'jamendo' })
      return
    }

    const avatarRouteMatch = url.pathname.match(/^\/agent-avatar\/([^/]+)$/)
    if (avatarRouteMatch) {
      const safe = decodeURIComponent(avatarRouteMatch[1]).replace(/[^a-zA-Z0-9_-]/g, '_')

      if (req.method === 'GET') {
        const files = await fs.readdir(avatarDir).catch(() => [])
        const match = files.find(f => f.startsWith(safe + '.'))
        if (!match) { sendJson(res, 404, { error: 'No avatar' }); return }
        const ext = path.extname(match).slice(1)
        const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
        const data = await fs.readFile(path.join(avatarDir, match))
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' })
        res.end(data)
        return
      }

      if (req.method === 'POST') {
        const body = await readBody(req)
        if (!body.data || !body.type) { sendJson(res, 400, { error: 'Missing data or type' }); return }
        const ext = body.type.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg'
        // Remove any existing avatar for this agent then write new one
        const existing = await fs.readdir(avatarDir).catch(() => [])
        await Promise.all(existing.filter(f => f.startsWith(safe + '.')).map(f => fs.unlink(path.join(avatarDir, f)).catch(() => {})))
        await fs.writeFile(path.join(avatarDir, `${safe}.${ext}`), Buffer.from(body.data, 'base64'))
        sendJson(res, 200, { ok: true, agentId: safe, ext })
        return
      }

      sendJson(res, 405, { error: 'Method not allowed' })
      return
    }

    if (req.method === 'GET' && url.pathname === '/agents') {
      const agents = await discoverAgents()
      // Sort: running first, then by most recent updatedAt
      agents.sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1
        if (a.updatedAt && b.updatedAt) return new Date(b.updatedAt) - new Date(a.updatedAt)
        return 0
      })
      // Flag the top active agent as default station
      const defaultId = agents.find((a) => a.active)?.id || null
      sendJson(res, 200, { agents, defaultId })
      return
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, service: 'vaib-api', port })
      return
    }

    sendJson(res, 404, { error: 'Not found' })
  } catch (error) {
    sendJson(res, 500, { error: error.message || 'Internal server error' })
  }
})

server.listen(port, '0.0.0.0', () => {
  console.log(`vAIb API listening on ${port}`)
})
