#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import {
  buildResumeCommand,
  describeError,
  downloadTelegramAttachment,
  ensureDir,
  ensureTelegramConfig,
  extractAttachment,
  loadBridgeConfig,
  readJsonFile,
  removeFileIfExists,
  sendTelegramMessage,
  telegramApi,
  writeJsonAtomic,
} from './telegram_bridge_support.mjs';

const TELEGRAM_MAX = 3500;
const BRIDGE_SESSION_SCHEMA_VERSION = 2;

let config;
let lastUpdateId = 0;
let stopping = false;
let busy = false;
let queue = Promise.resolve();
let threadId = null;
let activeCodexChild = null;
let stopRequested = false;
let queuedMessages = 0;
let activePromptStartedAt = 0;
let activePromptPreview = '';

function isoNow() {
  return new Date().toISOString();
}

function log(message) {
  process.stdout.write(`[${isoNow()}] ${message}\n`);
}

function err(message) {
  process.stderr.write(`[${isoNow()}] ${message}\n`);
}

function splitMessage(text) {
  if (text.length <= TELEGRAM_MAX) {
    return [text];
  }

  const parts = [];
  let cursor = 0;
  while (cursor < text.length) {
    parts.push(text.slice(cursor, cursor + TELEGRAM_MAX));
    cursor += TELEGRAM_MAX;
  }
  return parts;
}

function buildTelegramPrompt(userPrompt) {
  const instructions = String(config.CODEX_TELEGRAM_INSTRUCTIONS || '').trim();
  return instructions ? `${instructions}\n\nUser message:\n${userPrompt}` : userPrompt;
}

function extractCommandText(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    return text || null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = extractCommandText(entry);
      if (text) {
        return text;
      }
    }
    return null;
  }
  if (typeof value !== 'object') {
    return null;
  }

  const candidateKeys = [
    'command',
    'cmd',
    'input',
    'text',
    'raw_input',
    'formatted_input',
    'shell_command',
  ];

  for (const key of candidateKeys) {
    const text = extractCommandText(value[key]);
    if (text) {
      return text;
    }
  }
  return null;
}

function getCommandExecutionText(event) {
  const item = event?.item;
  const candidates = [
    item?.command,
    item?.cmd,
    item?.input,
    item?.args,
    item?.payload,
    item?.metadata,
    item?.details,
    event?.command,
    event?.payload,
    event?.details,
  ];

  for (const candidate of candidates) {
    const text = extractCommandText(candidate);
    if (text) {
      return text;
    }
  }
  return null;
}

function summarizeEvent(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  if (event.type === 'thread.started' && event.thread_id) {
    return `Session ready (${event.thread_id.slice(0, 8)}...)`;
  }
  if (event.type === 'turn.started') {
    return 'Turn started';
  }
  if (event.type === 'turn.completed') {
    const usage = event.usage || {};
    if (usage.input_tokens || usage.output_tokens) {
      return `Turn completed (in=${usage.input_tokens || 0}, out=${usage.output_tokens || 0})`;
    }
    return 'Turn completed';
  }
  if (event.type === 'item.started' || event.type === 'item.completed') {
    const state = event.type === 'item.started' ? 'started' : 'completed';
    const itemType = event.item?.type || 'item';
    const itemName =
      event.item?.name || event.item?.tool_name || event.item?.tool || event.item?.id || '';

    if (!config.CODEX_PROGRESS_VERBOSE) {
      if (itemType === 'agent_message') {
        return null;
      }
      if (itemType === 'command_execution') {
        const commandText = getCommandExecutionText(event);
        if (state === 'started') {
          return commandText ? `Running: ${commandText}` : 'Running a shell command...';
        }
        return commandText ? `Finished: ${commandText}` : 'Shell command finished';
      }
      return null;
    }

    return itemName ? `${itemType} ${state}: ${itemName}` : `${itemType} ${state}`;
  }

  return null;
}

async function persistState() {
  const payload = {
    bridge_session_schema_version: BRIDGE_SESSION_SCHEMA_VERSION,
    chat_id: config.CHAT_ID,
    user_id: config.USER_ID,
    workdir: config.WORKDIR,
    codex_bin: config.CODEX_BIN,
    thread_id: threadId,
    busy,
    queued_messages: queuedMessages,
    active_prompt_started_at: activePromptStartedAt ? new Date(activePromptStartedAt).toISOString() : null,
    active_prompt_preview: activePromptPreview || '',
    last_update_id: lastUpdateId,
    session_file: config.SESSION_FILE,
    state_file: config.STATE_FILE,
    download_dir: config.DOWNLOAD_DIR,
    download_index_file: config.DOWNLOAD_INDEX_FILE,
    resume_command: buildResumeCommand(config, threadId),
    updated_at: isoNow(),
  };

  await writeJsonAtomic(config.STATE_FILE, payload);
  if (threadId) {
    await writeJsonAtomic(config.SESSION_FILE, { thread_id: threadId });
  }
}

async function loadState() {
  const state = await readJsonFile(config.STATE_FILE);
  const storedSchemaVersion = Number(state?.bridge_session_schema_version || 0);
  const needsFreshSession = storedSchemaVersion !== BRIDGE_SESSION_SCHEMA_VERSION;

  if (!needsFreshSession && state?.thread_id) {
    threadId = String(state.thread_id).trim();
  } else {
    threadId = null;
    await removeFileIfExists(config.SESSION_FILE);
  }

  const persistedLastUpdateId = Number(state?.last_update_id || 0);
  lastUpdateId = Number.isFinite(persistedLastUpdateId) && persistedLastUpdateId > 0 ? persistedLastUpdateId : 0;
  await persistState();
  return {
    needsFreshSession,
  };
}

async function resetSession() {
  threadId = null;
  await removeFileIfExists(config.SESSION_FILE);
  await persistState();
}

async function sendMessage(text, replyToMessageId) {
  return sendTelegramMessage(config, text, replyToMessageId);
}

async function runCodex(prompt) {
  const outFile = path.join('/tmp', `codex-telegram-last-${randomUUID()}.txt`);
  let currentThreadId = null;
  const effectivePrompt = buildTelegramPrompt(prompt);

  const args = [];
  if (config.CODEX_SEARCH) {
    args.push('--search');
  }
  if (threadId) {
    args.push('exec', 'resume', '--json', threadId, effectivePrompt, '--output-last-message', outFile);
  } else {
    args.push('exec', '--json', effectivePrompt, '--sandbox', 'workspace-write', '--output-last-message', outFile);
  }
  if (config.CODEX_BYPASS_SANDBOX) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }
  if (config.CODEX_MODEL && !threadId) {
    args.push('--model', config.CODEX_MODEL);
  }

  let stdout = '';
  let stderr = '';
  let stdoutJsonBuffer = '';

  await new Promise((resolve, reject) => {
    const child = spawn(config.CODEX_BIN, args, {
      cwd: config.WORKDIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeCodexChild = child;
    stopRequested = false;

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Codex timed out after ${config.CODEX_TIMEOUT_MS}ms`));
    }, config.CODEX_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      const chunkText = chunk.toString();
      stdout += chunkText;
      stdoutJsonBuffer += chunkText;
      const lines = stdoutJsonBuffer.split('\n');
      stdoutJsonBuffer = lines.pop() || '';
      for (const line of lines) {
        try {
          const event = JSON.parse(line.trim());
          if (event?.type === 'thread.started' && event.thread_id) {
            currentThreadId = event.thread_id;
          }
          if (typeof runCodex.onEvent === 'function') {
            runCodex.onEvent(event);
          }
        } catch {
          // Ignore non-JSON lines.
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      activeCodexChild = null;
      reject(error);
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      activeCodexChild = null;
      if (code === 0) {
        resolve();
        return;
      }
      if (stopRequested) {
        reject(new Error('Stopped by /stop command.'));
        return;
      }
      reject(new Error(`Codex exit ${code}. stderr: ${stderr || '(none)'}`));
    });
  });

  try {
    const message = (await readFile(outFile, 'utf8')).trim();
    if (message) {
      return { message, threadId: currentThreadId || threadId };
    }
  } finally {
    await rm(outFile, { force: true });
  }

  const fallback = stdout.trim();
  if (fallback) {
    return { message: fallback, threadId: currentThreadId || threadId };
  }

  throw new Error('Codex returned empty output.');
}

runCodex.onEvent = null;

function helpText() {
  return [
    'Telegram Codex bridge is online.',
    'Send text or a file and it will be forwarded to Codex with resumable context.',
    'Commands: /start, /help, /status, /session, /new, /stop',
    'Incoming Telegram files are saved locally and included in the Codex prompt.',
  ].join('\n');
}

function getActiveStatusText() {
  const elapsedSeconds = activePromptStartedAt
    ? Math.max(1, Math.round((Date.now() - activePromptStartedAt) / 1000))
    : 0;
  const activeText = busy
    ? `busy=yes elapsed=${elapsedSeconds}s active="${activePromptPreview || '(unknown)'}"`
    : 'busy=no';
  return `Bridge is online. ${activeText} queued=${queuedMessages} session=${threadId || 'none'}`;
}

function getSessionText() {
  return [
    `thread_id=${threadId || 'none'}`,
    `state_file=${config.STATE_FILE}`,
    `session_file=${config.SESSION_FILE}`,
    `download_dir=${config.DOWNLOAD_DIR}`,
    `resume_command=${buildResumeCommand(config, threadId)}`,
  ].join('\n');
}

async function stopActiveCodexRun(msgId) {
  if (!activeCodexChild) {
    await sendMessage('No active Codex run to stop.', msgId);
    return;
  }

  stopRequested = true;
  await sendMessage('Urgent stop requested. Stopping current Codex run...', msgId);
  try {
    activeCodexChild.kill('SIGTERM');
  } catch {
    // Ignore.
  }

  setTimeout(() => {
    if (activeCodexChild) {
      try {
        activeCodexChild.kill('SIGKILL');
      } catch {
        // Ignore.
      }
    }
  }, 2000);
}

function buildIncomingPrompt(message, downloadedAttachment) {
  const userText = String(message.text || message.caption || '').trim();
  if (!downloadedAttachment) {
    return userText;
  }

  const parts = [
    'Telegram attachment received.',
    `Saved local file: ${downloadedAttachment.local_path}`,
    `Attachment kind: ${downloadedAttachment.kind}`,
  ];

  if (downloadedAttachment.original_file_name) {
    parts.push(`Original file name: ${downloadedAttachment.original_file_name}`);
  }
  if (downloadedAttachment.mime_type) {
    parts.push(`MIME type: ${downloadedAttachment.mime_type}`);
  }
  if (downloadedAttachment.file_size) {
    parts.push(`File size: ${downloadedAttachment.file_size} bytes`);
  }
  if (downloadedAttachment.caption) {
    parts.push(`Telegram caption: ${downloadedAttachment.caption}`);
  }

  parts.push('');
  parts.push(
    userText
      ? `User message:\n${userText}`
      : 'User message:\nPlease inspect the saved file and respond based on its contents.',
  );
  parts.push('');
  parts.push('Use the saved local file path above when you need to open or modify the attachment.');
  return parts.join('\n');
}

async function handleIncomingMessage(message) {
  const msgId = message.message_id;
  const text = String(message.text || '').trim();
  const from = message.from?.username ? `@${message.from.username}` : 'user';

  if (text === '/start' || text === '/help') {
    await sendMessage(helpText(), msgId);
    return;
  }
  if (text === '/status') {
    await sendMessage(getActiveStatusText(), msgId);
    return;
  }
  if (text === '/session') {
    await sendMessage(getSessionText(), msgId);
    return;
  }
  if (text === '/new') {
    await resetSession();
    await sendMessage('Started a new Codex session. Previous context cleared.', msgId);
    return;
  }

  const attachment = extractAttachment(message);
  let downloadedAttachment = null;
  if (!text && !message.caption && !attachment) {
    return;
  }

  if (attachment) {
    try {
      downloadedAttachment = await downloadTelegramAttachment(
        config,
        attachment,
        message,
        config.DOWNLOAD_DIR,
      );
    } catch (error) {
      err(`Attachment download failed: ${describeError(error)}`);
      await sendMessage(`Failed to receive the Telegram file: ${describeError(error)}`, msgId);
      return;
    }
  }

  const prompt = buildIncomingPrompt(message, downloadedAttachment).trim();
  if (!prompt) {
    return;
  }

  busy = true;
  activePromptStartedAt = Date.now();
  activePromptPreview = prompt.replace(/\s+/g, ' ').slice(0, 120);
  await persistState();

  const receivedLabel = downloadedAttachment
    ? `Prompt from ${from} with ${downloadedAttachment.kind}: ${activePromptPreview}`
    : `Prompt from ${from}: ${activePromptPreview}`;
  log(receivedLabel);

  await sendMessage(
    downloadedAttachment ? 'Received your file. Processing with Codex...' : 'Processing with Codex...',
    msgId,
  );

  try {
    let lastProgressTs = 0;
    let lastProgressText = '';
    runCodex.onEvent = async (event) => {
      if (!config.CODEX_PROGRESS_UPDATES) {
        return;
      }

      const status = summarizeEvent(event);
      if (!status || status === lastProgressText) {
        return;
      }

      const now = Date.now();
      if (lastProgressTs && now - lastProgressTs < config.CODEX_PROGRESS_INTERVAL_MS) {
        return;
      }

      lastProgressTs = now;
      lastProgressText = status;
      try {
        await sendMessage(`Status: ${status}`, msgId);
      } catch (progressError) {
        err(`Progress update failed: ${describeError(progressError)}`);
      }
    };

    const result = await runCodex(prompt);
    runCodex.onEvent = null;
    if (result.threadId && result.threadId !== threadId) {
      threadId = result.threadId;
      log(`Session updated: thread_id=${threadId}`);
    }
    await persistState();

    const parts = splitMessage(result.message);
    for (let index = 0; index < parts.length; index += 1) {
      const prefix = parts.length > 1 ? `[${index + 1}/${parts.length}]\n` : '';
      await sendMessage(`${prefix}${parts[index]}`, msgId);
    }
    log(`Replied to ${from} (${parts.length} part${parts.length > 1 ? 's' : ''}).`);
  } catch (error) {
    runCodex.onEvent = null;
    err(`Codex error: ${describeError(error)}`);
    await sendMessage(`Codex failed: ${describeError(error)}`, msgId);
  } finally {
    runCodex.onEvent = null;
    busy = false;
    activePromptStartedAt = 0;
    activePromptPreview = '';
    await persistState();
  }
}

async function pollLoop() {
  while (!stopping) {
    try {
      const updates = await telegramApi(config, 'getUpdates', {
        timeout: 45,
        offset: lastUpdateId + 1,
        allowed_updates: ['message'],
      });

      for (const update of updates) {
        lastUpdateId = update.update_id;
        const message = update.message;
        if (!message) {
          continue;
        }
        message.update_id = update.update_id;

        if (message.from?.is_bot) {
          continue;
        }

        const incomingChatId = String(message.chat?.id ?? '');
        const incomingUserId = String(message.from?.id ?? '');
        if (incomingChatId !== String(config.CHAT_ID)) {
          continue;
        }
        if (incomingUserId !== String(config.USER_ID)) {
          continue;
        }

        const text = String(message.text || '').trim();
        if (text === '/stop' || text === '/urgentstop') {
          await stopActiveCodexRun(message.message_id);
          continue;
        }

        const queuePosition = busy ? queuedMessages + 1 : queuedMessages;
        if (queuePosition > 0) {
          try {
            await sendMessage(
              `Bridge is busy. Queued your message at position ${queuePosition}. Send /stop to interrupt the active run.`,
              message.message_id,
            );
          } catch (queueAckError) {
            err(`Queue acknowledgement failed: ${describeError(queueAckError)}`);
          }
        }

        queuedMessages += 1;
        await persistState();
        queue = queue
          .then(async () => {
            queuedMessages = Math.max(0, queuedMessages - 1);
            await persistState();
            await handleIncomingMessage(message);
          })
          .catch((error) => {
            err(`Queue error: ${describeError(error)}`);
          });
      }
      await persistState();
    } catch (error) {
      err(`Poll error: ${describeError(error)}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function bootstrap() {
  config = await loadBridgeConfig();
  ensureTelegramConfig(config);
  await ensureDir(path.dirname(config.STATE_FILE));
  await ensureDir(path.dirname(config.SESSION_FILE));
  await ensureDir(config.DOWNLOAD_DIR);
  log('Telegram Codex bridge starting...');
  const stateInfo = await loadState();
  try {
    await sendMessage('Codex bridge online. Send a prompt or file to start.', undefined);
    if (stateInfo.needsFreshSession) {
      await sendMessage(
        'Bridge capabilities changed. Saved Codex session was reset so new MCP tools are available on the next message.',
        undefined,
      );
    }
  } catch (error) {
    err(`Startup notification failed: ${describeError(error)}`);
  }
  await pollLoop();
}

async function shutdown() {
  if (stopping) {
    return;
  }
  stopping = true;
  log('Shutting down...');
  await queue.catch(() => {});
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

bootstrap().catch((error) => {
  err(`Fatal error: ${describeError(error)}`);
  process.exit(1);
});
