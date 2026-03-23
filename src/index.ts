import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ChannelType,
  TextChannel,
  CategoryChannel,
  Message,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Guild,
  ActivityType,
  MessageFlags,
} from 'discord.js';
import sessionManager, { setAllowedPaths } from './sessionManager.js';
import config from './config.js';
import {
  formatUptime,
  formatLastActivity,
  detectFileEdits,
  detectPrompt,
  cleanForCompare,
  cleanForDisplay,
  convertAnsiForDiscord,
  stripPromptFooter,
  type PromptOption,
} from './utils.js';
import { processAttachments, cleanupTempAttachments } from './attachments.js';

// Initialize allowed paths from config
setAllowedPaths(config.allowedPaths);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Bot logs channel
let logChannel: TextChannel | null = null;
const logBuffer: string[] = [];
let logFlushTimer: NodeJS.Timeout | null = null;

// Log to both console and Discord
function botLog(level: 'info' | 'warn' | 'error', message: string): void {
  const timestamp = new Date().toLocaleTimeString();
  const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
  const formatted = `\`${timestamp}\` ${prefix} ${message}`;

  // Console output
  if (level === 'error') console.error(message);
  else if (level === 'warn') console.warn(message);
  else console.log(message);

  // Buffer for Discord (batch to avoid rate limits)
  logBuffer.push(formatted);

  // Flush after 2 seconds of inactivity
  if (logFlushTimer) clearTimeout(logFlushTimer);
  logFlushTimer = setTimeout(flushLogs, 2000);
}

async function flushLogs(): Promise<void> {
  if (!logChannel || logBuffer.length === 0) return;

  const messages = logBuffer.splice(0, logBuffer.length);
  const content = messages.join('\n').slice(0, 1900); // Discord limit

  try {
    await logChannel.send(content);
  } catch {
    // Ignore errors sending to log channel
  }
}

// Update bot presence/status
function updateBotStatus(): void {
  const sessionCount = sessionManager.listSessions().length;
  const statusText = sessionCount === 1 ? '1 session' : `${sessionCount} sessions`;

  client.user?.setPresence({
    activities: [{
      name: statusText,
      type: ActivityType.Watching,
    }],
    status: sessionCount > 0 ? 'online' : 'idle',
  });
}

// Check if a user is allowed to use the bot
function isUserAllowed(userId: string): boolean {
  // If no whitelist configured, allow all (backwards compatible but warns at startup)
  if (config.allowedUsers.length === 0) return true;
  return config.allowedUsers.includes(userId);
}

// Output polling state per session
interface OutputState {
  poller: NodeJS.Timeout;
  responseMessage: Message | null;  // Current response being edited
  lastContent: string;
  lastUserMessage: string;          // The user's message to find in output
  awaitingResponse: boolean;        // True after user sends message, until we respond
  accumulatedResponse: string;      // Full accumulated response for this turn
  lastRawCapture: string;           // Last raw capture to detect new content
  lastUpdateTime: number;           // Timestamp of last content change
  lastContentChangeTime: number;    // Timestamp of last actual content change (for health monitoring)
  buttonsRemoved: boolean;          // Whether we've removed the stop button
  currentMessageStart: number;      // Index in accumulatedResponse where current message starts
  stuckWarned: boolean;             // Whether we've warned about stuck state this episode
  channel: TextChannel;             // Channel reference for health monitoring
}
const outputStates = new Map<string, OutputState>();

const IDLE_TIMEOUT = 5000; // Remove stop button after 5 seconds of no updates

// Session statistics tracking
interface SessionStats {
  messageCount: number;
  lastActivity: Date;
  startTime: Date;
  filesEdited: string[];
}
const sessionStats = new Map<string, SessionStats>();

// Rate limiting: track last message time per user
const userLastMessage = new Map<string, number>();

function getOrCreateStats(sessionId: string): SessionStats {
  let stats = sessionStats.get(sessionId);
  if (!stats) {
    stats = {
      messageCount: 0,
      lastActivity: new Date(),
      startTime: new Date(),
      filesEdited: [],
    };
    sessionStats.set(sessionId, stats);
  }
  return stats;
}


// Mark that user sent a message - next output should be a new message
function markUserInput(sessionId: string, userMessage: string): void {
  const state = outputStates.get(sessionId);
  if (state) {
    state.awaitingResponse = true;
    state.lastUserMessage = userMessage;
    state.responseMessage = null;  // Force new message for response
    state.accumulatedResponse = '';  // Reset accumulated response for new turn
    state.lastUpdateTime = Date.now();
    state.lastContentChangeTime = Date.now();  // Reset health monitoring clock
    state.buttonsRemoved = false;  // Reset for new turn
    state.currentMessageStart = 0;  // Reset for new turn
    state.stuckWarned = false;  // Reset stuck warning for new turn
  }

  // Update session stats
  const stats = getOrCreateStats(sessionId);
  stats.messageCount++;
  stats.lastActivity = new Date();
}

// Define slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('claude')
    .setDescription('Manage Claude Code sessions')
    .addSubcommand((sub) =>
      sub
        .setName('new')
        .setDescription('Create a new Claude Code session with a dedicated channel')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Session name (becomes channel name)').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('directory').setDescription('Working directory').setRequired(false)
        )
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('List all active sessions'))
    .addSubcommand((sub) => sub.setName('sync').setDescription('Sync orphaned tmux sessions to Discord channels'))
    .addSubcommand((sub) =>
      sub.setName('end').setDescription('End the session for this channel')
    )
    .addSubcommand((sub) =>
      sub
        .setName('output')
        .setDescription('Get recent output (use in session channel)')
        .addIntegerOption((opt) =>
          opt.setName('lines').setDescription('Number of lines (default: 100)').setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub.setName('attach').setDescription('Get tmux attach command for this session')
    )
    .addSubcommand((sub) =>
      sub.setName('stop').setDescription('Stop Claude (send ESC key)')
    )
    .addSubcommand((sub) =>
      sub.setName('health').setDescription('Show health status of all sessions')
    ),
].map((cmd) => cmd.toJSON());

// Register slash commands
async function registerCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.token);

  try {
    botLog('info', 'Registering slash commands...');

    if (config.guildId) {
      await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
        body: commands,
      });
      botLog('info', `Commands registered for guild ${config.guildId}`);
    } else {
      await rest.put(Routes.applicationCommands(config.clientId), {
        body: commands,
      });
      botLog('info', 'Commands registered globally');
    }
  } catch (error) {
    botLog('error', `Failed to register commands: ${(error as Error).message}`);
  }
}

// Find or create the Claude Sessions category
async function getOrCreateCategory(guild: Guild): Promise<CategoryChannel> {
  let category = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === config.categoryName
  ) as CategoryChannel | undefined;

  if (!category) {
    category = await guild.channels.create({
      name: config.categoryName,
      type: ChannelType.GuildCategory,
    });
  }

  return category;
}

// Sync orphaned sessions to channels
async function syncSessions(guild: Guild): Promise<{ linked: string[]; created: string[] }> {
  const sessions = sessionManager.listSessions();
  const linked: string[] = [];
  const created: string[] = [];

  for (const session of sessions) {
    // Skip if already linked
    if (session.channelId) {
      // Verify channel still exists
      try {
        const channel = await guild.channels.fetch(session.channelId);
        if (channel) {
          // Re-link and start poller
          sessionManager.linkChannel(session.id, session.channelId);
          if (!outputStates.has(session.id)) {
            startOutputPoller(session.id, channel as TextChannel);
          }
          continue;
        }
      } catch {
        // Channel doesn't exist, need to re-link
      }
    }

    // Look for matching channel by name
    const expectedChannelName = `claude-${session.id}`;
    const existingChannel = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && c.name === expectedChannelName
    ) as TextChannel | undefined;

    if (existingChannel) {
      // Link to existing channel
      sessionManager.linkChannel(session.id, existingChannel.id);
      startOutputPoller(session.id, existingChannel);
      linked.push(session.id);

      // Send reconnection message
      await existingChannel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('Session Reconnected')
            .setColor(0x22c55e)
            .setDescription('Bot restarted - session has been reconnected to this channel.')
            .setTimestamp(),
        ],
      });
    } else {
      // Create new channel for orphaned session
      const category = await getOrCreateCategory(guild);
      const newChannel = await guild.channels.create({
        name: expectedChannelName,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: `Claude Code session | Directory: ${session.directory} | Attach: ${session.attachCommand}`,
      });

      sessionManager.linkChannel(session.id, newChannel.id);
      startOutputPoller(session.id, newChannel);
      created.push(session.id);

      // Send welcome message
      await newChannel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('Orphaned Session Adopted')
            .setColor(0x7c3aed)
            .addFields(
              { name: 'Directory', value: `\`${session.directory}\``, inline: false },
              { name: 'Attach via Terminal', value: `\`${session.attachCommand}\``, inline: false }
            )
            .setDescription('Found an existing tmux session and created this channel for it.\nJust type to talk to Claude.')
            .setTimestamp(),
        ],
      });
    }
  }

  return { linked, created };
}





// Compute the next polling interval based on output activity
function computePollingInterval(state: OutputState): number {
  const timeSinceChange = Date.now() - state.lastContentChangeTime;

  // Awaiting response but stale (10s no change) -> faster polling to catch updates
  if (state.awaitingResponse && timeSinceChange > config.pollingAwaitingStaleAfterMs) {
    return config.pollingAwaitingStaleMs;
  }

  // Very idle (no change 30s)
  if (timeSinceChange > config.pollingVeryIdleAfterMs) {
    return config.pollingVeryIdleMs;
  }

  // Idle (no change 5s)
  if (timeSinceChange > config.pollingIdleAfterMs) {
    return config.pollingIdleMs;
  }

  // Active output changing
  return config.pollingActiveMs;
}

function startOutputPoller(sessionId: string, channel: TextChannel): void {
  stopOutputPoller(sessionId);

  const now = Date.now();
  const state: OutputState = {
    poller: null as unknown as NodeJS.Timeout,
    responseMessage: null,
    lastContent: '',
    lastUserMessage: '',
    awaitingResponse: false,
    accumulatedResponse: '',
    lastRawCapture: '',
    lastUpdateTime: now,
    lastContentChangeTime: now,
    buttonsRemoved: true,  // Start with no buttons (no active turn)
    currentMessageStart: 0,
    stuckWarned: false,
    channel,
  };

  const processOutput = async () => {
    try {
      if (!sessionManager.sessionExists(sessionId)) {
        stopOutputPoller(sessionId);
        await channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xef4444)
              .setDescription('Session has ended.')
              .setTimestamp(),
          ],
        });
        return;
      }

      // Capture more lines to get full context
      const rawOutput = sessionManager.captureOutput(sessionId, 200);
      const outputForCompare = cleanForCompare(rawOutput);
      const outputForDisplay = cleanForDisplay(rawOutput);

      // Check if content changed
      const contentChanged = outputForCompare !== state.lastContent;

      if (contentChanged) {
        state.lastContent = outputForCompare;
        state.lastUpdateTime = Date.now();
        state.lastContentChangeTime = Date.now();
        state.buttonsRemoved = false;
        state.stuckWarned = false;  // Reset stuck warning on content change
      }

      // Health monitoring: warn if stuck (awaiting response with no content change)
      const timeSinceContentChange = Date.now() - state.lastContentChangeTime;
      if (state.awaitingResponse && !state.stuckWarned && timeSinceContentChange > config.healthStuckThresholdMs) {
        state.stuckWarned = true;
        try {
          await channel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0xf59e0b)
                .setTitle('Session may be stuck')
                .setDescription(
                  `No output change for ${Math.round(timeSinceContentChange / 1000)}s while awaiting a response.\n` +
                  'Claude may be thinking deeply, or the session may need attention.\n' +
                  'Use `/claude stop` or `/claude attach` to investigate.'
                )
                .setTimestamp(),
            ],
          });
          botLog('warn', `Session **${sessionId}** appears stuck (${Math.round(timeSinceContentChange / 1000)}s no change)`);
        } catch {
          // Ignore errors sending warning
        }
      }

      // Check for idle timeout - remove ONLY the stop button, keep prompt options
      const timeSinceUpdate = Date.now() - state.lastUpdateTime;
      if (!state.buttonsRemoved && timeSinceUpdate > IDLE_TIMEOUT && state.responseMessage) {
        try {
          // Get current components and filter out Stop button, keep prompt options
          const currentComponents = state.responseMessage.components;
          const filteredComponents: ActionRowBuilder<ButtonBuilder>[] = [];

          for (const row of currentComponents) {
            // Type guard: only ActionRows have components
            if (!('components' in row)) continue;

            const filteredRow = new ActionRowBuilder<ButtonBuilder>();
            for (const component of row.components) {
              // Keep buttons that are NOT the stop button
              if ('customId' in component && component.customId && !component.customId.startsWith('stop_')) {
                filteredRow.addComponents(
                  ButtonBuilder.from(component as any)
                );
              }
            }
            // Only add row if it has buttons
            if (filteredRow.components.length > 0) {
              filteredComponents.push(filteredRow);
            }
          }

          await state.responseMessage.edit({ components: filteredComponents });
          state.buttonsRemoved = true;
        } catch {
          // Ignore errors removing buttons
        }
      }

      // Skip further processing if nothing changed
      if (!contentChanged) return;

      // Find content after the user's message
      // Claude Code echoes input as "> message"
      let currentContent = '';

      if (state.lastUserMessage) {
        // Use the clean (no ANSI) version for finding the marker
        const lines = outputForCompare.split('\n');
        const displayLines = outputForDisplay.split('\n');

        // Find the LAST occurrence of the user's prompt (in case of history)
        let markerLineIdx = -1;
        const isSlashCommand = state.lastUserMessage.startsWith('/');

        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();

          // Regular messages: look for "> message"
          if (line.startsWith('>') && line.includes(state.lastUserMessage.slice(0, 30))) {
            markerLineIdx = i;
            break;
          }

          // Slash commands: look for "/command is running" or the command echoed
          if (isSlashCommand) {
            const cmdName = state.lastUserMessage.split(' ')[0]; // e.g., "/triage"
            if (line.includes(cmdName) && (line.includes('running') || line.startsWith('>'))) {
              markerLineIdx = i;
              break;
            }
          }
        }

        // Fallback: if we can't find the marker but see Claude's response indicator, show from there
        if (markerLineIdx < 0) {
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.includes('⏺') || line.startsWith('│') || line.includes('Read(') || line.includes('Edit(') || line.includes('Bash(')) {
              markerLineIdx = Math.max(0, i - 1); // Start one line before
              break;
            }
          }
        }

        if (markerLineIdx >= 0) {
          // Skip past all prompt lines (user input may wrap across multiple lines)
          // Look for Claude's response start indicator (⏺) or first non-empty content line
          let responseStartIdx = markerLineIdx + 1;
          for (let i = markerLineIdx + 1; i < lines.length; i++) {
            const line = lines[i].trim();
            // Claude's response typically starts with ⏺ or after blank lines
            if (line.includes('⏺') || line.startsWith('│') || line.startsWith('⎯')) {
              responseStartIdx = i;
              break;
            }
            // Skip empty lines and lines that look like wrapped prompt text
            // (prompt text doesn't start with special chars)
            if (line && !line.match(/^[a-z0-9"'`\[\(]/i)) {
              responseStartIdx = i;
              break;
            }
          }
          currentContent = displayLines.slice(responseStartIdx).join('\n').trim();
        }
      }

      // Strip the prompt footer (input box, etc.)
      currentContent = stripPromptFooter(currentContent);

      // If we couldn't find the marker or content is trivial, don't show anything yet
      if (!currentContent || currentContent.length < 3) return;

      // Update accumulated response - use the full current content
      // This ensures we always show the complete response, not just new parts
      state.accumulatedResponse = currentContent;

      // Detect file edits and track them
      const editedFiles = detectFileEdits(outputForCompare);
      if (editedFiles.length > 0) {
        const stats = getOrCreateStats(sessionId);
        for (const file of editedFiles) {
          if (!stats.filesEdited.includes(file)) {
            stats.filesEdited.push(file);
            // Log file edit to bot-logs
            const fileName = file.split('/').pop() || file;
            botLog('info', `📝 **${sessionId}**: Edited \`${fileName}\``);
          }
        }
      }

      // Convert ANSI codes for Discord compatibility
      const fullDisplayContent = convertAnsiForDiscord(state.accumulatedResponse);

      // Check for prompts in current output (use version without ANSI)
      const promptOptions = detectPrompt(outputForCompare);

      // Discord message limit is 2000 chars. Code block wrapper adds ~12 chars.
      // We need to be conservative because ANSI codes add lots of hidden chars.
      const maxMessageLength = 1900;

      // Get just the content for this message (from currentMessageStart onwards)
      let displayContent = fullDisplayContent.slice(state.currentMessageStart);

      // Check actual message length (with wrapper)
      let messageContent = '```ansi\n' + displayContent + '\n```';

      // If message exceeds limit, we need to split
      while (messageContent.length > maxMessageLength) {
        // Find a safe split point - work backwards from a safe length
        // Account for wrapper overhead
        const safeLength = maxMessageLength - 20;
        let splitPoint = Math.min(displayContent.length, safeLength);

        // Find a newline to split at (avoid mid-line splits)
        const searchArea = displayContent.slice(0, splitPoint);
        const lastNewline = searchArea.lastIndexOf('\n');
        if (lastNewline > splitPoint - 300 && lastNewline > 100) {
          splitPoint = lastNewline;
        }

        const chunkContent = displayContent.slice(0, splitPoint);
        const chunkMessage = '```ansi\n' + chunkContent + '\n```';

        // Send or edit with this chunk
        if (state.responseMessage) {
          // Finalize current message with this chunk (no buttons)
          try {
            await state.responseMessage.edit({
              content: chunkMessage,
              components: [],
            });
          } catch (e) {
            // Ignore edit errors
          }
        } else {
          // Create new message with this chunk (no buttons - it's finalized)
          try {
            await channel.send({ content: chunkMessage });
          } catch (e) {
            console.error('Failed to send chunk:', e);
          }
        }

        // Move to next chunk
        state.currentMessageStart += splitPoint;
        state.responseMessage = null;
        displayContent = displayContent.slice(splitPoint).trim();

        // Clean up orphaned ANSI at start of new chunk
        if (displayContent.match(/^\[[0-9;]*m/)) {
          displayContent = displayContent.replace(/^\[[0-9;]*m/, '');
        }

        messageContent = '```ansi\n' + displayContent + '\n```';
      }

      // Build buttons - always include Stop button, plus prompt options if active
      const stopButton = new ButtonBuilder()
        .setCustomId(`stop_${sessionId}`)
        .setLabel('⏹ Stop')
        .setStyle(ButtonStyle.Danger);

      let components: ActionRowBuilder<ButtonBuilder>[] = [];
      if (promptOptions && promptOptions.length > 0) {
        const promptRow = new ActionRowBuilder<ButtonBuilder>();
        for (const opt of promptOptions.slice(0, 4)) {  // Max 4 to leave room for stop
          promptRow.addComponents(
            new ButtonBuilder()
              .setCustomId(`prompt_${sessionId}_${opt.number}`)
              .setLabel(`${opt.number}. ${opt.label}`.slice(0, 80))
              .setStyle(ButtonStyle.Primary)
          );
        }
        promptRow.addComponents(stopButton);
        components = [promptRow];
      } else {
        // Just the stop button
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(stopButton);
        components = [row];
      }

      try {
        // If we have a response message for this turn, edit it
        if (state.responseMessage) {
          await state.responseMessage.edit({ content: messageContent, components });
        } else {
          // Create new response message
          state.responseMessage = await channel.send({ content: messageContent, components });
          state.awaitingResponse = false;
        }
      } catch (err) {
        console.error('Failed to send/edit message:', err);
        try {
          state.responseMessage = await channel.send({ content: messageContent, components });
        } catch {
          // Ignore
        }
      }

    } catch (error) {
      console.error(`Poller error for ${sessionId}:`, error);
    }
  };

  // Adaptive polling: schedule next poll based on activity level
  const scheduleNext = () => {
    const interval = computePollingInterval(state);
    state.poller = setTimeout(async () => {
      await processOutput();
      // Only reschedule if this session is still tracked
      if (outputStates.has(sessionId)) {
        scheduleNext();
      }
    }, interval);
  };

  outputStates.set(sessionId, state);

  // Capture initial state
  try {
    const initial = sessionManager.captureOutput(sessionId, 80);
    state.lastContent = cleanForCompare(initial);
  } catch {
    // Ignore
  }

  // Start the adaptive polling loop
  scheduleNext();
}

function stopOutputPoller(sessionId: string): void {
  const state = outputStates.get(sessionId);
  if (state) {
    clearTimeout(state.poller);
    outputStates.delete(sessionId);
  }
}

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'claude') return;

  // Check user whitelist
  if (!isUserAllowed(interaction.user.id)) {
    await interaction.reply({ content: 'Unauthorized', ephemeral: true });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  try {
    switch (subcommand) {
      case 'new': {
        const name = interaction.options.getString('name', true);
        const directory = interaction.options.getString('directory') || config.defaultDirectory;

        await interaction.deferReply();

        const cleanName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50);
        const category = await getOrCreateCategory(interaction.guild!);

        const channel = await interaction.guild!.channels.create({
          name: `claude-${cleanName}`,
          type: ChannelType.GuildText,
          parent: category.id,
          topic: `Claude Code session | Directory: ${directory} | Attach: tmux attach -t claude-${cleanName}`,
        });

        const session = await sessionManager.createSession(cleanName, directory, channel.id);
        startOutputPoller(cleanName, channel);

        await channel.send({
          embeds: [
            new EmbedBuilder()
              .setTitle('Claude Code Session Started')
              .setColor(0x7c3aed)
              .addFields(
                { name: 'Directory', value: `\`${session.directory}\``, inline: false },
                { name: 'Attach via Terminal', value: `\`${session.attachCommand}\``, inline: false }
              )
              .setDescription('Just type your messages here to talk to Claude.\nOutput will appear automatically.')
              .setTimestamp(),
          ],
        });

        await interaction.editReply({
          content: `Session created! Head to ${channel} to start chatting with Claude.`,
        });

        botLog('info', `Session **${cleanName}** created by ${interaction.user.tag}`);
        updateBotStatus();
        break;
      }

      case 'list': {
        const sessions = sessionManager.listSessions();

        if (sessions.length === 0) {
          await interaction.reply('No active Claude Code sessions.');
          return;
        }

        const orphaned = sessions.filter(s => !s.channelId);

        const embed = new EmbedBuilder()
          .setTitle('Active Claude Sessions')
          .setColor(0x7c3aed)
          .setDescription(
            sessions
              .map((s) => {
                const channelMention = s.channelId ? `<#${s.channelId}>` : '**No channel**';
                const stats = sessionStats.get(s.id);
                let statsLine = '';
                if (stats) {
                  const parts = [
                    `${stats.messageCount} msg${stats.messageCount !== 1 ? 's' : ''}`,
                    formatUptime(stats.startTime),
                    formatLastActivity(stats.lastActivity),
                  ];
                  if (stats.filesEdited.length > 0) {
                    parts.push(`${stats.filesEdited.length} file${stats.filesEdited.length !== 1 ? 's' : ''} edited`);
                  }
                  statsLine = `\n📊 ${parts.join(' • ')}`;
                }
                return `**${s.id}** - ${channelMention}\n\`${s.directory}\`${statsLine}`;
              })
              .join('\n\n')
          )
          .setTimestamp();

        if (orphaned.length > 0) {
          embed.setFooter({ text: `${orphaned.length} session(s) need syncing. Use /claude sync` });
        }

        await interaction.reply({ embeds: [embed] });
        break;
      }

      case 'sync': {
        await interaction.deferReply();

        const result = await syncSessions(interaction.guild!);

        const embed = new EmbedBuilder()
          .setTitle('Session Sync Complete')
          .setColor(0x22c55e)
          .setTimestamp();

        if (result.linked.length === 0 && result.created.length === 0) {
          embed.setDescription('All sessions are already synced.');
        } else {
          const parts: string[] = [];
          if (result.linked.length > 0) {
            parts.push(`**Re-linked:** ${result.linked.join(', ')}`);
          }
          if (result.created.length > 0) {
            parts.push(`**Created channels:** ${result.created.join(', ')}`);
          }
          embed.setDescription(parts.join('\n'));
        }

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'end': {
        const channelId = interaction.channelId;
        const sessionId = sessionManager.getSessionByChannel(channelId);

        if (!sessionId) {
          await interaction.reply({
            content: 'This channel is not linked to a Claude session.',
            ephemeral: true,
          });
          return;
        }

        await interaction.deferReply();
        stopOutputPoller(sessionId);
        await sessionManager.killSession(sessionId);
        sessionStats.delete(sessionId);

        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('Session Ended')
              .setColor(0xef4444)
              .setDescription(
                `Session \`${sessionId}\` has been terminated.\nYou can delete this channel or keep it for reference.`
              )
              .setTimestamp(),
          ],
        });

        botLog('info', `Session **${sessionId}** ended by ${interaction.user.tag}`);
        updateBotStatus();
        break;
      }

      case 'output': {
        const channelId = interaction.channelId;
        const sessionId = sessionManager.getSessionByChannel(channelId);

        if (!sessionId) {
          await interaction.reply({
            content: 'This channel is not linked to a Claude session.',
            ephemeral: true,
          });
          return;
        }

        const requestedLines = interaction.options.getInteger('lines') || 100;
        const lines = Math.min(requestedLines, 1000); // Cap at 1000 for security
        await interaction.deferReply();

        const output = cleanForDisplay(sessionManager.captureOutput(sessionId, lines));
        const truncated = output.slice(-3900);

        await interaction.editReply({
          content: `\`\`\`ansi\n${truncated}\n\`\`\``,
        });
        break;
      }

      case 'attach': {
        const channelId = interaction.channelId;
        const sessionId = sessionManager.getSessionByChannel(channelId);

        if (!sessionId) {
          await interaction.reply({
            content: 'This channel is not linked to a Claude session.',
            ephemeral: true,
          });
          return;
        }

        const session = sessionManager.getSession(sessionId);
        if (!session) {
          await interaction.reply({
            content: 'Session not found.',
            ephemeral: true,
          });
          return;
        }

        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle('Attach to Session')
              .setColor(0x3b82f6)
              .addFields(
                { name: 'Command', value: `\`\`\`\n${session.attachCommand}\n\`\`\``, inline: false },
                { name: 'Directory', value: `\`${session.directory}\``, inline: false }
              )
              .setDescription('Run this command in your terminal to attach directly to the tmux session.'),
          ],
        });
        break;
      }

      case 'stop': {
        const channelId = interaction.channelId;
        const sessionId = sessionManager.getSessionByChannel(channelId);

        if (!sessionId) {
          await interaction.reply({
            content: 'This channel is not linked to a Claude session.',
            ephemeral: true,
          });
          return;
        }

        try {
          await sessionManager.sendEscape(sessionId);
          await interaction.reply({
            content: '⏹️ Sent stop signal (ESC) to Claude.',
            ephemeral: true,
          });
        } catch (error) {
          await interaction.reply({
            content: `Failed to stop: ${(error as Error).message}`,
            ephemeral: true,
          });
        }
        break;
      }

      case 'health': {
        const sessions = sessionManager.listSessions();

        if (sessions.length === 0) {
          await interaction.reply('No active sessions to report on.');
          return;
        }

        const lines: string[] = [];
        for (const session of sessions) {
          const state = outputStates.get(session.id);
          const stats = sessionStats.get(session.id);

          let status: string;
          let emoji: string;

          if (!state) {
            status = 'no poller';
            emoji = '⚪';
          } else {
            const timeSinceChange = Date.now() - state.lastContentChangeTime;
            if (state.awaitingResponse && timeSinceChange > config.healthStuckThresholdMs) {
              status = `stuck (${Math.round(timeSinceChange / 1000)}s no change)`;
              emoji = '🔴';
            } else if (state.awaitingResponse) {
              status = 'responding';
              emoji = '🟢';
            } else {
              status = 'idle';
              emoji = '🟡';
            }
          }

          const channelMention = session.channelId ? `<#${session.channelId}>` : 'no channel';
          const msgCount = stats ? `${stats.messageCount} msgs` : '0 msgs';
          const lastAct = stats ? formatLastActivity(stats.lastActivity) : 'unknown';

          lines.push(`${emoji} **${session.id}** - ${channelMention}\n   Status: ${status} | ${msgCount} | Last activity: ${lastAct}`);
        }

        const embed = new EmbedBuilder()
          .setTitle('Session Health')
          .setColor(0x3b82f6)
          .setDescription(lines.join('\n\n'))
          .setFooter({ text: 'Legend: 🟢 responding | 🟡 idle | 🔴 stuck | ⚪ no poller' })
          .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        break;
      }
    }
  } catch (error) {
    botLog('error', `Command error: ${(error as Error).message}`);
    const errorMessage = `Error: ${(error as Error).message}`;

    if (interaction.deferred) {
      await interaction.editReply({ content: errorMessage });
    } else {
      await interaction.reply({ content: errorMessage, ephemeral: true });
    }
  }
});

// Handle button clicks (for prompt responses and stop button)
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  // Check user whitelist
  if (!isUserAllowed(interaction.user.id)) {
    await interaction.reply({ content: 'Unauthorized', ephemeral: true });
    return;
  }

  const [type, sessionId, choice] = interaction.customId.split('_');

  // Verify the session belongs to this channel (prevent cross-channel attacks)
  const expectedSession = sessionManager.getSessionByChannel(interaction.channelId);
  if (expectedSession !== sessionId) {
    await interaction.reply({
      content: 'Session mismatch - this button is not valid for this channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Handle stop button
  if (type === 'stop') {
    try {
      await sessionManager.sendEscape(sessionId);
      await interaction.reply({
        content: '⏹️ Sent stop signal (ESC) to Claude.',
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      botLog('error', `Stop button error: ${(error as Error).message}`);
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: `Failed to stop: ${(error as Error).message}`,
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch {
        // Interaction expired or already handled, ignore
      }
    }
    return;
  }

  if (type !== 'prompt') return;

  try {
    await sessionManager.sendToSession(sessionId, choice);

    await interaction.update({
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId('selected')
            .setLabel(`Selected: ${choice}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true)
        ),
      ],
    });
  } catch (error) {
    botLog('error', `Button error: ${(error as Error).message}`);
    await interaction.reply({
      content: `Failed to send choice: ${(error as Error).message}`,
      ephemeral: true,
    });
  }
});

// Handle regular messages in session channels
client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return;

  // Check user whitelist
  if (!isUserAllowed(message.author.id)) return;

  const sessionId = sessionManager.getSessionByChannel(message.channelId);
  if (!sessionId) return;

  if (!sessionManager.sessionExists(sessionId)) {
    sessionManager.unlinkChannel(message.channelId);
    return;
  }

  // Rate limiting check
  const now = Date.now();
  const lastTime = userLastMessage.get(message.author.id) || 0;
  if (now - lastTime < config.rateLimitMs) {
    // Silently ignore rate-limited messages
    return;
  }
  userLastMessage.set(message.author.id, now);

  try {
    // Process attachments (images, text files, etc.)
    let messageText = message.content;
    if (message.attachments.size > 0) {
      const result = await processAttachments(message);
      messageText += result.appendText;

      // Send warnings back to the user if any
      if (result.warnings.length > 0) {
        await message.reply({
          content: '⚠️ ' + result.warnings.join('\n⚠️ '),
          allowedMentions: { repliedUser: false },
        });
      }
    }

    // Mark that we're starting a new turn - response should be a new message
    markUserInput(sessionId, message.content);
    await sessionManager.sendToSession(sessionId, messageText);
  } catch (error) {
    botLog('error', `Failed to send message to session: ${(error as Error).message}`);
    await message.reply({
      content: `Failed to send: ${(error as Error).message}`,
      allowedMentions: { repliedUser: false },
    });
  }
});

// Handle channel deletion
client.on('channelDelete', (channel) => {
  if (channel.type === ChannelType.GuildText) {
    const sessionId = sessionManager.getSessionByChannel(channel.id);
    if (sessionId) {
      stopOutputPoller(sessionId);
      sessionManager.unlinkChannel(channel.id);
      sessionStats.delete(sessionId);
      if (sessionManager.sessionExists(sessionId)) {
        sessionManager.killSession(sessionId).catch((e) => botLog('error', `Failed to kill session: ${e.message}`));
        botLog('info', `Session **${sessionId}** ended (channel deleted)`);
        updateBotStatus();
      }
    }
  }
});

// Clean up old messages in session channels
async function cleanupOldMessages(guild: Guild): Promise<number> {
  if (!config.messageRetentionDays) return 0;

  const cutoffTime = Date.now() - config.messageRetentionDays * 24 * 60 * 60 * 1000;
  let deletedCount = 0;

  // Find the Claude Sessions category
  const category = guild.channels.cache.find(
    (c): c is CategoryChannel =>
      c.type === ChannelType.GuildCategory && c.name === config.categoryName
  );

  if (!category) return 0;

  // Get all text channels in the category
  const channels = guild.channels.cache.filter(
    (c): c is TextChannel =>
      c.type === ChannelType.GuildText && c.parentId === category.id
  );

  for (const channel of channels.values()) {
    try {
      // Fetch messages (Discord limits to 100 per request)
      let lastId: string | undefined;
      let hasMore = true;

      while (hasMore) {
        const messages = await channel.messages.fetch({
          limit: 100,
          ...(lastId ? { before: lastId } : {}),
        });

        if (messages.size === 0) {
          hasMore = false;
          break;
        }

        lastId = messages.last()?.id;

        // Filter messages older than retention period
        const oldMessages = messages.filter(
          (m) => m.createdTimestamp < cutoffTime
        );

        // Delete old messages
        for (const msg of oldMessages.values()) {
          try {
            await msg.delete();
            deletedCount++;
            // Small delay to avoid rate limits
            await new Promise((r) => setTimeout(r, 100));
          } catch {
            // Message might already be deleted
          }
        }

        // If all messages in this batch are old, there might be more
        // If some are new, we've reached recent messages
        if (oldMessages.size < messages.size) {
          hasMore = false;
        }
      }
    } catch (error) {
      botLog('error', `Failed to cleanup messages in ${channel.name}: ${(error as Error).message}`);
    }
  }

  return deletedCount;
}

// Ready event - auto sync on startup
client.once('ready', async () => {
  botLog('info', `Logged in as ${client.user!.tag}`);
  botLog('info', 'Bot is ready to manage Claude Code sessions!');

  if (!sessionManager.checkTmux()) {
    botLog('warn', 'tmux is not installed. Please install tmux to use this bot.');
  }

  // Auto-sync sessions on startup
  if (config.guildId) {
    try {
      const guild = await client.guilds.fetch(config.guildId);

      // Find or create #bot-logs channel in the category
      const category = await getOrCreateCategory(guild);
      const existingLogChannel = guild.channels.cache.find(
        (c): c is TextChannel =>
          c.type === ChannelType.GuildText &&
          c.parentId === category.id &&
          c.name === 'bot-logs'
      );

      if (existingLogChannel) {
        logChannel = existingLogChannel;
      } else {
        logChannel = await guild.channels.create({
          name: 'bot-logs',
          type: ChannelType.GuildText,
          parent: category.id,
          topic: 'Bot activity logs and status updates',
        });
        botLog('info', 'Created #bot-logs channel');
      }

      // Set initial bot status
      updateBotStatus();

      const result = await syncSessions(guild);
      botLog('info', `Auto-sync: linked ${result.linked.length}, created ${result.created.length} channels`);

      // Update status after sync (session count may have changed)
      updateBotStatus();

      // Run message cleanup on startup if configured
      if (config.messageRetentionDays) {
        const deleted = await cleanupOldMessages(guild);
        if (deleted > 0) {
          botLog('info', `Message cleanup: deleted ${deleted} old message(s)`);
        }

        // Schedule hourly cleanup
        setInterval(async () => {
          try {
            const count = await cleanupOldMessages(guild);
            if (count > 0) {
              botLog('info', `Scheduled cleanup: deleted ${count} old message(s)`);
            }
          } catch (error) {
            botLog('error', `Scheduled cleanup failed: ${(error as Error).message}`);
          }
        }, 60 * 60 * 1000); // Every hour
      }
    } catch (error) {
      botLog('error', `Failed to auto-sync sessions: ${(error as Error).message}`);
    }
  }

  // Schedule hourly cleanup of temporary attachment files
  setInterval(() => {
    try {
      const deleted = cleanupTempAttachments();
      if (deleted > 0) {
        botLog('info', `Attachment cleanup: deleted ${deleted} old temp file(s)`);
      }
    } catch (error) {
      botLog('error', `Attachment cleanup failed: ${(error as Error).message}`);
    }
  }, 60 * 60 * 1000); // Every hour

  const sessions = sessionManager.listSessions();
  botLog('info', `Sessions: ${sessions.map((s) => `${s.id}${s.channelId ? '' : ' (orphaned)'}`).join(', ') || 'none'}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  for (const [sessionId] of outputStates) {
    stopOutputPoller(sessionId);
  }
  client.destroy();
  process.exit(0);
});

// Start the bot
async function start(): Promise<void> {
  await registerCommands();
  await client.login(config.token);
}

start().catch(console.error);
