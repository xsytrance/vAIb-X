// ============================================================
// server/discovery.mjs — REAL filesystem/process discovery.
//
// Tiered scan with source-of-truth inspectability.
//
// Every detected agent carries structured evidence:
//   type, path, confidence, lastModified, scoreContribution
//
// NO synthetic data. NO silent fallbacks. NO mock agents.
// If nothing is found, the result is empty. Period.
//
// FALSE NEGATIVES > FALSE POSITIVES.
// Fake presence is worse than quiet.
//
// Environment: Node.js 18+ on the PRIME machine.
// Cannot run browser context.
// ============================================================

import { promises as fs, existsSync, statSync, readdirSync } from 'fs';
import { homedir, hostname, userInfo } from 'os';
import { execSync } from 'child_process';
import { join, basename as pathBasename } from 'path';

const HOME = homedir();
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

// ---- TIER CONFIGURATION ----
// Tier 1: Fast canonical — known paths, processes, sessions (always)
// Tier 2: Light home scan — shallow scan of /home/* (default on)
// Tier 3: Deep scan — wider search, user-initiated (default off)

const DEFAULT_TIERS = { t1: true, t2: true, t3: false };

// ---- EXCLUDE LIST — never scan these ----
const EXCLUDED_DIRS = new Set([
  '/proc', '/sys', '/dev', '/run', '/boot', '/tmp',
  'node_modules', '.git', '.cache', '.gradle',
  '.npm', 'npm-cache', '.venv', 'venv', '.tox',
  '__pycache__', '.pytest_cache', '.mypy_cache',
  'dist', 'build', '.next', '.nuxt', 'target',
  '.idea', '.vscode', '.DS_Store',
]);

// ---- AGENT ALIASES ----
// Each agent may be known by multiple names across the system.
const AGENT_ALIASES = {
  vg_god:   { aliases: ['vggod', 'vg-god', 'prime', 'vgod'], displayName: 'VG God' },
  saito:    { aliases: ['sai', 'saito-signal'], displayName: 'Saito' },
  snake:    { aliases: ['solid_snake', 'solid-snake', 'snake-agent'], displayName: 'Snake' },
  davinci:  { aliases: ['dacinci', 'da-vinci', 'davinci-agent'], displayName: 'daVinci' },
  ultron:   { aliases: ['supersort', 'ultron-sort'], displayName: 'Ultron / Supersort' },
  hermes:   { aliases: ['hermes-cli', 'hermes-router'], displayName: 'Hermes' },
  openclaw: { aliases: ['open-claw', 'claw'], displayName: 'OpenClaw' },
  hanzo:    { aliases: ['han', 'ninja'], displayName: 'Hanzo' },
};

// ---- KNOWN AGENT SIGNATURES — canonical paths and process names ----

function buildSignatures() {
  const s = {};

  for (const [id, meta] of Object.entries(AGENT_ALIASES)) {
    const names = [id, ...meta.aliases];
    s[id] = {
      id,
      name: meta.displayName || id,
      type: inferAgentType(id),
      // Canonical dot-directories
      directories: names.flatMap(n => [
        join(HOME, `.${n}`),
        join(HOME, '.config', n),
        join(HOME, n),
        join(HOME, '.local', 'share', n),
      ]),
      // Process names to match (basename-exact)
      processPatterns: names,
      configFiles: ['config.json', 'profile.json', `${id}.json`],
      personality: AGENT_PERSONALITIES[id] || 'operational agent',
    };
  }

  return s;
}

const AGENT_PERSONALITIES = {
  vg_god:   'operational intensity, strict rhythm, cold precision',
  saito:    'reflective focus, emotional drift, restrained',
  snake:    'sharp, fast, unstable, experimental',
  davinci:  'creative, slow, exploratory, artistic',
  ultron:   'ruthless efficiency, sorting, categorization, cold',
  hermes:   'messaging, routing, connection, flow',
  openclaw: 'open, scraping, gathering, restless',
  hanzo:    'silent, precise, watchful, tactical',
};

function inferAgentType(id) {
  if (['vg_god', 'ultron', 'hermes'].includes(id)) return 'command';
  if (['snake', 'openclaw', 'hanzo'].includes(id)) return 'field';
  return 'signal';
}

// ---- EVIDENCE MODEL ----
// Every piece of evidence is structured, inspectable, scored.

const TRUST_LEVELS = { high: 0.95, medium: 0.70, low: 0.40 };

function createEvidence(type, path, opts = {}) {
  return {
    type,           // 'directory' | 'config' | 'process' | 'session' | 'workspace' | 'tier2_scan'
    path,           // filesystem path or process command
    confidence: opts.confidence || TRUST_LEVELS.medium,
    lastModified: opts.lastModified || null,
    scoreContribution: opts.scoreContribution || 0,
    detail: opts.detail || null,   // extra context (pid, session type, etc.)
  };
}

// ---- AUDIT LOG ----

const auditLog = [];

function audit(category, message, data = {}) {
  const entry = { timestamp: new Date().toISOString(), category, message, ...data };
  auditLog.push(entry);
}

export function getAuditLog() { return auditLog; }
export function clearAudit() { auditLog.length = 0; }

// ---- HELPER: should exclude path? ----

function shouldExcludePath(p) {
  const parts = p.split('/');
  for (const part of parts) {
    if (EXCLUDED_DIRS.has(part)) return true;
  }
  // Exclude absolute system paths
  if (p.startsWith('/proc/') || p.startsWith('/sys/') || p.startsWith('/dev/')) return true;
  return false;
}

// ---- HELPER: safe stat ----

function safeStat(p) {
  try { return statSync(p); } catch { return null; }
}

// ---- TIER 1: CANONICAL SCAN ----

async function scanTier1(signature) {
  const evidence = [];
  let score = 0;

  // 1A: Known directories
  for (const dir of signature.directories) {
    if (shouldExcludePath(dir)) continue;

    const st = safeStat(dir);
    if (st && st.isDirectory()) {
      evidence.push(createEvidence('directory', dir, {
        confidence: TRUST_LEVELS.high,
        lastModified: st.mtime.getTime(),
        scoreContribution: 0.15,
        detail: 'canonical path',
      }));
      score += 0.15;
      audit('T1_DIR', `Found: ${dir}`, { agent: signature.id, score: 0.15 });

      // Files inside directory
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        let lastModified = 0;
        let fileCount = 0;

        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const fp = join(dir, entry.name);
          if (shouldExcludePath(fp)) continue;

          const fst = safeStat(fp);
          if (!fst) continue;

          fileCount++;
          if (fst.mtime.getTime() > lastModified) lastModified = fst.mtime.getTime();
        }

        // Recency scoring
        if (lastModified > 0) {
          const age = (NOW - lastModified) / DAY;
          if (age < 1) {
            score += 0.35;
            evidence.push(createEvidence('directory', dir, {
              confidence: TRUST_LEVELS.high,
              lastModified,
              scoreContribution: 0.35,
              detail: `files modified today (${fileCount} files)`,
            }));
            audit('T1_DIR', `Files TODAY in ${dir} (${fileCount} files)`, { agent: signature.id, score: 0.35 });
          } else if (age < 7) {
            score += 0.20;
            evidence.push(createEvidence('directory', dir, {
              confidence: TRUST_LEVELS.medium,
              lastModified,
              scoreContribution: 0.20,
              detail: `files modified this week (${fileCount} files)`,
            }));
            audit('T1_DIR', `Files THIS WEEK in ${dir}`, { agent: signature.id, score: 0.20 });
          } else if (age < 30) {
            score += 0.10;
            evidence.push(createEvidence('directory', dir, {
              confidence: TRUST_LEVELS.low,
              lastModified,
              scoreContribution: 0.10,
              detail: `files modified this month`,
            }));
            audit('T1_DIR', `Files THIS MONTH in ${dir}`, { agent: signature.id, score: 0.10 });
          }
        }

        // Activity scale
        if (fileCount > 50) {
          score += 0.10;
          evidence.push(createEvidence('directory', dir, {
            confidence: TRUST_LEVELS.medium,
            scoreContribution: 0.10,
            detail: `high activity: ${fileCount} files`,
          }));
          audit('T1_DIR', `High activity: ${fileCount} files`, { agent: signature.id, score: 0.10 });
        } else if (fileCount > 10) {
          score += 0.05;
          evidence.push(createEvidence('directory', dir, {
            confidence: TRUST_LEVELS.medium,
            scoreContribution: 0.05,
            detail: `moderate activity: ${fileCount} files`,
          }));
          audit('T1_DIR', `Moderate activity: ${fileCount} files`, { agent: signature.id, score: 0.05 });
        }

        // Config files
        if (signature.configFiles) {
          for (const cfg of signature.configFiles) {
            const cfgPath = join(dir, cfg);
            if (existsSync(cfgPath)) {
              score += 0.10;
              const cst = safeStat(cfgPath);
              evidence.push(createEvidence('config', cfgPath, {
                confidence: TRUST_LEVELS.high,
                lastModified: cst?.mtime.getTime() || null,
                scoreContribution: 0.10,
                detail: `config file`,
              }));
              audit('T1_CONFIG', `Config: ${cfgPath}`, { agent: signature.id, score: 0.10 });
            }
          }
        }

        // Workspace subdirectory
        const wsDir = join(dir, 'workspace');
        const wsSt = safeStat(wsDir);
        if (wsSt && wsSt.isDirectory()) {
          try {
            const wsEntries = readdirSync(wsDir, { withFileTypes: true });
            let wsRecent = 0;
            for (const e of wsEntries) {
              if (!e.isFile()) continue;
              const wfp = join(wsDir, e.name);
              const wfst = safeStat(wfp);
              if (wfst && (NOW - wfst.mtime.getTime()) / DAY < 7) wsRecent++;
            }
            if (wsRecent > 0) {
              const wsScore = Math.min(0.15, wsRecent * 0.03);
              score += wsScore;
              evidence.push(createEvidence('workspace', wsDir, {
                confidence: TRUST_LEVELS.medium,
                scoreContribution: wsScore,
                detail: `${wsRecent} recent workspace files`,
              }));
              audit('T1_WORKSPACE', `Workspace: ${wsRecent} files in ${wsDir}`, { agent: signature.id, score: wsScore });
            }
          } catch { /* ignore */ }
        }

      } catch (err) {
        audit('T1_ERR', `Cannot read ${dir}: ${err.message}`, { agent: signature.id });
      }
    }
  }

  // 1B: Process scan (basename-exact matching)
  const procEvidence = scanProcessesSafe(signature);
  if (procEvidence.length > 0) {
    for (const pe of procEvidence) {
      score += pe.scoreContribution;
      evidence.push(pe);
    }
  }

  // 1C: Session scan (tmux, systemd)
  const sessionEvidence = scanSessionsSafe(signature);
  if (sessionEvidence.length > 0) {
    for (const se of sessionEvidence) {
      score += se.scoreContribution;
      evidence.push(se);
    }
  }

  return { evidence, score };
}

// ---- PROCESS SCAN (safe basename matching) ----

function scanProcessesSafe(signature) {
  const evidence = [];

  try {
    const output = execSync('ps aux', { encoding: 'utf-8', timeout: 5000 });
    const lines = output.split('\n');

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;

      const pid = parts[1];
      const cmdStart = parts.slice(10).join(' ');

      // System exclusions
      const exclusions = ['grep', 'vscode', 'discovery', 'ps aux', 'sleep', 'bash -c', 'sh -c', 'ssh ', 'systemd'];
      const cmdLower = cmdStart.toLowerCase();
      if (exclusions.some(ex => cmdLower.includes(ex))) continue;

      for (const pattern of signature.processPatterns) {
        const patLower = pattern.toLowerCase();

        // Extract basename from first token
        const firstToken = parts[10] || '';
        const cmdBase = pathBasename(firstToken.replace(/[,;:"'!@#$%^&*()\[\]{}]/g, '')).toLowerCase();

        // Exact basename match
        if (cmdBase === patLower) {
          evidence.push(createEvidence('process', cmdStart, {
            confidence: TRUST_LEVELS.high,
            scoreContribution: 0.40,
            detail: `PID ${pid}`,
          }));
          audit('T1_PROC', `RUNNING: ${cmdStart} (PID ${pid})`, { agent: signature.id, score: 0.40, pid });
          break;
        }

        // Token match (each command-line argument as basename)
        const tokens = cmdStart.split(/\s+/).map(t => pathBasename(t.replace(/[,;:"'!@#$%^&*()\[\]{}]/g, '')).toLowerCase());
        if (tokens.includes(patLower)) {
          evidence.push(createEvidence('process', cmdStart, {
            confidence: TRUST_LEVELS.high,
            scoreContribution: 0.40,
            detail: `PID ${pid}`,
          }));
          audit('T1_PROC', `RUNNING: ${cmdStart} (PID ${pid})`, { agent: signature.id, score: 0.40, pid });
          break;
        }

        // Hyphen/underscore variant
        const variant = patLower.replace(/-/g, '_');
        if (cmdBase === variant || tokens.includes(variant)) {
          evidence.push(createEvidence('process', cmdStart, {
            confidence: TRUST_LEVELS.high,
            scoreContribution: 0.40,
            detail: `PID ${pid} (alias match)`,
          }));
          audit('T1_PROC', `RUNNING (alias): ${cmdStart} (PID ${pid})`, { agent: signature.id, score: 0.40, pid });
          break;
        }
      }
    }
  } catch (err) {
    audit('T1_PROC_ERR', `Cannot scan processes: ${err.message}`, { agent: signature.id });
  }

  return evidence;
}

// ---- SESSION SCAN (tmux, systemd) ----

function scanSessionsSafe(signature) {
  const evidence = [];
  const searchTerms = [...signature.processPatterns, signature.id];

  // tmux
  try {
    const output = execSync('tmux list-sessions 2>/dev/null || true', { encoding: 'utf-8', timeout: 3000 });
    for (const line of output.split('\n')) {
      for (const term of searchTerms) {
        if (line.toLowerCase().includes(term.toLowerCase())) {
          const sessionName = line.split(':')[0];
          evidence.push(createEvidence('session', `tmux:${sessionName}`, {
            confidence: TRUST_LEVELS.high,
            scoreContribution: 0.15,
            detail: `tmux session "${sessionName}"`,
          }));
          audit('T1_SESSION', `tmux session: ${sessionName}`, { agent: signature.id, score: 0.15 });
        }
      }
    }
  } catch { /* tmux not available */ }

  // systemd user services
  try {
    const output = execSync('systemctl --user list-units --type=service --state=running 2>/dev/null || true', {
      encoding: 'utf-8', timeout: 3000,
    });
    for (const line of output.split('\n')) {
      for (const term of searchTerms) {
        if (line.toLowerCase().includes(term.toLowerCase())) {
          evidence.push(createEvidence('session', `systemd:${line.trim()}`, {
            confidence: TRUST_LEVELS.medium,
            scoreContribution: 0.15,
            detail: `systemd user service`,
          }));
          audit('T1_SESSION', `systemd: ${line.trim()}`, { agent: signature.id, score: 0.15 });
        }
      }
    }
  } catch { /* systemd not available */ }

  return evidence;
}

// ---- TIER 2: LIGHT HOME SCAN ----
// Shallow scan of /home/* for agent-named directories (max depth 3)

async function scanTier2(signature) {
  const evidence = [];
  let score = 0;
  const names = [signature.id, ...AGENT_ALIASES[signature.id]?.aliases || []];

  // Determine which home directories to scan
  const homeRoots = new Set([HOME]);
  try {
    const homeParent = '/home';
    if (existsSync(homeParent)) {
      const entries = readdirSync(homeParent, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) homeRoots.add(join(homeParent, e.name));
      }
    }
  } catch { /* /home not readable */ }

  // Also check /root if accessible
  if (existsSync('/root')) homeRoots.add('/root');

  // Expanded search roots
  const expandedRoots = [];
  for (const root of homeRoots) {
    expandedRoots.push(root);
    expandedRoots.push(join(root, '.config'));
    expandedRoots.push(join(root, '.local', 'share'));
    expandedRoots.push(join(root, 'workspace'));
    expandedRoots.push(join(root, 'Workspace'));
    expandedRoots.push(join(root, 'agents'));
    expandedRoots.push(join(root, 'Agents'));
    expandedRoots.push(join(root, 'projects'));
    expandedRoots.push(join(root, 'Projects'));
    expandedRoots.push(join(root, 'repos'));
    expandedRoots.push(join(root, 'Repos'));
    expandedRoots.push(join(root, 'solar-ops'));
    expandedRoots.push(join(root, 'MasterDrive'));
  }

  for (const root of expandedRoots) {
    if (!existsSync(root) || shouldExcludePath(root)) continue;

    try {
      const entries = readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dirName = entry.name.toLowerCase();

        // Check if directory name matches any agent name or alias
        for (const name of names) {
          const nameLower = name.toLowerCase();
          // Exact match or normalized match (hyphens/underscores)
          const dirNormalized = dirName.replace(/[-_]/g, '');
          const nameNormalized = nameLower.replace(/[-_]/g, '');

          if (dirName === nameLower || dirNormalized === nameNormalized) {
            const fullPath = join(root, entry.name);
            if (shouldExcludePath(fullPath)) continue;

            // Check if we already found this in Tier 1 (avoid double-counting)
            const alreadyFound = evidence.some(e =>
              e.type === 'directory' && e.path === fullPath
            );
            if (alreadyFound) continue;

            const st = safeStat(fullPath);
            const lastMod = st?.mtime.getTime() || null;

            evidence.push(createEvidence('directory', fullPath, {
              confidence: TRUST_LEVELS.medium,
              lastModified: lastMod,
              scoreContribution: 0.10,
              detail: `Tier 2 discovery: matched "${name}" in ${root}`,
            }));
            score += 0.10;
            audit('T2_SCAN', `Found "${entry.name}" in ${root} (matched alias "${name}")`, {
              agent: signature.id, score: 0.10, path: fullPath,
            });

            // Look for config inside
            for (const cfg of signature.configFiles) {
              const cfgPath = join(fullPath, cfg);
              if (existsSync(cfgPath)) {
                evidence.push(createEvidence('config', cfgPath, {
                  confidence: TRUST_LEVELS.medium,
                  scoreContribution: 0.08,
                  detail: `config inside Tier 2 directory`,
                }));
                score += 0.08;
                audit('T2_CONFIG', `Config in ${fullPath}: ${cfg}`, { agent: signature.id, score: 0.08 });
              }
            }
          }
        }
      }
    } catch { /* can't read directory */ }
  }

  return { evidence, score };
}


// ---- TIER 3: OPTIONAL DEEP SCAN ----
// Only runs if explicitly enabled. Wider search with careful exclusions.

async function scanTier3(signature, opts = {}) {
  const evidence = [];
  let score = 0;

  if (!opts.t3) return { evidence, score };

  audit('T3', 'Deep scan enabled — searching wider paths', { agent: signature.id });

  const names = [signature.id, ...AGENT_ALIASES[signature.id]?.aliases || []];

  // Wider but bounded search: /opt, /usr/local, /var/log
  const deepRoots = ['/opt', '/usr/local', '/var/log'];
  const maxDepth = 3;

  for (const root of deepRoots) {
    if (!existsSync(root) || shouldExcludePath(root)) continue;

    try {
      scanDirRecursive(root, 0, maxDepth, names, signature, evidence);
    } catch { /* skip */ }
  }

  // Count unique evidence (not duplicated paths)
  const seenPaths = new Set();
  for (const e of evidence) {
    if (!seenPaths.has(e.path)) {
      seenPaths.add(e.path);
      score += e.scoreContribution;
    }
  }

  return { evidence, score };
}

function scanDirRecursive(dir, depth, maxDepth, names, signature, evidence) {
  if (depth > maxDepth) return;
  if (shouldExcludePath(dir)) return;

  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name.toLowerCase();

    for (const name of names) {
      const nameLower = name.toLowerCase();
      const dirNormalized = dirName.replace(/[-_]/g, '');
      const nameNormalized = nameLower.replace(/[-_]/g, '');

      if (dirName === nameLower || dirNormalized === nameNormalized) {
        const fullPath = join(dir, entry.name);
        const st = safeStat(fullPath);

        evidence.push(createEvidence('directory', fullPath, {
          confidence: TRUST_LEVELS.low,
          lastModified: st?.mtime.getTime() || null,
          scoreContribution: 0.05,
          detail: `Tier 3 deep scan (depth ${depth})`,
        }));
        audit('T3', `Deep found: ${fullPath}`, { agent: signature.id, score: 0.05 });
      }
    }

    // Recurse
    scanDirRecursive(join(dir, entry.name), depth + 1, maxDepth, names, signature, evidence);
  }
}

// ---- STATE DETERMINATION ----
// ACTIVE/DORMANT/GHOST/ARCHIVAL from evidence age and strength

function determineState(score, evidence) {
  if (score <= 0) return 'archival';

  // Check for high-confidence active indicators
  const hasProcess = evidence.some(e => e.type === 'process' && e.confidence >= TRUST_LEVELS.high);
  const hasSession = evidence.some(e => e.type === 'session');
  const hasTodayFiles = evidence.some(e =>
    e.lastModified && (NOW - e.lastModified) / DAY < 1
  );

  if (hasProcess || hasSession || hasTodayFiles) {
    return 'active';
  }

  // Check recency of best evidence
  let mostRecent = 0;
  for (const e of evidence) {
    if (e.lastModified && e.lastModified > mostRecent) mostRecent = e.lastModified;
  }

  if (mostRecent > 0) {
    const age = (NOW - mostRecent) / DAY;
    if (age < 7) return 'dormant';      // this week
    if (age < 30) return 'ghost';       // this month
  }

  // Has evidence but very old
  if (score > 0.05) return 'ghost';
  return 'archival';
}

function determineDiscoveryConfidence(agents, tiers) {
  if (agents.length === 0) {
    if (tiers.t1 && tiers.t2) return 'scanned_roots_empty';
    return 'partial_scan';
  }
  const hasHighTrust = agents.some(a =>
    a.evidence?.some(e => e.confidence >= TRUST_LEVELS.high)
  );
  if (hasHighTrust) return 'high';
  return 'medium';
}

// ---- COMPOSE FINAL DISCOVERY ----

export async function runDiscovery(opts = {}) {
  clearAudit();

  const tiers = { ...DEFAULT_TIERS, ...opts.tiers };
  const signatures = buildSignatures();

  audit('START', `Discovery starting on ${hostname()} at ${new Date().toISOString()}`);
  audit('START', `Scanning ${Object.keys(signatures).length} agent signatures`);
  audit('START', `Tiers: T1=${tiers.t1} T2=${tiers.t2} T3=${tiers.t3}`);

  const agents = [];

  for (const [id, signature] of Object.entries(signatures)) {
    audit('AGENT', `Scanning for ${id} (${signature.name})...`);

    const allEvidence = [];
    let totalScore = 0;

    // Tier 1: Canonical (always)
    if (tiers.t1) {
      const t1 = await scanTier1(signature);
      allEvidence.push(...t1.evidence);
      totalScore += t1.score;
      audit('AGENT_TIER', `${id}: T1 score=${t1.score.toFixed(2)}, evidence=${t1.evidence.length}`);
    }

    // Tier 2: Light home scan (default)
    if (tiers.t2) {
      const t2 = await scanTier2(signature);
      // Only add T2 evidence for paths not already found in T1
      for (const e of t2.evidence) {
        const alreadyHave = allEvidence.some(existing => existing.path === e.path && existing.type === e.type);
        if (!alreadyHave) {
          allEvidence.push(e);
          totalScore += e.scoreContribution;
        }
      }
      audit('AGENT_TIER', `${id}: after T2 score=${totalScore.toFixed(2)}, evidence=${allEvidence.length}`);
    }

    // Tier 3: Deep scan (optional)
    if (tiers.t3) {
      const t3 = await scanTier3(signature, opts);
      for (const e of t3.evidence) {
        const alreadyHave = allEvidence.some(existing => existing.path === e.path);
        if (!alreadyHave) {
          allEvidence.push(e);
          totalScore += e.scoreContribution;
        }
      }
    }

    totalScore = Math.min(1.0, totalScore);

    // Only include agents with SOME evidence
    if (totalScore > 0.01 && allEvidence.length > 0) {
      const state = determineState(totalScore, allEvidence);

      // Determine last active timestamp
      let lastActive = 0;
      for (const e of allEvidence) {
        if (e.type === 'process') { lastActive = NOW; break; }
        if (e.lastModified && e.lastModified > lastActive) lastActive = e.lastModified;
      }

      // Build summary for audit
      const evidenceSummary = allEvidence.map(e =>
        `${e.type}:${pathBasename(e.path)}(+${e.scoreContribution.toFixed(2)})`
      ).join(', ');

      agents.push({
        id: signature.id,
        name: signature.name,
        type: signature.type,
        personality: signature.personality,
        presenceScore: totalScore,
        lastActiveAt: lastActive || null,
        state,                              // 'active' | 'dormant' | 'ghost' | 'archival'
        evidence: allEvidence,              // structured evidence for inspectability
        evidenceCount: allEvidence.length,
      });

      audit('AGENT_RESULT', `${signature.id}: presence=${totalScore.toFixed(2)} state=${state} evidence=${allEvidence.length}`, {
        agent: id,
        score: totalScore,
        state,
        evidence: evidenceSummary,
      });
    } else {
      audit('AGENT_RESULT', `${signature.id}: NOT FOUND (score ${totalScore.toFixed(2)})`, { agent: id });
    }
  }

  // Determine dominant
  const sorted = [...agents].sort((a, b) => b.presenceScore - a.presenceScore);
  const dominant = sorted[0]?.id || null;
  const confidence = determineDiscoveryConfidence(sorted, tiers);

  audit('FINAL', `Discovery complete. ${agents.length} agents found.`, {
    agentCount: agents.length,
    dominant,
    confidence,
    agents: sorted.map(a => `${a.id}=${a.presenceScore.toFixed(2)}(${a.state})`).join(', '),
  });

  if (dominant) {
    audit('FINAL', `DOMINANT: ${dominant} (score ${sorted[0].presenceScore.toFixed(2)}, ${sorted[0].state})`);
  } else {
    audit('FINAL', 'NO DOMINANT AGENT. Station is quiet.');
  }

  return {
    agents: sorted,
    dominant,
    confidence,
    tiersUsed: tiers,
    auditLog,
    scannedAt: NOW,
  };
}

// ---- PUSH TO BROWSERS via WebSocket ----
// Forwards evidence to frontend for inspectability

export function formatForBrowser(discoveryResult) {
  return {
    type: 'DISCOVERY_RESULT',
    agents: discoveryResult.agents.map(a => ({
      id: a.id,
      name: a.name,
      type: a.type,
      personality: a.personality,
      presenceScore: a.presenceScore,
      lastActiveAt: a.lastActiveAt,
      state: a.state,
      evidenceCount: a.evidenceCount,
      // Evidence is forwarded — frontend can display source traces
      evidence: a.evidence?.map(e => ({
        type: e.type,
        path: e.path,
        confidence: e.confidence,
        lastModified: e.lastModified,
        scoreContribution: e.scoreContribution,
        detail: e.detail,
      })) || [],
    })),
    dominant: discoveryResult.dominant,
    confidence: discoveryResult.confidence,
    tiersUsed: discoveryResult.tiersUsed,
    scannedAt: discoveryResult.scannedAt,
  };
}

// ---- CLI test mode ----
if (process.argv[1] === new URL(import.meta.url).pathname) {
  console.log('\n=== vAIb Real Discovery Audit ===\n');
  const result = await runDiscovery();

  console.log('\n--- FULL AUDIT LOG ---\n');
  for (const entry of result.auditLog) {
    console.log(`[${entry.timestamp}] [${entry.category}] ${entry.message}`);
  }

  console.log('\n--- DISCOVERED AGENTS ---\n');
  for (const agent of result.agents) {
    console.log(`${agent.name} (${agent.id}):`);
    console.log(`  presence: ${(agent.presenceScore * 100).toFixed(0)}%`);
    console.log(`  state: ${agent.state}`);
    console.log(`  evidence: ${agent.evidenceCount} items`);
    console.log(`  why present:`);
    for (const e of (agent.evidence || []).slice(0, 6)) {
      const age = e.lastModified ? `${Math.round((NOW - e.lastModified) / DAY)}d ago` : '';
      console.log(`    • ${e.type}: ${e.path} (+${e.scoreContribution.toFixed(2)}) ${e.detail || ''} ${age}`);
    }
    if (agent.evidenceCount > 6) {
      console.log(`    ... and ${agent.evidenceCount - 6} more`);
    }
    console.log();
  }

  console.log(`DOMINANT: ${result.dominant || 'NONE'}`);
  console.log(`CONFIDENCE: ${result.confidence}`);
  console.log(`AGENTS FOUND: ${result.agents.length}`);
  console.log(`TIERS: T1=${result.tiersUsed.t1} T2=${result.tiersUsed.t2} T3=${result.tiersUsed.t3}`);

  if (result.agents.length === 0) {
    console.log('\n--- SCANNED ROOTS ---');
    console.log(`Canonical (T1): ${HOME}/.{agent}, ${HOME}/.config/{agent}`);
    console.log(`Expanded (T2): /home/*, workspace/, agents/, projects/, repos/, solar-ops/, MasterDrive/`);
    console.log('\nNo agents found. If agents exist elsewhere, run with:');
    console.log('  node server/discovery.mjs --deep');
  }

  process.exit(0);
}
