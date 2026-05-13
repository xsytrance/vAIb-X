/**
 * WebSocket signalling client for browser nodes.
 * Handles connection, auto-reconnect, heartbeat emission/detection,
 * and JSON message framing.
 *
 * @module SignalClient
 */

import { MessageTypes } from './MessageTypes.js';

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
const HEARTBEAT_INTERVAL_MS = 10000;
const HEARTBEAT_TIMEOUT_MS = 30000;

/**
 * Create a WebSocket signalling client.
 *
 * @returns {SignalClientAPI} The client API
 */
export function createSignalClient() {
  /** @type {WebSocket | null} */
  let ws = null;
  /** @type {string | null} */
  let nodeId = null;
  /** @type {'disconnected' | 'connecting' | 'connected'} */
  let state = 'disconnected';
  /** @type {number} */
  let reconnectAttempt = 0;
  /** @type {ReturnType<setTimeout> | null} */
  let reconnectTimer = null;
  /** @type {ReturnType<setInterval> | null} */
  let heartbeatInterval = null;
  /** @type {ReturnType<setTimeout> | null} */
  let heartbeatTimeout = null;
  /** @type {ReturnType<setTimeout> | null} */
  let electionJitterTimer = null;

  /** @type {Set<(msg: any) => void>} */
  const msgListeners = new Set();
  /** @type {Set<() => void>} */
  const connectListeners = new Set();
  /** @type {Set<() => void>} */
  const disconnectListeners = new Set();

  const notifyMessage = (msg) => msgListeners.forEach((cb) => cb(msg));
  const notifyConnect = () => connectListeners.forEach((cb) => cb());
  const notifyDisconnect = () => disconnectListeners.forEach((cb) => cb());

  const clearTimers = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
    if (electionJitterTimer) clearTimeout(electionJitterTimer);
    reconnectTimer = null;
    heartbeatInterval = null;
    heartbeatTimeout = null;
    electionJitterTimer = null;
  };

  const resetHeartbeatTimeout = () => {
    if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
    heartbeatTimeout = setTimeout(() => {
      notifyMessage({
        type: MessageTypes.HEARTBEAT_TIMEOUT,
        nodeId,
        timestamp: Date.now(),
      });
    }, HEARTBEAT_TIMEOUT_MS);
  };

  const startHeartbeat = () => {
    heartbeatInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN && nodeId) {
        ws.send(JSON.stringify({
          type: MessageTypes.HEARTBEAT,
          nodeId,
          timestamp: Date.now(),
        }));
      }
    }, HEARTBEAT_INTERVAL_MS);
  };

  const doConnect = (url, id) => {
    nodeId = id;
    state = 'connecting';

    try {
      ws = new WebSocket(url);
    } catch (err) {
      state = 'disconnected';
      scheduleReconnect(url);
      return;
    }

    ws.onopen = () => {
      state = 'connected';
      reconnectAttempt = 0;
      // WS connected, sending HELLO
      ws.send(JSON.stringify({
        type: MessageTypes.HELLO,
        nodeId,
        timestamp: Date.now(),
      }));
      startHeartbeat();
      resetHeartbeatTimeout();
      notifyConnect();
    };

    ws.onmessage = (event) => {
      resetHeartbeatTimeout();
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        console.warn('[SignalClient] failed to parse message:', event.data);
        return;
      }
      // WS message received
      notifyMessage(msg);
    };

    ws.onclose = () => {
      ws = null;
      state = 'disconnected';
      clearTimers();
      notifyDisconnect();
      scheduleReconnect(url);
    };

    ws.onerror = () => {
      // Errors are followed by onclose; handled there
    };
  };

  const scheduleReconnect = (url) => {
    if (reconnectTimer) return;
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      doConnect(url, nodeId);
    }, delay);
  };

  return {
    connect: (url, id) => {
      if (ws) return;
      reconnectAttempt = 0;
      doConnect(url, id);
    },

    disconnect: () => {
      clearTimers();
      if (ws) {
        try {
          if (ws.readyState === WebSocket.OPEN && nodeId) {
            ws.send(JSON.stringify({
              type: MessageTypes.GOODBYE,
              nodeId,
              timestamp: Date.now(),
            }));
          }
          ws.close();
        } catch {
          // ignore close errors
        }
        ws = null;
      }
      state = 'disconnected';
    },

    send: (message) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    },

    onMessage: (callback) => {
      msgListeners.add(callback);
      return () => msgListeners.delete(callback);
    },

    onConnect: (callback) => {
      connectListeners.add(callback);
      return () => connectListeners.delete(callback);
    },

    onDisconnect: (callback) => {
      disconnectListeners.add(callback);
      return () => disconnectListeners.delete(callback);
    },

    isConnected: () => state === 'connected' && ws !== null && ws.readyState === WebSocket.OPEN,

    getConnectionState: () => state,
  };
}

/**
 * @typedef {Object} SignalClientAPI
 * @property {(url: string, nodeId: string) => void} connect
 * @property {() => void} disconnect
 * @property {(message: any) => void} send
 * @property {(callback: (msg: any) => void) => (() => void)} onMessage
 * @property {(callback: () => void) => (() => void)} onConnect
 * @property {(callback: () => void) => (() => void)} onDisconnect
 * @property {() => boolean} isConnected
 * @property {() => 'disconnected' | 'connecting' | 'connected'} getConnectionState
 */
