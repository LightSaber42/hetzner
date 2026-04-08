import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'coding');
export const DEFAULT_ENV_FILE =
  process.env.TELEGRAM_BRIDGE_ENV_FILE || path.join(CONFIG_DIR, 'telegram-codex.env');
const STATE_ROOT = path.join(os.homedir(), '.local', 'state', 'coding', 'telegram-codex');

function parseEnvFile(contents) {
  const entries = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries[key] = value;
  }
  return entries;
}

async function loadEnvFile(envFile = DEFAULT_ENV_FILE) {
  try {
    return parseEnvFile(await readFile(envFile, 'utf8'));
  } catch {
    return {};
  }
}

export async function loadBridgeConfig() {
  const fileConfig = await loadEnvFile();
  const merged = { ...fileConfig, ...process.env };
  const botToken = String(merged.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(merged.TELEGRAM_CHAT_ID || '').trim();
  const userId = String(merged.TELEGRAM_USER_ID || chatId).trim();
  const stateStem = [chatId || 'unknown-chat', userId || 'unknown-user'].join('-');

  return {
    ...merged,
    BOT_TOKEN: botToken,
    CHAT_ID: chatId,
    USER_ID: userId,
    WORKDIR: merged.CODEX_WORKDIR || process.cwd(),
    CODEX_BIN: merged.CODEX_BIN || 'codex',
    CODEX_MODEL: merged.CODEX_MODEL || '',
    CODEX_TELEGRAM_INSTRUCTIONS: merged.CODEX_TELEGRAM_INSTRUCTIONS || '',
    CODEX_BYPASS_SANDBOX: merged.CODEX_BYPASS_SANDBOX === '1',
    CODEX_SEARCH: merged.CODEX_SEARCH === '1',
    CODEX_PROGRESS_UPDATES: merged.CODEX_PROGRESS_UPDATES !== '0',
    CODEX_PROGRESS_VERBOSE: merged.CODEX_PROGRESS_VERBOSE === '1',
    CODEX_TIMEOUT_MS: Number(merged.CODEX_TIMEOUT_MS || 10 * 60 * 1000),
    CODEX_PROGRESS_INTERVAL_MS: Number(merged.CODEX_PROGRESS_INTERVAL_MS || 8000),
    MAX_DOWNLOAD_BYTES: Number(merged.TELEGRAM_MAX_DOWNLOAD_BYTES || 25 * 1024 * 1024),
    STATE_STEM: stateStem,
    SESSION_FILE:
      merged.CODEX_SESSION_FILE ||
      path.join(CONFIG_DIR, `telegram-codex-session-${stateStem}.json`),
    LEGACY_SESSION_FILE: path.join('/tmp', `tg-codex-session-${stateStem}.json`),
    STATE_FILE:
      merged.TELEGRAM_BRIDGE_STATE_FILE ||
      path.join(CONFIG_DIR, `telegram-codex-state-${stateStem}.json`),
    DOWNLOAD_DIR:
      merged.TELEGRAM_DOWNLOAD_DIR || path.join(STATE_ROOT, 'inbox', stateStem),
    DOWNLOAD_INDEX_FILE:
      merged.TELEGRAM_DOWNLOAD_INDEX_FILE ||
      path.join(STATE_ROOT, 'inbox', stateStem, 'index.jsonl'),
    apiBase: botToken ? `https://api.telegram.org/bot${botToken}` : '',
    fileApiBase: botToken ? `https://api.telegram.org/file/bot${botToken}` : '',
  };
}

export function ensureTelegramConfig(config) {
  if (!config.BOT_TOKEN || !config.CHAT_ID) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID.');
  }
}

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

export async function writeJsonAtomic(targetPath, value) {
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
  await ensureDir(path.dirname(targetPath));
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmpPath, targetPath);
}

export async function readJsonFile(targetPath) {
  try {
    return JSON.parse(await readFile(targetPath, 'utf8'));
  } catch {
    return null;
  }
}

export async function telegramApi(config, method, body) {
  ensureTelegramConfig(config);

  let response;
  try {
    response = await fetch(`${config.apiBase}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`Telegram API transport error (${method}): ${describeError(error)}`);
  }

  if (!response.ok) {
    throw new Error(`Telegram API HTTP ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json();
  if (!payload.ok) {
    throw new Error(`Telegram API error (${method}): ${JSON.stringify(payload)}`);
  }
  return payload.result;
}

export async function sendTelegramMessage(config, text, replyToMessageId) {
  const payload = {
    chat_id: config.CHAT_ID,
    text,
    disable_web_page_preview: true,
  };
  if (replyToMessageId) {
    payload.reply_to_message_id = replyToMessageId;
  }
  return telegramApi(config, 'sendMessage', payload);
}

export async function sendTelegramDocument(
  config,
  sourcePath,
  { caption = '', replyToMessageId = undefined } = {},
) {
  ensureTelegramConfig(config);

  const fileStat = await stat(sourcePath);
  if (!fileStat.isFile()) {
    throw new Error(`Not a regular file: ${sourcePath}`);
  }

  const body = new FormData();
  body.set('chat_id', config.CHAT_ID);
  if (caption) {
    body.set('caption', caption);
  }
  if (replyToMessageId) {
    body.set('reply_to_message_id', String(replyToMessageId));
  }

  const fileName = path.basename(sourcePath);
  const bytes = await readFile(sourcePath);
  body.set('document', new File([bytes], fileName));

  let response;
  try {
    response = await fetch(`${config.apiBase}/sendDocument`, {
      method: 'POST',
      body,
    });
  } catch (error) {
    throw new Error(`Telegram API transport error (sendDocument): ${describeError(error)}`);
  }

  if (!response.ok) {
    throw new Error(`Telegram API HTTP ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json();
  if (!payload.ok) {
    throw new Error(`Telegram API error (sendDocument): ${JSON.stringify(payload)}`);
  }
  return payload.result;
}

export function sanitizeFilename(input) {
  const raw = String(input || '').trim();
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return safe || `telegram-file-${Date.now()}`;
}

function extFromMimeType(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  const mapping = {
    'application/json': '.json',
    'application/pdf': '.pdf',
    'application/zip': '.zip',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'text/csv': '.csv',
    'text/markdown': '.md',
    'text/plain': '.txt',
    'video/mp4': '.mp4',
  };
  return mapping[normalized] || '';
}

export function extractAttachment(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }

  if (message.document?.file_id) {
    return {
      kind: 'document',
      fileId: message.document.file_id,
      uniqueId: message.document.file_unique_id || '',
      fileName: message.document.file_name || '',
      mimeType: message.document.mime_type || '',
      fileSize: Number(message.document.file_size || 0),
    };
  }

  if (message.audio?.file_id) {
    return {
      kind: 'audio',
      fileId: message.audio.file_id,
      uniqueId: message.audio.file_unique_id || '',
      fileName: message.audio.file_name || '',
      mimeType: message.audio.mime_type || '',
      fileSize: Number(message.audio.file_size || 0),
    };
  }

  if (message.voice?.file_id) {
    return {
      kind: 'voice',
      fileId: message.voice.file_id,
      uniqueId: message.voice.file_unique_id || '',
      fileName: '',
      mimeType: message.voice.mime_type || 'audio/ogg',
      fileSize: Number(message.voice.file_size || 0),
    };
  }

  if (message.video?.file_id) {
    return {
      kind: 'video',
      fileId: message.video.file_id,
      uniqueId: message.video.file_unique_id || '',
      fileName: message.video.file_name || '',
      mimeType: message.video.mime_type || '',
      fileSize: Number(message.video.file_size || 0),
    };
  }

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const best = message.photo[message.photo.length - 1];
    return {
      kind: 'photo',
      fileId: best.file_id,
      uniqueId: best.file_unique_id || '',
      fileName: '',
      mimeType: 'image/jpeg',
      fileSize: Number(best.file_size || 0),
    };
  }

  return null;
}

export async function downloadTelegramAttachment(config, attachment, message, downloadDir) {
  if (!attachment?.fileId) {
    throw new Error('Missing Telegram file identifier.');
  }
  if (attachment.fileSize > 0 && attachment.fileSize > config.MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `Telegram file is too large (${attachment.fileSize} bytes, limit ${config.MAX_DOWNLOAD_BYTES}).`,
    );
  }

  const fileMeta = await telegramApi(config, 'getFile', { file_id: attachment.fileId });
  const remotePath = String(fileMeta?.file_path || '').trim();
  if (!remotePath) {
    throw new Error('Telegram did not return a file path for this attachment.');
  }

  const remoteExt = path.extname(remotePath);
  const derivedName =
    sanitizeFilename(attachment.fileName) ||
    `message-${message.message_id}-${attachment.kind}${remoteExt || extFromMimeType(attachment.mimeType)}`;
  const safeBase = path.basename(derivedName, path.extname(derivedName));
  const extension = path.extname(derivedName) || remoteExt || extFromMimeType(attachment.mimeType);
  const localName = `${String(message.message_id).padStart(10, '0')}-${safeBase}${extension}`;
  const localPath = path.join(downloadDir, localName);
  const tmpPath = `${localPath}.${randomUUID()}.tmp`;

  await ensureDir(downloadDir);

  let response;
  try {
    response = await fetch(`${config.fileApiBase}/${remotePath}`);
  } catch (error) {
    throw new Error(`Telegram file download failed: ${describeError(error)}`);
  }

  if (!response.ok) {
    throw new Error(`Telegram file download HTTP ${response.status}: ${await response.text()}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(tmpPath, bytes);
  await rename(tmpPath, localPath);

  const record = {
    chat_id: config.CHAT_ID,
    user_id: config.USER_ID,
    message_id: message.message_id,
    update_id: message.update_id || null,
    kind: attachment.kind,
    caption: String(message.caption || '').trim(),
    local_path: localPath,
    original_file_name: attachment.fileName || '',
    mime_type: attachment.mimeType || '',
    file_size: attachment.fileSize || bytes.length,
    telegram_file_id: attachment.fileId,
    telegram_file_unique_id: attachment.uniqueId,
    telegram_file_path: remotePath,
    received_at: new Date().toISOString(),
  };

  await appendJsonLine(config.DOWNLOAD_INDEX_FILE, record);
  return record;
}

export async function appendJsonLine(targetPath, value) {
  await ensureDir(path.dirname(targetPath));
  await writeFile(targetPath, `${JSON.stringify(value)}\n`, { flag: 'a' });
}

export async function readJsonLinesReverse(targetPath, limit = 20) {
  try {
    const raw = await readFile(targetPath, 'utf8');
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines
      .slice(Math.max(0, lines.length - limit))
      .reverse()
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export function describeError(error) {
  if (!error) {
    return 'Unknown error';
  }
  const base = error.message || String(error);
  const causeMessage = error.cause?.message || '';
  return causeMessage && causeMessage !== base ? `${base} (cause: ${causeMessage})` : base;
}

export function buildResumeCommand(config, threadId) {
  const baseCommand = config.CODEX_BIN || 'codex';
  const safeThread = threadId || '<thread-id>';
  return `${baseCommand} resume --include-non-interactive -C ${JSON.stringify(
    config.WORKDIR,
  )} ${safeThread}`;
}

export async function removeFileIfExists(targetPath) {
  await rm(targetPath, { force: true });
}
