/**
 * Session manager with two backends:
 *  - "sdk"  (default) — uses Claude Code CLI subprocess with --print/--output-format stream-json
 *  - "tmux" (legacy)  — original tmux screen-scraping approach
 *
 * Set DISCLAUDE_BACKEND=tmux to use the legacy backend.
 *
 * Both backends implement SessionBackend and share the same public API
 * exposed by the SessionManager class.
 */

import { execSync, spawnSync, spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import {
  loadState,
  saveState,
  type PersistedState,
  type PersistedSessionData,
} from './persistence.js';

// ---------------------------------------------------------------------------
// Allowed-paths security (shared by both backends)
// ---------------------------------------------------------------------------

let allowedPaths: string[] = [];

export function setAllowedPaths(paths: string[]): void {
  allowedPaths = paths.map((p) =>
    resolve(p.startsWith('~') ? p.replace('~', homedir()) : p),
  );
}

function isPathAllowed(targetPath: string): boolean {
  if (allowedPaths.length === 0) return true;
  const resolved = resolve(targetPath);
  return allowedPaths.some(
    (allowed) => resolved.startsWith(allowed + '/') || resolved === allowed,
  );
}

function resolveDirectory(directory: string): string {
  const expanded = directory.startsWith('~')
    ? directory.replace('~', homedir())
    : directory;
  return resolve(expanded);
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

const SESSION_PREFIX = 'claude-';

export interface Session {
  id: string;
  tmuxName: string;
  directory: string;
  channelId: string;
  createdAt: Date;
}

export interface SessionInfo {
  id: string;
  tmuxName: string;
  directory: string;
  channelId?: string;
  attachCommand: string;
  createdAt: Date | null;
  /** SDK-only fields */
  sdkSessionId?: string;
  tokenUsage?: { input: number; output: number };
  contextUsed?: number;
  backend: 'sdk' | 'tmux';
}

// ---------------------------------------------------------------------------
// Backend interface
// ---------------------------------------------------------------------------

interface SessionBackend {
  name: 'sdk' | 'tmux';

  createSession(
    sessionId: string,
    directory: string,
    channelId: string,
  ): Promise<SessionInfo>;

  destroySession(sessionId: string): Promise<boolean>;
  sendToSession(sessionId: string, text: string): Promise<boolean>;
  captureOutput(sessionId: string, lines?: number): string;
  sessionExists(sessionId: string): boolean;
  getSession(sessionId: string): SessionInfo | null;
  listSessions(): SessionInfo[];
  sendEscape(sessionId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// SDK Backend — uses `claude` CLI subprocess
// ---------------------------------------------------------------------------

/** Data tracked per live SDK session */
interface SdkSessionState {
  id: string;
  directory: string;
  channelId?: string;
  createdAt: Date;
  sdkSessionId: string;
  tokenUsage: { input: number; output: number };
  contextUsed: number;
  /** Accumulated output text for captureOutput */
  outputBuffer: string;
  /** The currently-running subprocess, or null when idle */
  proc: ChildProcess | null;
  /** Whether the session has been fully created (first prompt optional) */
  alive: boolean;
}

class SdkBackend implements SessionBackend {
  readonly name = 'sdk' as const;

  private sessions = new Map<string, SdkSessionState>();
  readonly events: EventEmitter;

  constructor(events: EventEmitter) {
    this.events = events;
  }

  async createSession(
    sessionId: string,
    directory: string,
    channelId: string,
  ): Promise<SessionInfo> {
    const resolvedDir = resolveDirectory(directory);
    if (!isPathAllowed(resolvedDir)) {
      throw new Error(`Directory not in allowed paths: ${resolvedDir}`);
    }
    if (!existsSync(resolvedDir)) {
      throw new Error(`Directory does not exist: ${resolvedDir}`);
    }
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session "${sessionId}" already exists`);
    }

    const sdkSessionId = randomUUID();

    const state: SdkSessionState = {
      id: sessionId,
      directory: resolvedDir,
      channelId,
      createdAt: new Date(),
      sdkSessionId,
      tokenUsage: { input: 0, output: 0 },
      contextUsed: 0,
      outputBuffer: '',
      proc: null,
      alive: true,
    };
    this.sessions.set(sessionId, state);

    return this.toSessionInfo(state);
  }

  async destroySession(sessionId: string): Promise<boolean> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Session "${sessionId}" does not exist`);

    // Kill any running subprocess
    if (state.proc && !state.proc.killed) {
      state.proc.kill('SIGTERM');
    }
    state.alive = false;
    this.sessions.delete(sessionId);
    return true;
  }

  async sendToSession(sessionId: string, text: string): Promise<boolean> {
    const state = this.sessions.get(sessionId);
    if (!state?.alive) throw new Error(`Session "${sessionId}" does not exist`);

    // If a previous query is still running, that's unusual but we allow it
    // (the previous proc will finish on its own).
    // Start a new `claude` subprocess in --print mode with session resumption.
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--session-id', state.sdkSessionId,
      '--dangerously-skip-permissions',
      '--verbose',
      text,
    ];

    const proc = spawn('claude', args, {
      cwd: state.directory,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    state.proc = proc;

    let stderrChunks = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      const raw = chunk.toString('utf-8');
      // stream-json format: one JSON object per line
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          this.handleStreamMessage(state, msg);
        } catch {
          // Not valid JSON — append raw text as fallback
          state.outputBuffer += line + '\n';
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrChunks += chunk.toString('utf-8');
    });

    proc.on('close', (code) => {
      state.proc = null;
      if (code !== 0 && stderrChunks) {
        this.events.emit('error', sessionId, stderrChunks.trim());
      }
      this.events.emit('idle', sessionId);
    });

    proc.on('error', (err) => {
      state.proc = null;
      this.events.emit('error', sessionId, err.message);
    });

    return true;
  }

  /**
   * Handle a single stream-json message from the Claude CLI subprocess.
   * The stream-json format emits objects with a `type` field.
   */
  private handleStreamMessage(
    state: SdkSessionState,
    msg: Record<string, unknown>,
  ): void {
    const type = msg.type as string | undefined;

    switch (type) {
      case 'assistant': {
        // Assistant text message
        const content = msg.message as { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> } | undefined;
        if (content?.content) {
          for (const block of content.content) {
            if (block.type === 'text' && block.text) {
              state.outputBuffer += block.text;
              this.events.emit('response', state.id, block.text);
            }
            if (block.type === 'tool_use') {
              this.events.emit('tool_use', state.id, {
                name: block.name,
                input: block.input,
              });
            }
          }
        }
        break;
      }

      case 'result': {
        // Final result with usage stats
        const usage = msg.usage as {
          input_tokens?: number;
          output_tokens?: number;
        } | undefined;
        if (usage) {
          state.tokenUsage.input += usage.input_tokens ?? 0;
          state.tokenUsage.output += usage.output_tokens ?? 0;
        }
        // Result text
        const result = msg.result as string | undefined;
        if (result) {
          state.outputBuffer += result + '\n';
          this.events.emit('response', state.id, result);
        }
        break;
      }

      default:
        // Ignore other message types (system, etc.)
        break;
    }
  }

  captureOutput(sessionId: string, lines = 100): string {
    const state = this.sessions.get(sessionId);
    if (!state?.alive) throw new Error(`Session "${sessionId}" does not exist`);

    // Return the last N lines from the output buffer
    const allLines = state.outputBuffer.split('\n');
    return allLines.slice(-lines).join('\n');
  }

  sessionExists(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    return !!state?.alive;
  }

  getSession(sessionId: string): SessionInfo | null {
    const state = this.sessions.get(sessionId);
    if (!state?.alive) return null;
    return this.toSessionInfo(state);
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.alive)
      .map((s) => this.toSessionInfo(s));
  }

  async sendEscape(sessionId: string): Promise<boolean> {
    const state = this.sessions.get(sessionId);
    if (!state?.alive) throw new Error(`Session "${sessionId}" does not exist`);

    // Kill the running subprocess to interrupt Claude
    if (state.proc && !state.proc.killed) {
      state.proc.kill('SIGTERM');
      state.proc = null;
    }
    return true;
  }

  /** Restore a session from persisted data (no subprocess — it's re-created on next send) */
  restoreSession(data: PersistedSessionData): void {
    if (this.sessions.has(data.id)) return;

    this.sessions.set(data.id, {
      id: data.id,
      directory: data.directory,
      channelId: data.channelId,
      createdAt: new Date(data.createdAt),
      sdkSessionId: data.sdkSessionId ?? randomUUID(),
      tokenUsage: data.tokenUsage ?? { input: 0, output: 0 },
      contextUsed: 0,
      outputBuffer: '',
      proc: null,
      alive: true,
    });
  }

  /** Get internal state for persistence */
  getSessionData(sessionId: string): SdkSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  private toSessionInfo(state: SdkSessionState): SessionInfo {
    return {
      id: state.id,
      tmuxName: `${SESSION_PREFIX}${state.id}`,
      directory: state.directory,
      channelId: state.channelId,
      attachCommand: `claude --resume ${state.sdkSessionId}`,
      createdAt: state.createdAt,
      sdkSessionId: state.sdkSessionId,
      tokenUsage: { ...state.tokenUsage },
      contextUsed: state.contextUsed,
      backend: 'sdk',
    };
  }
}

// ---------------------------------------------------------------------------
// Tmux Backend — original screen-scraping approach (kept as-is)
// ---------------------------------------------------------------------------

class TmuxBackend implements SessionBackend {
  readonly name = 'tmux' as const;
  private lastOutput = new Map<string, string>();

  checkTmux(): boolean {
    try {
      execSync('which tmux', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  private getTmuxName(sessionId: string): string {
    return `${SESSION_PREFIX}${sessionId}`;
  }

  async createSession(
    sessionId: string,
    directory: string,
    channelId: string,
  ): Promise<SessionInfo> {
    const resolvedDir = resolveDirectory(directory);
    if (!isPathAllowed(resolvedDir)) {
      throw new Error(`Directory not in allowed paths: ${resolvedDir}`);
    }
    if (!existsSync(resolvedDir)) {
      throw new Error(`Directory does not exist: ${resolvedDir}`);
    }
    if (this.sessionExists(sessionId)) {
      throw new Error(`Session "${sessionId}" already exists`);
    }

    const tmuxName = this.getTmuxName(sessionId);

    const result = spawnSync(
      'tmux',
      ['new-session', '-d', '-s', tmuxName, '-c', resolvedDir, 'claude'],
      { stdio: 'pipe' },
    );

    if (result.status !== 0) {
      throw new Error(
        result.stderr?.toString() || 'tmux command failed',
      );
    }

    return {
      id: sessionId,
      directory: resolvedDir,
      tmuxName,
      channelId,
      attachCommand: `tmux attach -t ${tmuxName}`,
      createdAt: new Date(),
      backend: 'tmux',
    };
  }

  async destroySession(sessionId: string): Promise<boolean> {
    const tmuxName = this.getTmuxName(sessionId);
    if (!this.sessionExists(sessionId)) {
      throw new Error(`Session "${sessionId}" does not exist`);
    }
    execSync(`tmux kill-session -t "${tmuxName}"`, { stdio: 'pipe' });
    this.lastOutput.delete(sessionId);
    return true;
  }

  async sendToSession(sessionId: string, text: string): Promise<boolean> {
    const tmuxName = this.getTmuxName(sessionId);
    if (!this.sessionExists(sessionId)) {
      throw new Error(`Session "${sessionId}" does not exist`);
    }
    const escapedText = text.replace(/'/g, "'\\''");
    execSync(`tmux send-keys -t "${tmuxName}" -l '${escapedText}'`, {
      stdio: 'pipe',
    });
    execSync(`tmux send-keys -t "${tmuxName}" Enter`, { stdio: 'pipe' });
    return true;
  }

  captureOutput(sessionId: string, lines = 100): string {
    const tmuxName = this.getTmuxName(sessionId);
    if (!this.sessionExists(sessionId)) {
      throw new Error(`Session "${sessionId}" does not exist`);
    }
    return execSync(
      `tmux capture-pane -t "${tmuxName}" -p -e -S -${lines} -E ''`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  }

  sessionExists(sessionId: string): boolean {
    const tmuxName = this.getTmuxName(sessionId);
    try {
      execSync(`tmux has-session -t "${tmuxName}" 2>/dev/null`, {
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  }

  getSession(sessionId: string): SessionInfo | null {
    const tmuxName = this.getTmuxName(sessionId);
    if (!this.sessionExists(sessionId)) return null;

    try {
      const output = execSync(
        `tmux list-sessions -F "#{session_name}|#{session_created}|#{pane_current_path}" -f "#{==:#{session_name},${tmuxName}}" 2>/dev/null`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const line = output.trim();
      if (!line) return null;

      const [name, created, path] = line.split('|');
      return {
        id: sessionId,
        tmuxName: name,
        directory: path || 'unknown',
        channelId: undefined, // filled in by SessionManager
        createdAt: created ? new Date(parseInt(created) * 1000) : null,
        attachCommand: `tmux attach -t ${name}`,
        backend: 'tmux',
      };
    } catch {
      return null;
    }
  }

  listSessions(): SessionInfo[] {
    try {
      const output = execSync(
        'tmux list-sessions -F "#{session_name}|#{session_created}|#{pane_current_path}" 2>/dev/null',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      return output
        .trim()
        .split('\n')
        .filter((line) => line.startsWith(SESSION_PREFIX))
        .map((line) => {
          const [name, created, path] = line.split('|');
          const id = name.replace(SESSION_PREFIX, '');
          return {
            id,
            tmuxName: name,
            directory: path || 'unknown',
            createdAt: created ? new Date(parseInt(created) * 1000) : null,
            attachCommand: `tmux attach -t ${name}`,
            backend: 'tmux' as const,
          };
        });
    } catch {
      return [];
    }
  }

  async sendEscape(sessionId: string): Promise<boolean> {
    const tmuxName = this.getTmuxName(sessionId);
    if (!this.sessionExists(sessionId)) {
      throw new Error(`Session "${sessionId}" does not exist`);
    }
    execSync(`tmux send-keys -t "${tmuxName}" Escape`, { stdio: 'pipe' });
    return true;
  }
}

// ---------------------------------------------------------------------------
// Session Manager — public API (delegates to whichever backend is active)
// ---------------------------------------------------------------------------

class SessionManager extends EventEmitter {
  private channelMap = new Map<string, string>(); // session ID -> channel ID
  private reverseMap = new Map<string, string>(); // channel ID -> session ID
  private lastOutput = new Map<string, string>(); // for getNewOutput diff
  private backend: SessionBackend;
  private sdkBackend: SdkBackend | null = null;
  private tmuxBackend: TmuxBackend | null = null;

  constructor() {
    super();

    const backendName = (process.env.DISCLAUDE_BACKEND || 'sdk').toLowerCase();

    if (backendName === 'tmux') {
      const tmux = new TmuxBackend();
      this.tmuxBackend = tmux;
      this.backend = tmux;
      console.log('[SessionManager] Using tmux backend');
    } else {
      const sdk = new SdkBackend(this);
      this.sdkBackend = sdk;
      this.backend = sdk;
      console.log('[SessionManager] Using SDK backend');
    }

    // Load persisted state
    this.restoreFromDisk();
  }

  // ---- Persistence helpers ------------------------------------------------

  private restoreFromDisk(): void {
    const state = loadState();

    // Restore channel mappings
    for (const [channelId, sessionId] of Object.entries(state.channelMap)) {
      this.channelMap.set(sessionId, channelId);
      this.reverseMap.set(channelId, sessionId);
    }

    // Restore SDK sessions (tmux sessions are detected live from tmux)
    if (this.sdkBackend) {
      for (const data of Object.values(state.sessions)) {
        if (data.backend === 'sdk') {
          this.sdkBackend.restoreSession(data);
        }
      }
    }

    const count = Object.keys(state.sessions).length;
    if (count > 0) {
      console.log(`[SessionManager] Restored ${count} session(s) from disk`);
    }
  }

  private persistToDisk(): void {
    const state: PersistedState = { sessions: {}, channelMap: {} };

    // Persist channel map (channel -> session)
    for (const [channelId, sessionId] of this.reverseMap.entries()) {
      state.channelMap[channelId] = sessionId;
    }

    // Persist session data
    if (this.sdkBackend) {
      for (const info of this.sdkBackend.listSessions()) {
        const sdkData = this.sdkBackend.getSessionData(info.id);
        state.sessions[info.id] = {
          id: info.id,
          directory: info.directory,
          channelId: info.channelId,
          createdAt: info.createdAt?.toISOString() ?? new Date().toISOString(),
          sdkSessionId: info.sdkSessionId,
          backend: 'sdk',
          tokenUsage: sdkData
            ? { ...sdkData.tokenUsage }
            : undefined,
        };
      }
    }

    // For tmux sessions, persist what we know (directory, channel mapping)
    if (this.tmuxBackend) {
      for (const info of this.tmuxBackend.listSessions()) {
        state.sessions[info.id] = {
          id: info.id,
          directory: info.directory,
          channelId: this.channelMap.get(info.id),
          createdAt: info.createdAt?.toISOString() ?? new Date().toISOString(),
          backend: 'tmux',
        };
      }
    }

    saveState(state);
  }

  // ---- Public API (same interface as before) --------------------------------

  /** Check if tmux is installed (relevant for tmux backend) */
  checkTmux(): boolean {
    if (this.tmuxBackend) return this.tmuxBackend.checkTmux();
    // For SDK backend, tmux is not required — always return true
    return true;
  }

  /** Get the tmux-style session name (kept for compatibility) */
  getTmuxName(sessionId: string): string {
    return `${SESSION_PREFIX}${sessionId}`;
  }

  /** Create a new session */
  async createSession(
    sessionId: string,
    directory: string,
    channelId: string,
  ): Promise<SessionInfo> {
    const info = await this.backend.createSession(sessionId, directory, channelId);

    this.channelMap.set(sessionId, channelId);
    this.reverseMap.set(channelId, sessionId);
    info.channelId = channelId;

    this.persistToDisk();
    return info;
  }

  /** Check if a session exists */
  sessionExists(sessionId: string): boolean {
    return this.backend.sessionExists(sessionId);
  }

  /** Link a session to a Discord channel */
  linkChannel(sessionId: string, channelId: string): void {
    this.channelMap.set(sessionId, channelId);
    this.reverseMap.set(channelId, sessionId);
    this.persistToDisk();
  }

  /** Get session ID from channel ID */
  getSessionByChannel(channelId: string): string | undefined {
    return this.reverseMap.get(channelId);
  }

  /** Get channel ID from session ID */
  getChannelBySession(sessionId: string): string | undefined {
    return this.channelMap.get(sessionId);
  }

  /** List all active sessions */
  listSessions(): SessionInfo[] {
    const sessions = this.backend.listSessions();
    // Attach channel IDs from our map
    for (const s of sessions) {
      s.channelId = this.channelMap.get(s.id) ?? s.channelId;
    }
    return sessions;
  }

  /** Send text to a session */
  async sendToSession(sessionId: string, text: string): Promise<boolean> {
    return this.backend.sendToSession(sessionId, text);
  }

  /** Capture current output from a session */
  captureOutput(sessionId: string, lines = 100): string {
    return this.backend.captureOutput(sessionId, lines);
  }

  /** Get new output since last check (for polling/streaming) */
  getNewOutput(sessionId: string, lines = 200): string | null {
    const output = this.captureOutput(sessionId, lines);
    const last = this.lastOutput.get(sessionId) || '';

    this.lastOutput.set(sessionId, output);

    if (!last || output === last) return null;

    if (output.length > last.length && output.endsWith(last.slice(-500))) {
      return output.slice(0, output.length - last.length);
    }

    const lastLines = last.trim().split('\n');
    const newLines = output.trim().split('\n');

    let diffStart = 0;
    for (let i = 0; i < newLines.length; i++) {
      if (lastLines.includes(newLines[i])) {
        diffStart = i + 1;
      } else {
        break;
      }
    }

    const newContent = newLines.slice(diffStart).join('\n').trim();
    return newContent || null;
  }

  /** Send escape / interrupt to stop Claude */
  async sendEscape(sessionId: string): Promise<boolean> {
    return this.backend.sendEscape(sessionId);
  }

  /**
   * Kill / destroy a session.
   * Named killSession for backwards compatibility with index.ts.
   */
  async killSession(sessionId: string): Promise<boolean> {
    const result = await this.backend.destroySession(sessionId);

    // Clean up mappings
    const channelId = this.channelMap.get(sessionId);
    if (channelId) this.reverseMap.delete(channelId);
    this.channelMap.delete(sessionId);
    this.lastOutput.delete(sessionId);

    this.persistToDisk();
    return result;
  }

  /** Get info for a single session */
  getSession(sessionId: string): SessionInfo | null {
    const info = this.backend.getSession(sessionId);
    if (info) {
      info.channelId = this.channelMap.get(sessionId) ?? info.channelId;
    }
    return info;
  }

  /** Unlink a channel (e.g. when a Discord channel is deleted) */
  unlinkChannel(channelId: string): void {
    const sessionId = this.reverseMap.get(channelId);
    if (sessionId) {
      this.channelMap.delete(sessionId);
      this.reverseMap.delete(channelId);
      this.persistToDisk();
    }
  }
}

export const sessionManager = new SessionManager();
export default sessionManager;
