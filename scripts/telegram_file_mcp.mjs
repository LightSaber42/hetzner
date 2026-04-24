#!/usr/bin/env node

// The Telegram bridge wrapper injects this MCP with `-c mcp_servers.telegram-file...`
// for bridge and resume sessions. `codex mcp add` is only needed if you want
// standalone Codex sessions outside that wrapper to use the same tool.
// Existing Codex sessions do not hot-load newly added MCP servers; start or
// resume a fresh Codex process after changing global registration.

import process from 'node:process';
import { readJsonLinesReverse, sendTelegramDocument, loadBridgeConfig, ensureTelegramConfig, describeError } from './telegram_bridge_support.mjs';

const SERVER_INFO = {
  name: 'telegram-file',
  version: '0.1.0',
};

const TOOLS = [
  {
    name: 'telegram_send_file',
    description: 'Attach a local file from this machine to the configured Telegram Codex chat.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute local filesystem path to the file to send.',
        },
        caption: {
          type: 'string',
          description: 'Optional Telegram caption for the attachment.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_list_received_files',
    description: 'List recently received Telegram files that the bridge saved into the shared local inbox.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Maximum number of files to return. Defaults to 10.',
        },
      },
      additionalProperties: false,
    },
  },
];

function writeMessage(message) {
  const json = JSON.stringify(message);
  const payload = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
  process.stdout.write(payload);
}

function sendResult(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  writeMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  });
}

async function handleRequest(request, config) {
  if (request.method === 'initialize') {
    sendResult(request.id, {
      protocolVersion: request.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }

  if (request.method === 'notifications/initialized') {
    return;
  }

  if (request.method === 'tools/list') {
    sendResult(request.id, { tools: TOOLS });
    return;
  }

  if (request.method === 'tools/call') {
    const toolName = request.params?.name;
    const args = request.params?.arguments || {};

    if (toolName === 'telegram_send_file') {
      ensureTelegramConfig(config);
      const result = await sendTelegramDocument(config, args.path, {
        caption: String(args.caption || ''),
      });
      sendResult(request.id, {
        content: [
          {
            type: 'text',
            text: `Sent ${args.path} to chat ${config.CHAT_ID}. telegram_message_id=${result?.message_id || 'unknown'}`,
          },
        ],
      });
      return;
    }

    if (toolName === 'telegram_list_received_files') {
      const limit = Math.min(50, Math.max(1, Number(args.limit || 10)));
      const entries = await readJsonLinesReverse(config.DOWNLOAD_INDEX_FILE, limit);
      sendResult(request.id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(entries, null, 2),
          },
        ],
      });
      return;
    }

    sendError(request.id, -32601, `Unknown tool: ${toolName}`);
    return;
  }

  sendError(request.id, -32601, `Unknown method: ${request.method}`);
}

function parseFrames(buffer) {
  const frames = [];
  let remainder = buffer;

  while (true) {
    const headerMarker = Buffer.from('\r\n\r\n');
    const headerEnd = remainder.indexOf(headerMarker);
    if (headerEnd === -1) {
      break;
    }

    const headerBlock = remainder.slice(0, headerEnd).toString('utf8');
    const headers = headerBlock.split('\r\n');
    let contentLength = null;
    for (const header of headers) {
      const separator = header.indexOf(':');
      if (separator === -1) {
        continue;
      }
      const key = header.slice(0, separator).trim().toLowerCase();
      const value = header.slice(separator + 1).trim();
      if (key === 'content-length') {
        contentLength = Number(value);
      }
    }

    if (!Number.isFinite(contentLength) || contentLength < 0) {
      throw new Error('Invalid Content-Length header.');
    }

    const payloadStart = headerEnd + 4;
    const payloadEnd = payloadStart + contentLength;
    if (remainder.length < payloadEnd) {
      break;
    }

    frames.push(remainder.slice(payloadStart, payloadEnd).toString('utf8'));
    remainder = remainder.slice(payloadEnd);
  }

  return { frames, remainder };
}

async function main() {
  const config = await loadBridgeConfig();
  let buffer = Buffer.alloc(0);

  process.stdin.on('data', async (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let parsed;
    try {
      parsed = parseFrames(buffer);
    } catch (error) {
      sendError(null, -32700, describeError(error));
      buffer = Buffer.alloc(0);
      return;
    }

    buffer = parsed.remainder;
    for (const frame of parsed.frames) {
      let request;
      try {
        request = JSON.parse(frame);
      } catch (error) {
        sendError(null, -32700, describeError(error));
        continue;
      }

      try {
        await handleRequest(request, config);
      } catch (error) {
        sendError(request.id ?? null, -32000, describeError(error));
      }
    }
  });
}

main().catch((error) => {
  process.stderr.write(`${describeError(error)}\n`);
  process.exit(1);
});
