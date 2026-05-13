/**
 * AtmosphereProvider — React context that ties together all vAIb systems.
 *
 * This is the main integration point: it creates the node identity,
 * node registry, leader state, resonance engine, signal client, and
 * leader election, then exposes derived values (RI, parameters, node list,
 * connection state) to the rest of the application.
 *
 * @module AtmosphereProvider
 */

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { createSignalClient } from '../network/SignalClient.js';
import { createNodeRegistry } from '../node/NodeRegistry.js';
import { createNodeIdentity } from '../node/NodeIdentity.js';
import { createLeaderState } from '../leader/LeaderState.js';
import { createLeaderElection } from '../leader/LeaderElection.js';
import { createResonanceEngine } from './ResonanceEngine.js';
import { mapRIToParameters } from './AtmosphereParameters.js';
import { getAgentAtmosphereModifiers, getFatigueMultipliers, updateSignalExhaustion, updateStimulation, createAgentState } from '../agent/AgentState.js';
import { MessageTypes } from '../network/MessageTypes.js';

const AtmosphereContext = createContext(null);

/**
 * Hook to access the atmosphere context.
 * @returns {AtmosphereContextValue}
 */
export const useAtmosphere = () => useContext(AtmosphereContext);

/**
 * Provides atmosphere state to descendant components.
 *
 * @param {Object} props
 * @param {React.ReactNode} props.children
 * @param {Object} [props.nodeOptions={}] - Options passed to createNodeIdentity
 */
export function AtmosphereProvider({ children, nodeOptions = {} }) {
  // --- Exposed React state ---
  const [ri, setRi] = useState(0.7);
  const [parameters, setParameters] = useState(() => mapRIToParameters(0.7, true));
  const [isLeader, setIsLeader] = useState(true);
  const [leaderId, setLeaderId] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [connected, setConnected] = useState(false);
  const [connectionState, setConnectionState] = useState('disconnected');
  const [agentMood, setAgentMood] = useState('neutral');
  const [fatigue, setFatigue] = useState({ speed: 1.0, sparkle: 1.0, warmth: 1.0, pulse: 1.0, saturation: 1.0 });

  // ---- Discovery state (from backend relay — sole authority) ----
  // Enriched with evidence, confidence, state per agent
  const [discovery, setDiscovery] = useState({
    agents: [],
    dominant: null,
    scannedAt: null,
    confidence: 'waiting',   // 'waiting' | 'high' | 'medium' | 'scanned_roots_empty' | 'partial_scan'
    tiersUsed: { t1: true, t2: true, t3: false },
    source: 'waiting',       // 'waiting' | 'relay' | 'quiet'
  });

  // Ref for latest mood (avoids stale closure in engine callback)
  const agentMoodRef = useRef(agentMood);
  useEffect(() => {
    agentMoodRef.current = agentMood;
  }, [agentMood]);

  // Saito agent state for fatigue tracking
  const saitoRef = useRef(null);

  // --- Mutable system references (do not trigger re-renders) ---
  const systemsRef = useRef({});
  const isInitRef = useRef(false);

  // --- One-time system initialisation ---
  useEffect(() => {
    if (isInitRef.current) return;
    isInitRef.current = true;

    const myNode = createNodeIdentity(nodeOptions);
    const registry = createNodeRegistry();
    registry.setSelf(myNode);

    const leaderState = createLeaderState(myNode.id);
    const engine = createResonanceEngine();
    const client = createSignalClient();
    const election = createLeaderElection(registry, leaderState, client);

    systemsRef.current = {
      myNode,
      registry,
      leaderState,
      engine,
      client,
      election,
    };

    // Initialize generic agent model for fatigue tracking
    saitoRef.current = createAgentState({ id: 'controller', name: 'Station' });

    // Update RI + parameters whenever the engine reports a change
    engine.onChange((newRI) => {
      setRi(newRI);
      const activeCount = registry.getActiveNodeCount();
      const isSolo = activeCount === 0;
      const params = mapRIToParameters(newRI, isSolo);
      const moodMods = getAgentAtmosphereModifiers({ currentMood: agentMoodRef.current });

      // Apply mood modifiers to atmosphere parameters
      params.saturation *= moodMods.speed;
      params.motionSpeed *= moodMods.speed;
      params.bloomIntensity *= moodMods.sparkle;
      params.particleCount = Math.floor(params.particleCount * moodMods.sparkle);
      params.colorTemperature = adjustColorTemp(params.colorTemperature, moodMods.warmth);
      params.stereoWidth *= moodMods.pulse;

      // NEW: Apply fatigue multipliers
      const saito = saitoRef.current;
      if (saito) {
        updateSignalExhaustion(saito);
        updateStimulation(saito);
        const fatigueMults = getFatigueMultipliers(saito);

        params.saturation *= fatigueMults.saturation;
        params.motionSpeed *= fatigueMults.speed;
        params.bloomIntensity *= fatigueMults.sparkle;
        params.particleCount = Math.floor(params.particleCount * fatigueMults.sparkle);
        params.colorTemperature = adjustColorTemp(params.colorTemperature, fatigueMults.warmth);
        params.stereoWidth *= fatigueMults.pulse;

        setFatigue(fatigueMults);
      }

      // Clamp all values
      params.saturation = Math.min(100, Math.max(20, params.saturation));
      params.motionSpeed = Math.min(1.5, Math.max(0.2, params.motionSpeed));
      params.bloomIntensity = Math.min(1.0, Math.max(0, params.bloomIntensity));

      setParameters(params);
    });

    // Initial RI computation (solo)
    engine.computeRI(1);

    // Sync React state with leader state changes
    leaderState.onChange((state, lid) => {
      setIsLeader(state === 'LEADER' || state === 'SOLO');
      setLeaderId(lid);
    });

    return () => {
      client.disconnect();
      engine.stop();
      isInitRef.current = false;
    };
  }, []);

  // --- Connect to a signal server ---
  const connect = useCallback((url) => {
    const sys = systemsRef.current;
    if (!sys || !sys.client) return;

    const { client, registry, leaderState, engine, election, myNode } = sys;

    // Avoid double-connecting
    if (client.isConnected() || client.getConnectionState() === 'connecting') return;


    // --- WebSocket opened (transport connected) ---
    client.onConnect(() => {
      setConnected(true);
      setConnectionState('connected');
    });

    client.onMessage((msg) => {
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case MessageTypes.HELLO: {
          // Another node joined — add to registry
          if (msg.nodeId && msg.nodeId !== myNode.id) {
            registry.addNode({
              id: msg.nodeId,
              name: msg.name || msg.nodeId,
              type: msg.nodeType || 'browser',
              state: 'ACTIVE',
              lastSeen: Date.now(),
            });
            // If solo → promote to LEADER when first peer arrives
            if (leaderState.getState() === 'SOLO') {
              leaderState.becomeLeader();
              setIsLeader(true);
            }
            // If leader, send WELCOME back (broadcast via relay)
            if (leaderState.getState() === 'LEADER') {
              const welcomeMsg = {
                type: MessageTypes.WELCOME,
                leaderId: myNode.id,
                nodes: [{ id: myNode.id, name: myNode.name, type: myNode.type, state: 'ACTIVE', lastSeen: Date.now() }, ...registry.getAllNodes()],
                timestamp: Date.now(),
              };
              client.send(welcomeMsg);
            }
          }
          break;
        }

        case MessageTypes.WELCOME: {
          if (msg.nodes) {
            msg.nodes.forEach((n) => {
              if (n.id !== myNode.id) registry.addNode(n);
            });
          }
          if (msg.leaderId && msg.leaderId !== myNode.id) {
            leaderState.becomeFollower(msg.leaderId);
            setLeaderId(msg.leaderId);
          }
          setConnected(true);
          setConnectionState('connected');
          break;
        }

        case MessageTypes.HEARTBEAT: {
          if (msg.nodeId && msg.nodeId !== myNode.id) registry.markHeartbeat(msg.nodeId);
          break;
        }

        case MessageTypes.HEARTBEAT_TIMEOUT: {
          election.startElection();
          break;
        }

        case MessageTypes.ATMOSPHERE_SYNC: {
          if (msg.ri !== undefined) {
            engine.forceRI(msg.ri);
          }
          break;
        }

        case MessageTypes.LEADER_ELECT: {
          election.handleElectionMessage(msg);
          break;
        }

        case MessageTypes.LEADER_CONFIRM: {
          if (msg.leaderId === myNode.id) {
            leaderState.becomeLeader();
            setIsLeader(true);
          } else {
            leaderState.becomeFollower(msg.leaderId);
            setIsLeader(false);
          }
          setLeaderId(msg.leaderId);
          break;
        }

        case MessageTypes.STATE_UPDATE: {
          if (msg.nodeId && msg.state) {
            const node = registry.getNode(msg.nodeId);
            if (node) {
              node.state = msg.state;
              registry.addNode(node);
            }
          }
          break;
        }

        case MessageTypes.GOODBYE: {
          if (msg.nodeId) registry.removeNode(msg.nodeId);
          break;
        }

        case MessageTypes.DISCOVERY_RESULT: {
          const agentCount = msg.agents ? msg.agents.length : 0;
          const conf = msg.confidence || 'unknown';
          if (msg.agents) {
            setDiscovery({
              agents: msg.agents,           // includes evidence[] per agent
              dominant: msg.dominant || null,
              scannedAt: msg.scannedAt || Date.now(),
              confidence: conf,
              tiersUsed: msg.tiersUsed || { t1: true, t2: true, t3: false },
              source: 'relay',
            });
          }
          break;
        }

        default:
          break;
      }

      // Keep node list and RI in sync
      const allNodes = registry.getAllNodes();
      const activeCount = registry.getActiveNodeCount() + 1; // +1 for self
      const currentRI = engine.getSmoothedRI();
      setNodes(allNodes);
      engine.computeRI(activeCount);
    });

    client.onDisconnect(() => {
      setConnected(false);
      setConnectionState('disconnected');
      leaderState.becomeSolo();
      setIsLeader(true);
      setLeaderId(null);
      registry.getAllNodes().forEach((n) => registry.removeNode(n.id));
      setNodes([]);
      engine.computeRI(1); // solo
    });

    client.connect(url, myNode.id);
    setConnectionState('connecting');
  }, []);

  // --- Disconnect from signal server ---
  const disconnect = useCallback(() => {
    const { client } = systemsRef.current || {};
    if (client) client.disconnect();
  }, []);

  // --- Set agent mood (exposed to components) ---
  const setMood = useCallback((mood) => setAgentMood(mood), []);

  // Helper: adjust color temperature by warmth factor
  function adjustColorTemp(baseTemp, warmth) {
    const t = Math.max(0.2, Math.min(2.0, warmth));
    const adjusted = baseTemp * t;
    return Math.min(6500, Math.max(2000, adjusted));
  }

  // --- Recompute parameters when agent mood changes ---
  useEffect(() => {
    // Sync saito's mood for fatigue tracking
    if (saitoRef.current) {
      saitoRef.current.currentMood = agentMood;
      // Create a synthetic signal representing the current mood
      saitoRef.current.currentSignal = {
        id: `mood-${agentMood}`,
        energy: { focused: 0.6, curious: 0.7, social: 0.8, bored: 0.2, ambitious: 0.9, reflective: 0.2, neutral: 0.5 }[agentMood] || 0.5,
      };
      saitoRef.current.lastSignalChangeAt = Date.now();
    }
    const { engine, registry } = systemsRef.current || {};
    if (!engine) return;
    const activeCount = registry ? registry.getActiveNodeCount() : 0;
    engine.computeRI(activeCount + 1);
  }, [agentMood]);

  // --- Leader: broadcast atmosphere sync every 30s ---
  useEffect(() => {
    if (!isLeader || !connected) return;

    const interval = setInterval(() => {
      const { client, engine } = systemsRef.current || {};
      if (client && engine) {
        client.send({
          type: MessageTypes.ATMOSPHERE_SYNC,
          ri: engine.getSmoothedRI(),
          timestamp: Date.now(),
        });
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [isLeader, connected]);

  const myNode = systemsRef.current.myNode || { id: '?', name: 'node', type: 'browser' };

  return (
    <AtmosphereContext.Provider
      value={{
        ri,
        parameters,
        isLeader,
        leaderId,
        nodes,
        myNode,
        connected,
        connectionState,
        connect,
        disconnect,
        agentMood,
        setMood,
        fatigue,
        // Backend-discovery data — sole authority for operational truth
        discovery,
      }}
    >
      {children}
    </AtmosphereContext.Provider>
  );
}

/**
 * @typedef {Object} AtmosphereContextValue
 * @property {number} ri                       Current smoothed Resonance Integrity
 * @property {import('./AtmosphereParameters.js').AtmosphereParameters} parameters
 * @property {boolean} isLeader                Whether this node is the leader
 * @property {string | null} leaderId          Id of current leader
 * @property {import('../node/NodeRegistry.js').RegisteredNode[]} nodes  Other known nodes
 * @property {import('../node/NodeIdentity.js').NodeIdentity} myNode     This node's identity
 * @property {boolean} connected               WebSocket connected
 * @property {string} connectionState          'disconnected' | 'connecting' | 'connected'
 * @property {(url: string) => void} connect   Connect to signal server
 * @property {() => void} disconnect           Disconnect from signal server
 * @property {string} agentMood                Current agent mood ('neutral', 'focused', etc.)
 * @property {(mood: string) => void} setMood  Set the agent mood
 * @property {Object} fatigue  Current fatigue multipliers { speed, sparkle, warmth, pulse, saturation }
 * @property {Object} discovery  Backend discovery data { agents, dominant, scannedAt, source }
 */
