/**
 * Session state persistence.
 * Stores session data as JSON at ~/.disclaude/sessions.json
 * with atomic writes (write .tmp, then rename).
 */

import { existsSync, mkdirSync, renameSync, writeFileSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

/** Per-session persisted data */
export interface PersistedSessionData {
  id: string;
  directory: string;
  channelId?: string;
  createdAt: string; // ISO string
  /** SDK backend: Claude Code session ID for resumption */
  sdkSessionId?: string;
  /** Which backend created this session */
  backend: 'sdk' | 'tmux';
  /** Token usage tracked from SDK responses */
  tokenUsage?: { input: number; output: number };
}

/** Root shape of the persisted state file */
export interface PersistedState {
  sessions: Record<string, PersistedSessionData>;
  /** Maps channel ID -> session ID */
  channelMap: Record<string, string>;
}

const STATE_DIR = join(homedir(), '.disclaude');
const STATE_FILE = join(STATE_DIR, 'sessions.json');
const STATE_TMP = join(STATE_DIR, 'sessions.json.tmp');

function emptyState(): PersistedState {
  return { sessions: {}, channelMap: {} };
}

/** Load persisted state from disk. Returns empty state if file doesn't exist or is corrupt. */
export function loadState(): PersistedState {
  try {
    if (!existsSync(STATE_FILE)) return emptyState();
    const raw = readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as PersistedState;

    // Basic shape validation
    if (!parsed.sessions || typeof parsed.sessions !== 'object') return emptyState();
    if (!parsed.channelMap || typeof parsed.channelMap !== 'object') return emptyState();

    return parsed;
  } catch {
    return emptyState();
  }
}

/** Save state to disk atomically (write to .tmp, then rename). */
export function saveState(state: PersistedState): void {
  // Ensure directory exists
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const json = JSON.stringify(state, null, 2);
  writeFileSync(STATE_TMP, json, 'utf-8');
  renameSync(STATE_TMP, STATE_FILE);
}
