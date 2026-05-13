// ============================================================
// AgentProvider — React context that wires the agent system.
//
// Exposes: agent, currentSignal, agentMood, isPlaying, toast,
// plus actions: tuneIn, mute, shiftSignal, holdSignal,
// markResonant, markStatic.
//
// The agent selects signals. The human tunes in.
//
// BACKEND IS SOLE AUTHORITY:
//   - Discovery runs on Node.js backend (server/discovery.mjs)
//   - Relay pushes DISCOVERY_RESULT via WebSocket
//   - This module is a PURE CONSUMER — never scans, never fabricates
//   - If no discovery data: station is quiet. Truth > immersion.
// ============================================================

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { useAtmosphere } from '../atmosphere/AtmosphereProvider';
import { evolveSaitoMood } from './Saito';
import { selectNextSignal, interpretShiftRequest, applyFeedback, updateAttachment, getAttachment } from './AgentState';
import { deriveSignalFromAgent, getGhostMode } from './StationDiscovery';
import { toastMessages, pickToast } from './ToastLanguage';
import { SignalEngine } from '../audio/SignalEngine';

const AgentContext = createContext(null);

export const useAgent = () => useContext(AgentContext);

// ---- Generic signal rotation — NO Saito branding ----
// These are procedural substrate signals, not authored agent content.
// They only appear when a real discovered agent is curating signals.
function buildGenericRotation(agentName) {
  return [
    {
      id: 'sig_01', title: 'Phase Bloom', artist: agentName,
      duration: 240, bpm: 90, energy: 0.7, warmth: 0.6, noise: 0.3, complexity: 0.5,
      tags: ['structured', 'energetic'],
      whyAgentKeepsIt: 'Structured energy for operational lift.',
    },
    {
      id: 'sig_02', title: 'Drift Carrier', artist: agentName,
      duration: 300, bpm: 75, energy: 0.4, warmth: 0.3, noise: 0.5, complexity: 0.6,
      tags: ['ambient', 'focus'],
      whyAgentKeepsIt: 'Deep focus lanes for extended sessions.',
    },
    {
      id: 'sig_03', title: 'Neutral Pivot', artist: agentName,
      duration: 180, bpm: 80, energy: 0.5, warmth: 0.5, noise: 0.4, complexity: 0.4,
      tags: ['neutral', 'steady'],
      whyAgentKeepsIt: 'A steady pivot between modes.',
    },
    {
      id: 'sig_04', title: 'Pulse Thread', artist: agentName,
      duration: 270, bpm: 100, energy: 0.8, warmth: 0.4, noise: 0.4, complexity: 0.7,
      tags: ['driving', 'ambition'],
      whyAgentKeepsIt: 'For moments when ambition rises.',
    },
    {
      id: 'sig_05', title: 'Quiet Channel', artist: agentName,
      duration: 360, bpm: 60, energy: 0.2, warmth: 0.7, noise: 0.2, complexity: 0.3,
      tags: ['reflective', 'quiet'],
      whyAgentKeepsIt: 'For reflective hours and recovery.',
    },
  ];
}

export function AgentProvider({ children }) {
  // ---- Backend discovery data (sole authority) ----
  const { discovery } = useAtmosphere();

  const saitoRef = useRef(null);

  const [currentSignal, setCurrentSignal] = useState(null);
  const [agentMood, setAgentMood] = useState('neutral');
  const [isPlaying, setIsPlaying] = useState(false);
  const [toast, setToast] = useState(null);

  // ---- Station composition from backend discovery ----
  // Uses agent.state from backend (active/dormant/ghost/archival)
  // instead of deriving locally.
  const [station, setStation] = useState({
    dominant: null,
    active: [],
    dormant: [],
    ghost: [],
    archival: [],
    stationMood: 'neutral',
    agentCount: 0,
    confidence: 'waiting', // from backend discovery confidence
    source: 'waiting',     // 'waiting' | 'relay' | 'quiet'
  });

  // ---- Toast helper ----
  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }, []);

  // ---- Compose station from backend discovery data ----
  useEffect(() => {
    if (!discovery || discovery.source === 'waiting') {
      // Still waiting for first DISCOVERY_RESULT from relay
      return;
    }

    if (discovery.source === 'relay') {
      const conf = discovery.confidence || 'unknown';

      const agents = discovery.agents || [];

      // Use backend-provided state (active/dormant/ghost/archival)
      // NOT derived locally. Backend is sole authority.
      const active  = agents.filter(a => a.state === 'active');
      const dormant = agents.filter(a => a.state === 'dormant');
      const ghost   = agents.filter(a => a.state === 'ghost');
      const archival = agents.filter(a => a.state === 'archival');

      const dominant = discovery.dominant || null;

      // Derive station mood from dominant agent type
      const domAgent = agents.find(a => a.id === dominant);
      const stationMood = domAgent
        ? domAgent.type === 'command' ? 'focused'
          : domAgent.type === 'field' ? 'reflective'
          : 'neutral'
        : 'neutral';

      // Attach derived signal params for atmosphere engine
      const withSignal = (list) => list.map(a => ({
        ...a,
        derivedSignal: deriveSignalFromAgent(a),
      }));

      setStation({
        dominant,
        active: withSignal(active),
        dormant: withSignal(dormant),
        ghost: withSignal(ghost),
        archival: withSignal(archival),
        stationMood,
        agentCount: agents.length,
        confidence: conf,
        source: 'relay',
      });

    }
  }, [discovery]);

  // ---- Initialize signal controller once station is known ----
  useEffect(() => {
    // Only initialize once
    if (saitoRef.current) return;

    // Create the signal controller agent.
    // If discovery found a dominant agent, the controller takes its identity.
    // Otherwise it uses a generic identity — NEVER "Saito" as default.
    const domAgent = station.source === 'relay'
      ? (station.active.find(a => a.id === station.dominant) || null)
      : null;

    const saito = domAgent
      ? {
          // Inherit from discovered dominant agent
          id: domAgent.id,
          name: domAgent.name,
          type: domAgent.type,
          presenceScore: domAgent.presenceScore || 0.8,
          currentMood: 'neutral',
          currentSignal: null,
          lastSignalChangeAt: 0,
          signalsPlayed: 0,
          signalHistory: [],
          feedback: {},
          attachment: {},
          taste: { energy: 0.5, noise: 0.3, warmth: 0.5, complexity: 0.4, pace: 0.5 },
          moodInertia: { focused: 600, curious: 300, social: 180, bored: 120, ambitious: 240, reflective: 900, neutral: 60 },
          lastMoodChange: 0,
          signalExhaustion: {},
          lastSessionStart: Date.now(),
          sessionPhase: 'fresh',
          comfortSignals: [],
        }
      : {
          // Generic controller — no named identity until discovery proves one
          id: 'controller',
          name: 'Station',
          type: 'signal',
          presenceScore: 0,
          currentMood: 'neutral',
          currentSignal: null,
          lastSignalChangeAt: 0,
          signalsPlayed: 0,
          signalHistory: [],
          feedback: {},
          attachment: {},
          taste: { energy: 0.5, noise: 0.3, warmth: 0.5, complexity: 0.4, pace: 0.5 },
          moodInertia: { focused: 600, curious: 300, social: 180, bored: 120, ambitious: 240, reflective: 900, neutral: 60 },
          lastMoodChange: 0,
          signalExhaustion: {},
          lastSessionStart: Date.now(),
          sessionPhase: 'fresh',
          comfortSignals: [],
        };

    if (domAgent) {
      const derived = deriveSignalFromAgent(domAgent);
      saito.taste = {
        energy: derived.energy,
        noise: derived.noise,
        warmth: derived.warmth,
        complexity: derived.complexity,
        pace: derived.pace,
      };
    } else {
    }

    // Build rotation — generic procedural signals, no Saito branding
    saito.rotation = buildGenericRotation(saito.name);

    const firstSignal = selectNextSignal(saito);
    saito.currentSignal = firstSignal;
    saito.lastSignalChangeAt = Date.now();
    saito.signalsPlayed = 1;
    if (firstSignal?.id) {
      saito.signalHistory.push(firstSignal.id);
    }

    saitoRef.current = saito;
    setCurrentSignal(firstSignal);
    setAgentMood(saito.currentMood);
    showToast(pickToast(toastMessages.signalSelected, saito, firstSignal));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [station.source, station.dominant]);

  // ---- Timeout: if no DISCOVERY_RESULT within 5s, mark as quiet ----
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!station.source || station.source === 'waiting') {
        setStation(prev => ({
          ...prev,
          source: 'quiet',
          dominant: null,
          active: [],
          ghost: [],
          stationMood: 'neutral',
        }));
      }
    }, 5000);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- "Tune In" — human starts listening to the agent's stream ----
  const tuneIn = useCallback(() => {
    const saito = saitoRef.current;
    if (!saito || !saito.currentSignal) return;

    setIsPlaying(true);

    // Start the signal engine
    SignalEngine.init();
    SignalEngine.tuneIn(saito.currentSignal, saito.currentMood);

    // Sparse toast ritual — quiet, rare
    const toasts = [
      { delay: 5000,  msg: saito.name + ' opened the channel.' },
      { delay: 20000, msg: 'Signal stabilizing.' },
      { delay: 45000, msg: saito.name + ' is listening.' },
    ];

    toasts.forEach(({ delay, msg }) => {
      setTimeout(() => {
        if (saitoRef.current) showToast(msg);
      }, delay);
    });
  }, [showToast]);

  // ---- "Mute" — human stops local audio ----
  const mute = useCallback(() => {
    setIsPlaying(false);
    SignalEngine.mute();
  }, []);

  // ---- "Shift Signal" — human nudges; agent interprets ----
  const shiftSignal = useCallback(() => {
    const saito = saitoRef.current;
    if (!saito) return;

    // Update attachment to current signal before leaving
    updateAttachment(saito);

    // 20% chance: agent ignores shift if attachment > 0.5
    const currentAttachment = getAttachment(saito, saito.currentSignal?.id);
    if (currentAttachment > 0.5 && Math.random() < 0.2) {
      showToast(saito.name + ' is still exploring this signal.');
      return;
    }

    const { signal, reason } = interpretShiftRequest(saito);
    if (!signal) return;

    saito.currentSignal = signal;
    saito.lastSignalChangeAt = Date.now();
    saito.signalsPlayed += 1;
    saito.signalHistory.push(signal.id);

    // Trim history to last 20
    if (saito.signalHistory.length > 20) {
      saito.signalHistory = saito.signalHistory.slice(-20);
    }

    // Evolve mood organically
    saito.currentMood = evolveSaitoMood(saito);

    setCurrentSignal(signal);
    setAgentMood(saito.currentMood);
    showToast(reason);
  }, [showToast]);

  // ---- "Hold Signal" — human wants to revisit / hold ----
  const holdSignal = useCallback(() => {
    const saito = saitoRef.current;
    if (!saito || !saito.currentSignal) return;
    showToast(
      pickToast(toastMessages.signalHeld, saito, saito.currentSignal)
    );
  }, [showToast]);

  // ---- "Mark Resonant" — positive feedback ----
  const markResonant = useCallback(() => {
    const saito = saitoRef.current;
    if (!saito || !saito.currentSignal) return;
    applyFeedback(saito, saito.currentSignal.id, 'resonant');
    showToast(
      pickToast(toastMessages.feedbackAcknowledged, saito, 'resonant')
    );
  }, [showToast]);

  // ---- "Mark Static" — negative feedback ----
  const markStatic = useCallback(() => {
    const saito = saitoRef.current;
    if (!saito || !saito.currentSignal) return;
    applyFeedback(saito, saito.currentSignal.id, 'static');
    showToast(
      pickToast(toastMessages.feedbackAcknowledged, saito, 'static')
    );
  }, [showToast]);

  return (
    <AgentContext.Provider
      value={{
        agent:          saitoRef.current,
        station,        // composed from backend DISCOVERY_RESULT
        currentSignal,
        agentMood,
        isPlaying,
        toast,
        // ---- Core actions ----
        tuneIn,
        mute,
        // ---- Influence actions (reframed: influence, not command) ----
        nudgeDrift:    shiftSignal,    // was: shiftSignal — suggest a direction change
        suggestLinger: holdSignal,     // was: holdSignal — suggest staying
        resonates:     markResonant,   // was: markResonant — positive feedback
        tooMuchStatic: markStatic,     // was: markStatic — negative feedback
        // ---- Aliases for backward compat (deprecated) ----
        shiftSignal, holdSignal, markResonant, markStatic,
      }}
    >
      {children}
    </AgentContext.Provider>
  );
}
