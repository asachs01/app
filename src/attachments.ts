import { Message, Attachment } from 'discord.js';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';

const TEMP_DIR = '/tmp/disclaude-attachments';
const MAX_ATTACHMENTS = 5;
const MAX_FILE_SIZE = 1_048_576; // 1MB

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.ts', '.js', '.py', '.yaml', '.yml',
  '.toml', '.csv', '.log', '.sh', '.conf', '.xml', '.html', '.css', '.sql',
]);

// Ensure temp directory exists
function ensureTempDir(): void {
  try {
    mkdirSync(TEMP_DIR, { recursive: true });
  } catch {
    // Already exists
  }
}

/**
 * Download an attachment from Discord to the temp directory.
 * Returns the local file path.
 */
async function downloadAttachment(attachment: Attachment): Promise<string> {
  ensureTempDir();

  const timestamp = Date.now();
  const safeName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const localPath = join(TEMP_DIR, `${timestamp}-${safeName}`);

  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(`Failed to download ${attachment.name}: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(localPath, buffer);
  return localPath;
}

/**
 * Determines the category of an attachment based on its extension.
 */
function classifyAttachment(filename: string): 'image' | 'text' | 'other' {
  const ext = extname(filename).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'other';
}

export interface AttachmentResult {
  /** Extra text to append to the message content before sending to Claude */
  appendText: string;
  /** Warnings to send back to the Discord user (e.g., size/count exceeded) */
  warnings: string[];
}

/**
 * Process all attachments on a Discord message.
 * Downloads files, inlines text content, and returns text to append to the user message.
 */
export async function processAttachments(message: Message): Promise<AttachmentResult> {
  const attachments = [...message.attachments.values()];
  const warnings: string[] = [];
  const parts: string[] = [];

  if (attachments.length === 0) {
    return { appendText: '', warnings: [] };
  }

  if (attachments.length > MAX_ATTACHMENTS) {
    warnings.push(`Only processing the first ${MAX_ATTACHMENTS} of ${attachments.length} attachments (limit: ${MAX_ATTACHMENTS}).`);
  }

  const toProcess = attachments.slice(0, MAX_ATTACHMENTS);

  for (const attachment of toProcess) {
    if (attachment.size > MAX_FILE_SIZE) {
      warnings.push(`Skipped \`${attachment.name}\` (${(attachment.size / 1024 / 1024).toFixed(1)}MB exceeds 1MB limit).`);
      continue;
    }

    const category = classifyAttachment(attachment.name);

    try {
      const localPath = await downloadAttachment(attachment);

      switch (category) {
        case 'image':
          parts.push(`[Attached image: ${localPath}]`);
          break;

        case 'text': {
          const contents = readFileSync(localPath, 'utf-8');
          parts.push(`--- Attached: ${attachment.name} ---\n${contents}\n---`);
          break;
        }

        case 'other':
          parts.push(`[Attached file: ${localPath}]`);
          break;
      }
    } catch (error) {
      warnings.push(`Failed to process \`${attachment.name}\`: ${(error as Error).message}`);
    }
  }

  return {
    appendText: parts.length > 0 ? '\n' + parts.join('\n') : '',
    warnings,
  };
}

/**
 * Remove temp files older than 1 hour. Intended to be called on an hourly interval.
 */
export function cleanupTempAttachments(): number {
  const maxAge = 60 * 60 * 1000; // 1 hour
  const cutoff = Date.now() - maxAge;
  let deleted = 0;

  try {
    const files = readdirSync(TEMP_DIR);
    for (const file of files) {
      const filePath = join(TEMP_DIR, file);
      try {
        const stat = statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          unlinkSync(filePath);
          deleted++;
        }
      } catch {
        // File may have been removed already
      }
    }
  } catch {
    // Temp dir doesn't exist yet, nothing to clean
  }

  return deleted;
}
