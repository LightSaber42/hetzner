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
const BRIDGE_SESSION_SCHEMA_VERSION = 3;

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
let capabilityState = {
  fingerprint: '',
  mcpServerNames: [],
  telegramFileMcpAvailable: false,
};
let threadCapabilityFingerprint = '';

function isoNow() {
  return new Date().toISOString();
}

function log(message) {
  process.stdout.write(`[${isoNow()}] ${message}\n`);
}

function err(message) {
  process.stderr.write(`[${isoNow()}] ${message}\n`);
}

function getDefaultCodexModel() {
  return String(config?.DEFAULT_CODEX_MODEL || '').trim();
}

function getCodexModelOverride() {
  return String(config?.CODEX_MODEL_OVERRIDE || '').trim();
}

function getEffectiveCodexModel() {
  return getCodexModelOverride() || getDefaultCodexModel();
}

function getCodexModelSource() {
  if (getCodexModelOverride()) {
    return 'runtime_override';
  }
  if (getDefaultCodexModel()) {
    return 'env';
  }
  return 'auto';
}

function formatCodexModelForDisplay(model) {
  return model ? `"${model}"` : 'auto';
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

function parseMcpServerNames(rawOutput) {
  const names = [];
  for (const rawLine of String(rawOutput || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('WARNING:') || line.startsWith('Name ')) {
      continue;
    }
    const match = line.match(/^([^\s]+)/);
    if (match?.[1]) {
      names.push(match[1]);
    }
  }
  return Array.from(new Set(names)).sort();
}

async function detectCapabilityState() {
  let stdout = '';
  let stderr = '';

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(config.CODEX_BIN, ['mcp', 'list'], {
        cwd: config.WORKDIR,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`Codex MCP listing failed with exit ${code}. stderr: ${stderr || '(none)'}`));
      });
    });
  } catch (error) {
    err(`Capability detection failed: ${describeError(error)}`);
    return null;
  }

  const mcpServerNames = parseMcpServerNames(stdout);
  return {
    fingerprint: JSON.stringify(mcpServerNames),
    mcpServerNames,
    telegramFileMcpAvailable: mcpServerNames.includes('telegram-file'),
  };
}

function buildTelegramPrompt(userPrompt) {
  const instructions = String(config.CODEX_TELEGRAM_INSTRUCTIONS || '').trim();
  const parts = [];

  if (instructions) {
    parts.push(instructions);
  }

  if (capabilityState.telegramFileMcpAvailable) {
    parts.push(
      [
        'Telegram bridge capability note:',
        '- The `telegram-file` MCP is available in this Codex session.',
        '- If the user asks you to send a local file back to Telegram, call `telegram_send_file` with the absolute path and optional caption.',
        '- Do not claim local file upload is unavailable when this tool is present.',
      ].join('\n'),
    );
  }

  parts.push(`User message:\n${userPrompt}`);
  return parts.join('\n\n');
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
    bridge_capability_fingerprint: capabilityState.fingerprint || null,
    thread_capability_fingerprint: threadCapabilityFingerprint || null,
    telegram_file_mcp_available: capabilityState.telegramFileMcpAvailable,
    codex_model: getEffectiveCodexModel() || null,
    codex_model_source: getCodexModelSource(),
    codex_model_override: getCodexModelOverride() || null,
    default_codex_model: getDefaultCodexModel() || null,
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
  if (Object.prototype.hasOwnProperty.call(state || {}, 'codex_model_override')) {
    config.CODEX_MODEL_OVERRIDE = String(state?.codex_model_override || '').trim();
  }
  const hadSavedThread = Boolean(state?.thread_id);
  const storedSchemaVersion = Number(state?.bridge_session_schema_version || 0);
  const storedThreadCapabilityFingerprint = String(state?.thread_capability_fingerprint || '').trim();
  const currentCapabilityFingerprint = String(capabilityState.fingerprint || '').trim();
  const needsFreshSession =
    hadSavedThread &&
    (storedSchemaVersion !== BRIDGE_SESSION_SCHEMA_VERSION ||
      Boolean(currentCapabilityFingerprint) &&
      storedThreadCapabilityFingerprint !== currentCapabilityFingerprint);

  if (!needsFreshSession && state?.thread_id) {
    threadId = String(state.thread_id).trim();
    threadCapabilityFingerprint =
      storedThreadCapabilityFingerprint || currentCapabilityFingerprint || '';
  } else {
    threadId = null;
    threadCapabilityFingerprint = '';
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
  threadCapabilityFingerprint = '';
  await removeFileIfExists(config.SESSION_FILE);
  await persistState();
}

async function refreshCapabilityState() {
  const nextCapabilityState = await detectCapabilityState();
  if (!nextCapabilityState) {
    return capabilityState;
  }
  capabilityState = nextCapabilityState;
  return capabilityState;
}

async function ensureThreadMatchesCapabilities(replyToMessageId) {
  await refreshCapabilityState();
  const currentCapabilityFingerprint = String(capabilityState.fingerprint || '').trim();
  if (!threadId || !currentCapabilityFingerprint) {
    return false;
  }
  if (threadCapabilityFingerprint === currentCapabilityFingerprint) {
    return false;
  }

  const previousThreadId = threadId;
  const previousThreadCapabilityFingerprint = threadCapabilityFingerprint || '(none)';
  await resetSession();
  log(
    `Session reset after capability change: thread_id=${previousThreadId.slice(0, 8)}... old_fingerprint=${previousThreadCapabilityFingerprint} new_fingerprint=${currentCapabilityFingerprint}`,
  );
  await sendMessage(
    capabilityState.telegramFileMcpAvailable
      ? 'Bridge capabilities changed. Reset the saved Codex session so the refreshed MCP tools, including telegram-file, apply to this message.'
      : 'Bridge capabilities changed. Reset the saved Codex session so the refreshed MCP tool set applies to this message.',
    replyToMessageId,
  );
  return true;
}

async function sendMessage(text, replyToMessageId) {
  return sendTelegramMessage(config, text, replyToMessageId);
}

async function runCodex(prompt) {
  const outFile = path.join('/tmp', `codex-telegram-last-${randomUUID()}.txt`);
  let currentThreadId = null;
  const effectivePrompt = buildTelegramPrompt(prompt);
  const selectedModel = getEffectiveCodexModel();

  const args = [];
  if (config.CODEX_SEARCH) {
    args.push('--search');
  }
  if (threadId) {
    args.push('exec', 'resume', '--json');
  } else {
    args.push('exec', '--json', '--sandbox', 'workspace-write');
  }
  if (config.CODEX_BYPASS_SANDBOX) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }
  if (selectedModel) {
    args.push('--model', selectedModel);
  }
  if (threadId) {
    args.push(threadId, effectivePrompt, '--output-last-message', outFile);
  } else {
    args.push(effectivePrompt, '--output-last-message', outFile);
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
    'Commands: /start, /help, /status, /session, /new, /model, /stop',
    '/urgentstop is accepted as an alias for /stop.',
    'Use /model to show the active model, /model <name> to set it, or /model default to clear the runtime override.',
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
  return `Bridge is online. ${activeText} queued=${queuedMessages} session=${threadId || 'none'} model=${getEffectiveCodexModel() || 'auto'} source=${getCodexModelSource()}`;
}

function getSessionText() {
  return [
    `thread_id=${threadId || 'none'}`,
    `codex_model=${getEffectiveCodexModel() || 'auto'}`,
    `codex_model_source=${getCodexModelSource()}`,
    `codex_model_override=${getCodexModelOverride() || 'none'}`,
    `default_codex_model=${getDefaultCodexModel() || 'auto'}`,
    `telegram_file_mcp=${capabilityState.telegramFileMcpAvailable ? 'enabled' : 'disabled'}`,
    `thread_capability_fingerprint=${threadCapabilityFingerprint || 'none'}`,
    `state_file=${config.STATE_FILE}`,
    `session_file=${config.SESSION_FILE}`,
    `download_dir=${config.DOWNLOAD_DIR}`,
    `resume_command=${buildResumeCommand(config, threadId)}`,
  ].join('\n');
}

function getModelText() {
  return [
    `codex_model=${getEffectiveCodexModel() || 'auto'}`,
    `codex_model_source=${getCodexModelSource()}`,
    `codex_model_override=${getCodexModelOverride() || 'none'}`,
    `default_codex_model=${getDefaultCodexModel() || 'auto'}`,
    'Usage: /model <name> to set a runtime override.',
    'Usage: /model default to clear the runtime override.',
  ].join('\n');
}

function parseModelCommand(text) {
  const match = String(text || '')
    .trim()
    .match(/^\/model(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]+))?$/);
  if (!match) {
    return null;
  }
  return {
    rawArgument: String(match[1] || '').trim(),
  };
}

async function handleModelCommand(rawArgument, msgId) {
  if (!rawArgument) {
    await sendMessage(getModelText(), msgId);
    return;
  }

  const nextValue = String(rawArgument || '').trim();
  if (!nextValue) {
    await sendMessage(getModelText(), msgId);
    return;
  }

  const normalized = nextValue.toLowerCase();
  if (normalized === 'default' || normalized === 'auto' || normalized === 'clear' || normalized === 'reset') {
    const hadOverride = Boolean(getCodexModelOverride());
    config.CODEX_MODEL_OVERRIDE = '';
    await persistState();

    if (hadOverride) {
      const effectiveModel = getEffectiveCodexModel();
      await sendMessage(
        effectiveModel
          ? `Cleared the runtime model override. Future Codex runs will use ${formatCodexModelForDisplay(effectiveModel)} from the env configuration. Send /new if you want a fresh thread under that model.`
          : 'Cleared the runtime model override. Future Codex runs will use Codex automatic model selection. Send /new if you want a fresh thread under that selection.',
        msgId,
      );
      return;
    }

    await sendMessage('No runtime model override is set. Use /model <name> to choose one.', msgId);
    return;
  }

  if (nextValue === getCodexModelOverride()) {
    await sendMessage(
      `The runtime model override is already ${formatCodexModelForDisplay(nextValue)}. Send /new if you want a fresh thread under that model.`,
      msgId,
    );
    return;
  }

  config.CODEX_MODEL_OVERRIDE = nextValue;
  await persistState();
  await sendMessage(
    `Set the runtime model override to ${formatCodexModelForDisplay(nextValue)}. Future Codex runs, including resumed sessions, will use it. Send /new if you want a fresh thread under the new model.`,
    msgId,
  );
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
  const modelCommand = parseModelCommand(text);

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
  if (modelCommand) {
    await handleModelCommand(modelCommand.rawArgument, msgId);
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

  await ensureThreadMatchesCapabilities(msgId);

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
    if (result.threadId) {
      threadCapabilityFingerprint = capabilityState.fingerprint || threadCapabilityFingerprint;
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
  config.DEFAULT_CODEX_MODEL = String(config.CODEX_MODEL || '').trim();
  config.CODEX_MODEL_OVERRIDE = '';
  ensureTelegramConfig(config);
  await ensureDir(path.dirname(config.STATE_FILE));
  await ensureDir(path.dirname(config.SESSION_FILE));
  await ensureDir(config.DOWNLOAD_DIR);
  await refreshCapabilityState();
  log('Telegram Codex bridge starting...');
  const stateInfo = await loadState();
  try {
    await sendMessage('Codex bridge online. Send a prompt or file to start.', undefined);
    if (stateInfo.needsFreshSession) {
      await sendMessage(
        capabilityState.telegramFileMcpAvailable
          ? 'Bridge capabilities changed. Saved Codex session was reset so refreshed MCP tools, including telegram-file, are available on the next message.'
          : 'Bridge capabilities changed. Saved Codex session was reset so refreshed MCP tools are available on the next message.',
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
