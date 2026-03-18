#!/usr/bin/env node

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.WHATSAPP_GATEWAY_PORT || '3009', 10);
const OPENFANG_URL = (process.env.OPENFANG_URL || 'http://127.0.0.1:4200').replace(/\/+$/, '');
const DEFAULT_AGENT = process.env.OPENFANG_DEFAULT_AGENT || 'ambrogio';
const AGENT_UUID_CACHE = new Map();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let sock = null;
let sessionId = '';
let qrDataUrl = '';
let connStatus = 'disconnected';
let qrExpired = false;
let statusMessage = 'Not started';
let reconnectAttempt = 0;
let reconnectTimer = null;
let connectedSince = null;
let flushInterval = null;
let evProcessUnsub = null;
const MAX_RECONNECT_DELAY = 60_000;
const pendingReplies = new Map();

// ---------------------------------------------------------------------------
// Message deduplication — prevents processing the same message multiple times
// (e.g. after Signal session re-establishment / decryption retry)
// ---------------------------------------------------------------------------
const PROCESSED_IDS_PATH = path.join(__dirname, '.processed_ids.json');
const DEDUP_MAX_SIZE = 500;
let processedIds = new Set();
try {
  const raw = fs.readFileSync(PROCESSED_IDS_PATH, 'utf8');
  const arr = JSON.parse(raw);
  if (Array.isArray(arr)) processedIds = new Set(arr.slice(-DEDUP_MAX_SIZE));
} catch (_) {}

function markProcessed(msgId) {
  processedIds.add(msgId);
  // Trim to max size
  if (processedIds.size > DEDUP_MAX_SIZE) {
    const arr = [...processedIds];
    processedIds = new Set(arr.slice(-Math.floor(DEDUP_MAX_SIZE * 0.8)));
  }
  // Persist async (non-blocking)
  fs.writeFile(PROCESSED_IDS_PATH, JSON.stringify([...processedIds]), () => {});
}

// ---------------------------------------------------------------------------
// Media download & serving — allows forwarding WhatsApp images to OpenFang
// ---------------------------------------------------------------------------
const MEDIA_DIR = path.join(__dirname, 'media_cache');
const MEDIA_MAX_AGE_MS = 30 * 60_000; // 30 minutes
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

// Periodic cleanup of expired media files
setInterval(() => {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(MEDIA_DIR)) {
      const fp = path.join(MEDIA_DIR, f);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > MEDIA_MAX_AGE_MS) {
        fs.unlinkSync(fp);
      }
    }
  } catch (_) {}
}, 5 * 60_000);

const MEDIA_TYPE_MAP = {
  imageMessage: { ext: 'jpg', label: 'Photo' },
  videoMessage: { ext: 'mp4', label: 'Video' },
  stickerMessage: { ext: 'webp', label: 'Sticker' },
  audioMessage: { ext: 'ogg', label: 'Audio' },
  documentMessage: { ext: null, label: 'Document' },
};

/**
 * Download media from a WhatsApp message, save to disk, return local URL.
 * Returns { url, label, caption } or null on failure.
 */
async function downloadMedia(msg) {
  const m = msg.message;
  if (!m) return null;

  for (const [key, info] of Object.entries(MEDIA_TYPE_MAP)) {
    const media = m[key];
    if (!media) continue;

    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      const ext = info.ext || (media.fileName?.split('.').pop()) || 'bin';
      const filename = `${msg.key.id || randomUUID()}.${ext}`;
      const filePath = path.join(MEDIA_DIR, filename);
      fs.writeFileSync(filePath, buffer);

      const caption = media.caption || null;
      const localUrl = `http://127.0.0.1:${PORT}/media/${filename}`;

      log('info', `Downloaded ${info.label} (${buffer.length} bytes) → ${filename}`);
      return { url: localUrl, label: info.label, caption };
    } catch (err) {
      log('error', `Media download failed (${key}): ${err.message}`);
      return null;
    }
  }
  return null;
}

// Per-sender message debounce: accumulates rapid messages and sends as one batch.
// Media messages are buffered IMMEDIATELY (before download) so the debounce timer
// starts on arrival, not after the slow media download finishes.
const DEBOUNCE_MS = 5_000; // 5 seconds of silence before flushing
const DEBOUNCE_MEDIA_MS = 15_000; // 15 seconds when batch contains media (image uploads are slow)
const senderBuffers = new Map(); // senderJid → { entries: [], timer, replyJid, isGroup, groupJid, wasMentioned, phone, pushName }

function debounceMessage(senderJid, msgData) {
  let buf = senderBuffers.get(senderJid);
  if (!buf) {
    buf = { entries: [], timer: null, replyJid: null, isGroup: false, groupJid: null, wasMentioned: false };
    senderBuffers.set(senderJid, buf);
  }

  // Each entry is either a resolved string or a Promise<string> (for pending media downloads)
  buf.entries.push(msgData.textOrPromise);
  buf.replyJid = msgData.replyJid;
  buf.isGroup = msgData.isGroup;
  buf.groupJid = msgData.groupJid;
  buf.phone = msgData.phone;
  buf.pushName = msgData.pushName;
  if (msgData.wasMentioned) buf.wasMentioned = true;

  // Reset the timer on each new message
  // Use longer debounce when batch contains media (WhatsApp uploads images one at a time with delays)
  const hasMedia = buf.entries.some(e => e && typeof e.then === 'function');
  const effectiveDebounce = hasMedia ? DEBOUNCE_MEDIA_MS : DEBOUNCE_MS;
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => flushSenderBuffer(senderJid), effectiveDebounce);

  log('info', `Debounce: buffered msg from ${msgData.pushName} (${buf.entries.length} in batch, flushing in ${effectiveDebounce}ms${hasMedia ? ' [media]' : ''})`);
}

async function flushSenderBuffer(senderJid) {
  const buf = senderBuffers.get(senderJid);
  if (!buf || buf.entries.length === 0) return;
  senderBuffers.delete(senderJid);

  // Resolve any pending media download promises
  const resolved = await Promise.all(buf.entries);
  // Filter out nulls (failed downloads with no text)
  const texts = resolved.filter(Boolean);
  if (texts.length === 0) return;

  const combinedText = texts.join('\n');
  const count = texts.length;
  log('info', `Debounce flush: ${count} message(s) from ${buf.pushName} → single OpenFang call`);

  try {
    await handleIncoming(combinedText, buf.phone, buf.pushName, buf.replyJid, buf.isGroup, buf.groupJid, buf.wasMentioned);
  } catch (err) {
    log('error', `Debounce flush failed for ${buf.pushName}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
const log = (level, msg) => {
  const ts = new Date().toISOString();
  console[level === 'error' ? 'error' : 'log'](`[gateway] [${ts}] ${msg}`);
};

// ---------------------------------------------------------------------------
// Markdown → WhatsApp formatting
// ---------------------------------------------------------------------------
function markdownToWhatsApp(text) {
  if (!text) return text;
  // Bold: **text** or __text__ → *text*
  text = text.replace(/\*\*(.+?)\*\*/g, '*$1*');
  text = text.replace(/__(.+?)__/g, '*$1*');
  // Italic: *text* (single) or _text_ → _text_ (WhatsApp italic)
  // Be careful not to convert already-bold markers
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_');
  // Strikethrough: ~~text~~ → ~text~
  text = text.replace(/~~(.+?)~~/g, '~$1~');
  // Code blocks: ```text``` → ```text```  (WhatsApp supports this natively)
  // Inline code: `text` → ```text``` (no inline code in WhatsApp)
  text = text.replace(/(?<!`)(`{1})(?!`)(.+?)(?<!`)\1(?!`)/g, '```$2```');
  return text;
}

// ---------------------------------------------------------------------------
// Cleanup socket
// ---------------------------------------------------------------------------
function cleanupSocket() {
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }
  if (evProcessUnsub) {
    try { evProcessUnsub(); } catch (_) {}
    evProcessUnsub = null;
  }
  if (sock) {
    try { sock.end(undefined); } catch (_) {}
    sock = null;
  }
  connectedSince = null;
}

// ---------------------------------------------------------------------------
// Schedule reconnect with exponential backoff
// ---------------------------------------------------------------------------
function scheduleReconnect(reason) {
  if (reconnectTimer) {
    log('info', `Reconnect already scheduled, skipping (${reason})`);
    return;
  }
  reconnectAttempt++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), MAX_RECONNECT_DELAY);
  log('info', `Scheduling reconnect #${reconnectAttempt} in ${delay}ms — reason: ${reason}`);
  statusMessage = `Reconnecting (attempt ${reconnectAttempt})...`;
  connStatus = 'disconnected';

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await startConnection();
    } catch (err) {
      log('error', `Reconnect failed: ${err.message}`);
      scheduleReconnect('reconnect-error');
    }
  }, delay);
}

// ---------------------------------------------------------------------------
// Baileys connection
// ---------------------------------------------------------------------------
async function startConnection() {
  cleanupSocket();

  const logger = pino({ level: 'info' });
  const authDir = path.join(__dirname, 'auth_store');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  sessionId = randomUUID();
  qrDataUrl = '';
  qrExpired = false;
  connStatus = 'disconnected';
  statusMessage = 'Connecting...';

  log('info', `Starting connection (Baileys v${version.join('.')})`);

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    keepAliveIntervalMs: 25_000,
    connectTimeoutMs: 20_000,
    retryRequestDelayMs: 250,
    markOnlineOnConnect: true,
    defaultQueryTimeoutMs: 60_000,
    emitOwnEvents: false,
    fireInitQueries: true,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
  });

  // ------------------------------------------------------------------
  // Use sock.ev.process() — the canonical Baileys v6 event API.
  // This receives consolidated event batches AFTER the internal
  // buffer is flushed, avoiding the "events stuck in buffer" problem.
  // ------------------------------------------------------------------
  evProcessUnsub = sock.ev.process(async (events) => {
    // Credentials update
    if (events['creds.update']) {
      await saveCreds();
    }

    // Connection state
    if (events['connection.update']) {
      await handleConnectionUpdate(events['connection.update']);
    }

    // Incoming messages
    if (events['messages.upsert']) {
      const { messages, type } = events['messages.upsert'];
      log('info', `messages.upsert event: ${messages.length} message(s), type=${type}`);

      if (type !== 'notify') {
        log('info', `Skipping non-notify batch (type=${type})`);
        return;
      }

      for (const msg of messages) {
        if (msg.key.fromMe) {
          log('info', `Skipping own message ${msg.key.id}`);
          continue;
        }
        if (msg.key.remoteJid === 'status@broadcast') continue;

        // --- Deduplication: skip already-processed messages ---
        const msgId = msg.key.id;
        if (processedIds.has(msgId)) {
          log('info', `Skipping duplicate message ${msgId}`);
          continue;
        }

        const remoteJid = msg.key.remoteJid || '';
        const isGroup = remoteJid.endsWith('@g.us');

        // In groups, the actual sender is in msg.key.participant;
        // in DMs, the sender is remoteJid itself.
        const sender = isGroup
          ? (msg.key.participant || remoteJid)
          : remoteJid;

        let text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          '';

        // Detect if this is a media message that needs async download
        let mediaPromise = null;
        const hasMediaKey = !text && Object.keys(MEDIA_TYPE_MAP).some(k => msg.message?.[k]);

        if (hasMediaKey) {
          // Start download in background — do NOT await here.
          // The promise resolves to a text string (or null on failure).
          mediaPromise = downloadMedia(msg).then(media => {
            if (!media) return null;
            return media.caption
              ? `[${media.label}: ${media.url}]\n${media.caption}`
              : `[${media.label}: ${media.url}]`;
          }).catch(err => {
            log('error', `Async media download failed: ${err.message}`);
            return null;
          });
        }

        // vCard / contact message support
        if (!text && !hasMediaKey && msg.message?.contactMessage) {
          const vc = msg.message.contactMessage;
          const vcardStr = vc.vcard || '';
          // Extract name from displayName or vCard FN field
          const contactName = vc.displayName || (vcardStr.match(/FN:(.*)/)?.[1]?.trim()) || 'Sconosciuto';
          // Extract phone numbers from TEL fields
          const phones = [...vcardStr.matchAll(/TEL[^:]*:([\d\s+\-().]+)/g)].map(m => m[1].trim());
          text = `[Contatto condiviso] ${contactName}` + (phones.length ? ` — ${phones.join(', ')}` : '');
          log('info', `vCard received from ${sender}: ${contactName}, phones: ${phones.join(', ')}`);
        }

        // Multi-contact message (contactsArrayMessage)
        if (!text && !hasMediaKey && msg.message?.contactsArrayMessage) {
          const contacts = msg.message.contactsArrayMessage.contacts || [];
          const entries = contacts.map(c => {
            const vcardStr = c.vcard || '';
            const name = c.displayName || (vcardStr.match(/FN:(.*)/)?.[1]?.trim()) || '?';
            const phones = [...vcardStr.matchAll(/TEL[^:]*:([\d\s+\-().]+)/g)].map(m => m[1].trim());
            return `${name}${phones.length ? ` (${phones.join(', ')})` : ''}`;
          });
          text = `[Contatti condivisi] ${entries.join('; ')}`;
          log('info', `Multi-vCard received from ${sender}: ${entries.length} contacts`);
        }

        if (!text && !mediaPromise) {
          log('info', `No text content in message from ${sender} (stub=${msg.messageStubType || 'none'})`);
          continue;
        }

        // Mark as processed BEFORE forwarding (prevents re-processing on decrypt retry)
        markProcessed(msgId);

        const phone = '+' + sender.replace(/@.*$/, '');
        const pushName = msg.pushName || phone;

        // Detect @mention of the bot in groups
        let wasMentioned = false;
        if (isGroup && sock?.user?.id) {
          const botJid = sock.user.id.replace(/:\d+@/, '@'); // normalize "123:45@s.whatsapp.net" → "123@s.whatsapp.net"
          const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
          wasMentioned = mentionedJids.includes(botJid) || mentionedJids.includes(sock.user.id);
          // Also check raw text for @phone patterns
          if (!wasMentioned) {
            const botPhone = botJid.replace(/@.*$/, '');
            wasMentioned = (text || '').includes(`@${botPhone}`);
          }
        }

        const groupLabel = isGroup ? ` [group:${remoteJid}]` : '';
        log('info', `Incoming from ${pushName} (${phone})${groupLabel}: ${(text || '[media downloading]').substring(0, 120)}`);

        // Read receipt (blue ticks)
        try {
          if (sock) await sock.readMessages([msg.key]);
        } catch (err) {
          log('error', `Read receipt failed: ${err.message}`);
        }

        // In groups, reply to the group; in DMs, reply to the individual.
        const replyJid = isGroup ? remoteJid : sender;

        // Debounce: accumulate rapid messages from same sender, flush after 5s of silence.
        // For media messages, pass the download promise so debounce starts NOW (not after download).
        const textOrPromise = mediaPromise || text;
        debounceMessage(sender, { textOrPromise, phone, pushName, replyJid, isGroup, groupJid: remoteJid, wasMentioned });
      }
    }
  });

  // ------------------------------------------------------------------
  // Safety net: periodic buffer flush every 3 seconds.
  // In theory processNodeWithBuffer already flushes, but if a code
  // path inside Baileys activates the buffer without flushing, this
  // ensures events don't get stuck forever.
  // ------------------------------------------------------------------
  flushInterval = setInterval(() => {
    try {
      if (sock?.ev?.flush) sock.ev.flush();
    } catch (_) {}
  }, 3_000);

  log('info', 'Event handlers registered via sock.ev.process()');
}

// ---------------------------------------------------------------------------
// Handle connection updates
// ---------------------------------------------------------------------------
async function handleConnectionUpdate(update) {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    try {
      qrDataUrl = await QRCode.toDataURL(qr, { width: 256, margin: 2 });
      connStatus = 'qr_ready';
      qrExpired = false;
      statusMessage = 'Scan QR with WhatsApp > Linked Devices';
      log('info', 'QR code ready');
    } catch (err) {
      log('error', `QR generation failed: ${err.message}`);
    }
  }

  if (connection === 'open') {
    connStatus = 'connected';
    qrExpired = false;
    qrDataUrl = '';
    reconnectAttempt = 0;
    connectedSince = Date.now();
    statusMessage = 'Connected to WhatsApp';
    log('info', 'Connected to WhatsApp!');

    // TCP keepalive — prevents silent network deaths in containers
    try {
      const rawSocket = sock?.ws?.socket?._socket;
      if (rawSocket && typeof rawSocket.setKeepAlive === 'function') {
        rawSocket.setKeepAlive(true, 10_000);
        log('info', 'TCP keepalive enabled');
      }
    } catch (_) {}

    flushPendingReplies();
  }

  if (connection === 'close') {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const reason = lastDisconnect?.error?.output?.payload?.message || 'unknown';
    const uptime = connectedSince ? Math.round((Date.now() - connectedSince) / 1000) : 0;
    log('info', `Closed after ${uptime}s — ${reason} (code: ${statusCode})`);

    if (statusCode === DisconnectReason.loggedOut) {
      connStatus = 'disconnected';
      statusMessage = 'Logged out. POST /login/start to reconnect.';
      qrDataUrl = '';
      cleanupSocket();
      reconnectAttempt = 0;
      const authPath = path.join(__dirname, 'auth_store');
      if (fs.existsSync(authPath)) {
        fs.rmSync(authPath, { recursive: true, force: true });
      }
      log('info', 'Auth cleared');
    } else if (statusCode === DisconnectReason.connectionReplaced) {
      log('info', 'Connection replaced — backing off');
      reconnectAttempt = Math.max(reconnectAttempt, 3);
      scheduleReconnect('connection-replaced');
    } else {
      scheduleReconnect(reason);
    }
  }
}

// ---------------------------------------------------------------------------
// Handle incoming → OpenFang → reply
// ---------------------------------------------------------------------------
async function handleIncoming(text, phone, pushName, replyJid, isGroup, groupJid, wasMentioned) {
  let response;
  try {
    response = await forwardToOpenFang(text, phone, pushName, isGroup, groupJid, wasMentioned);
  } catch (err) {
    log('error', `OpenFang error for ${pushName}: ${err.message}`);
    return;
  }
  if (!response) {
    log('info', `No response from OpenFang for ${pushName}`);
    return;
  }

  // Convert markdown formatting to WhatsApp-native formatting
  response = markdownToWhatsApp(response);

  if (sock && connStatus === 'connected') {
    try {
      await sock.sendMessage(replyJid, { text: response });
      const target = isGroup ? `group ${groupJid}` : pushName;
      log('info', `Replied to ${target} (${response.length} chars)`);
      return;
    } catch (err) {
      log('error', `Send failed for ${pushName}: ${err.message}`);
    }
  }

  log('info', `Buffering reply for ${pushName}`);
  pendingReplies.set(replyJid, { text: response, timestamp: Date.now() });
}

// ---------------------------------------------------------------------------
// Flush pending replies
// ---------------------------------------------------------------------------
async function flushPendingReplies() {
  if (pendingReplies.size === 0) return;
  const maxAge = 5 * 60_000;
  const now = Date.now();

  for (const [jid, { text, timestamp }] of pendingReplies) {
    pendingReplies.delete(jid);
    if (now - timestamp > maxAge) {
      log('info', `Discarding stale reply for ${jid}`);
      continue;
    }
    try {
      await sock.sendMessage(jid, { text });
      log('info', `Flushed reply to ${jid}`);
    } catch (err) {
      log('error', `Flush failed for ${jid}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Resolve agent name → UUID
// ---------------------------------------------------------------------------
async function resolveAgentUUID(nameOrUUID) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nameOrUUID)) {
    return nameOrUUID;
  }
  if (AGENT_UUID_CACHE.has(nameOrUUID)) {
    return AGENT_UUID_CACHE.get(nameOrUUID);
  }
  return new Promise((resolve, reject) => {
    http.get(`${OPENFANG_URL}/api/agents`, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const agents = JSON.parse(body);
          const agent = agents.find((a) => a.name === nameOrUUID);
          if (agent) {
            AGENT_UUID_CACHE.set(nameOrUUID, agent.id);
            resolve(agent.id);
          } else {
            reject(new Error(`Agent "${nameOrUUID}" not found`));
          }
        } catch (e) {
          reject(new Error(`Parse agents failed: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Forward to OpenFang
// ---------------------------------------------------------------------------
async function forwardToOpenFang(text, phone, pushName, isGroup, groupJid, wasMentioned) {
  const agentId = await resolveAgentUUID(DEFAULT_AGENT);
  return new Promise((resolve, reject) => {
    const body = {
      message: text,
      sender_id: phone,
      sender_name: pushName,
      channel_type: 'whatsapp',
    };
    if (isGroup) {
      body.is_group = true;
      body.group_id = groupJid;
      body.was_mentioned = wasMentioned;
    }
    const payload = JSON.stringify(body);
    const url = new URL(`${OPENFANG_URL}/api/agents/${agentId}/message`);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 4200,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 300_000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve(data.response || data.message || data.text || '');
          } catch {
            resolve(body.trim() || '');
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenFang timeout')); });
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Send outgoing message
// ---------------------------------------------------------------------------
async function sendMessage(to, text) {
  if (!sock || connStatus !== 'connected') throw new Error('WhatsApp not connected');
  const jid = to.replace(/^\+/, '').replace(/@.*$/, '') + '@s.whatsapp.net';
  await sock.sendMessage(jid, { text });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'POST' && pathname === '/login/start') {
      if (connStatus === 'connected') {
        return jsonResponse(res, 200, {
          qr_data_url: '', session_id: sessionId,
          message: 'Already connected', connected: true,
        });
      }
      await startConnection();
      let waited = 0;
      while (!qrDataUrl && connStatus !== 'connected' && waited < 15_000) {
        await new Promise((r) => setTimeout(r, 300));
        waited += 300;
      }
      return jsonResponse(res, 200, {
        qr_data_url: qrDataUrl, session_id: sessionId,
        message: statusMessage, connected: connStatus === 'connected',
      });
    }

    if (req.method === 'GET' && pathname === '/login/status') {
      return jsonResponse(res, 200, {
        connected: connStatus === 'connected',
        message: statusMessage,
        expired: qrExpired,
        uptime: connectedSince ? Math.round((Date.now() - connectedSince) / 1000) : 0,
      });
    }

    if (req.method === 'POST' && pathname === '/message/send') {
      const body = await parseBody(req);
      if (!body.to || !body.text) return jsonResponse(res, 400, { error: 'Missing "to" or "text"' });
      await sendMessage(body.to, body.text);
      return jsonResponse(res, 200, { success: true, message: 'Sent' });
    }

    // Serve cached media files
    if (req.method === 'GET' && pathname.startsWith('/media/')) {
      const filename = path.basename(pathname);
      const filePath = path.join(MEDIA_DIR, filename);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filename).slice(1);
        const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', ogg: 'audio/ogg', pdf: 'application/pdf' };
        const contentType = mimeMap[ext] || 'application/octet-stream';
        const data = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': data.length });
        return res.end(data);
      }
      return jsonResponse(res, 404, { error: 'Media not found' });
    }

    if (req.method === 'GET' && pathname === '/health') {
      return jsonResponse(res, 200, {
        status: 'ok',
        connected: connStatus === 'connected',
        session_id: sessionId || null,
        uptime: connectedSince ? Math.round((Date.now() - connectedSince) / 1000) : 0,
        pending_replies: pendingReplies.size,
      });
    }

    jsonResponse(res, 404, { error: 'Not found' });
  } catch (err) {
    log('error', `${req.method} ${pathname}: ${err.message}`);
    jsonResponse(res, 500, { error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, '127.0.0.1', () => {
  log('info', `Listening on http://127.0.0.1:${PORT}`);
  log('info', `OpenFang: ${OPENFANG_URL} | Agent: ${DEFAULT_AGENT}`);

  const credsPath = path.join(__dirname, 'auth_store', 'creds.json');
  if (fs.existsSync(credsPath)) {
    log('info', 'Credentials found — auto-connecting...');
    startConnection().catch((err) => {
      log('error', `Auto-connect failed: ${err.message}`);
      statusMessage = 'Auto-connect failed. POST /login/start to retry.';
    });
  } else {
    log('info', 'No credentials. POST /login/start for QR flow.');
  }
});

process.on('SIGINT', () => { log('info', 'SIGINT'); cleanupSocket(); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { log('info', 'SIGTERM'); cleanupSocket(); server.close(() => process.exit(0)); });
