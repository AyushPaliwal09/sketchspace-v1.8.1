import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const MAX_MESSAGE = 18 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
const rooms = new Map();
const sockets = new Set();

function sendFrame(socket, payload, opcode = 1) {
  if (socket.destroyed || !socket.writable) return;
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2); header[0] = 0x80 | opcode; header[1] = body.length;
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  socket.write(Buffer.concat([header, body]));
}
function sendJSON(client, data) {
  try { sendFrame(client.socket, JSON.stringify(data)); }
  catch { /* connection may have closed while sending */ }
}
function sameRoomMembers(room) { return [...room.members.values()].map(member => ({ id: member.id, name: member.name, color: member.color })); }
function broadcastRoom(roomId, data, exceptSocket = null) {
  const room = rooms.get(roomId); if (!room) return;
  for (const member of room.members.values()) if (member.client?.socket !== exceptSocket) sendJSON(member.client, data);
}
function leaveRoom(client) {
  const roomId = client.roomId; if (!roomId) return;
  const room = rooms.get(roomId); client.roomId = '';
  if (!room) return;
  room.members.delete(client.id);
  broadcastRoom(roomId, { type: 'peer:leave', id: client.id });
  broadcastRoom(roomId, { type: 'room:members', members: sameRoomMembers(room) });
  if (room.members.size === 0) rooms.delete(roomId);
}
function safeRoomId(value) { return typeof value === 'string' ? value.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) : ''; }
function safeName(value) { return typeof value === 'string' ? value.trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 40) : ''; }
function cleanElements(value) {
  if (!Array.isArray(value)) return [];
  // Avoid accidentally allocating pathological scene arrays or untrusted non-JSON values.
  return value.slice(0, 5000);
}
function handleMessage(client, payload) {
  if (payload.length > MAX_MESSAGE) { sendJSON(client, { type: 'error', message: 'Message too large. Try reducing image size.' }); return; }
  let msg;
  try { msg = JSON.parse(payload.toString('utf8')); } catch { sendJSON(client, { type: 'error', message: 'Invalid message format.' }); return; }
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'join') {
    const roomId = safeRoomId(msg.roomId); const name = safeName(msg.name);
    if (!roomId || !name) { sendJSON(client, { type: 'error', message: 'A valid room ID and display name are required.' }); return; }
    if (client.roomId) leaveRoom(client);
    let room = rooms.get(roomId); const isNew = !room;
    if (!room && rooms.size >= 500) { sendJSON(client, { type: 'error', message: 'The server is at its room capacity. Please try again shortly.' }); return; }
    if (!room) {
      room = { id: roomId, elements: cleanElements(msg.elements), members: new Map(), createdAt: Date.now(), updatedAt: Date.now() };
      rooms.set(roomId, room);
    }
    if (room.members.size >= 50) { sendJSON(client, { type: 'error', message: 'This room has reached its 50 participant limit.' }); return; }
    const member = { id: client.id, name, color: colorFor(client.id), client };
    room.members.set(client.id, member); room.updatedAt = Date.now(); client.roomId = roomId; client.name = name; client.color = member.color;
    sendJSON(client, { type: 'room:state', roomId, isNew, elements: room.elements, members: sameRoomMembers(room) });
    broadcastRoom(roomId, { type: 'room:members', members: sameRoomMembers(room) });
    broadcastRoom(roomId, { type: 'room:notice', message: `${name} joined` }, client.socket);
    return;
  }

  const roomId = client.roomId; if (!roomId) return;
  const room = rooms.get(roomId); if (!room) return;
  if (msg.type === 'scene') {
    if (!Array.isArray(msg.elements)) return;
    const elements = cleanElements(msg.elements);
    // Shared room state exists only in process memory. Personal notes are never written here.
    room.elements = elements; room.updatedAt = Date.now();
    broadcastRoom(roomId, { type: 'scene', elements, from: client.id }, client.socket);
  } else if (msg.type === 'cursor') {
    const point = msg.point;
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    broadcastRoom(roomId, { type: 'cursor', id: client.id, name: client.name || 'Collaborator', color: client.color || '#b79bff', point: { x: point.x, y: point.y } }, client.socket);
  } else if (msg.type === 'ping') {
    sendJSON(client, { type: 'pong', at: Date.now() });
  }
}
function colorFor(id) {
  const colors = ['#b79bff', '#5ee0b5', '#f3c77b', '#83b8ff', '#ff8fa3', '#fb923c'];
  let hash = 0; for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0; return colors[hash % colors.length];
}
function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const origin = req.headers.origin;
  let originAllowed = true;
  if (origin) {
    try { originAllowed = new URL(origin).host === req.headers.host || origin === process.env.ALLOWED_ORIGIN; }
    catch { originAllowed = false; }
  }
  if (sockets.size >= 1000) { socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  if (!originAllowed) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13' || req.url?.split('?')[0] !== '/ws') { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '\r\n'].join('\r\n'));
  const client = { id: crypto.randomUUID(), socket, roomId: '', name: '', color: '', buffer: Buffer.alloc(0), fragments: [], fragmentBytes: 0, fragmentOpcode: 0 };
  sockets.add(client); socket.setNoDelay(true);
  socket.on('data', chunk => parseFrames(client, chunk));
  socket.on('error', () => cleanup(client));
  socket.on('close', () => cleanup(client));
  socket.on('end', () => cleanup(client));
}
function parseFrames(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  while (client.buffer.length >= 2) {
    const b0 = client.buffer[0], b1 = client.buffer[1];
    const fin = Boolean(b0 & 0x80), opcode = b0 & 0x0f, masked = Boolean(b1 & 0x80);
    let length = b1 & 0x7f, offset = 2;
    if (length === 126) { if (client.buffer.length < 4) return; length = client.buffer.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (client.buffer.length < 10) return; const wide = client.buffer.readBigUInt64BE(2); if (wide > BigInt(MAX_MESSAGE)) { client.socket.destroy(); return; } length = Number(wide); offset = 10; }
    // Browser-to-server WebSocket frames must be masked (RFC 6455).
    if (!masked) { sendFrame(client.socket, Buffer.from([0x03, 0xea]), 8); client.socket.destroy(); return; }
    let mask;
    if (client.buffer.length < offset + 4) return; mask = client.buffer.subarray(offset, offset + 4); offset += 4;
    if (length > MAX_MESSAGE) { sendFrame(client.socket, Buffer.from('Message too large'), 8); client.socket.destroy(); return; }
    if (client.buffer.length < offset + length) return;
    let data = Buffer.from(client.buffer.subarray(offset, offset + length));
    client.buffer = client.buffer.subarray(offset + length);
    if (masked && mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    if (opcode === 8) { try { sendFrame(client.socket, Buffer.alloc(0), 8); } catch {} client.socket.end(); cleanup(client); return; }
    if (opcode === 9) { sendFrame(client.socket, data, 10); continue; }
    if (opcode === 10) continue;
    if (opcode === 0) {
      if (!client.fragmentOpcode) { client.socket.destroy(); cleanup(client); return; }
      client.fragments.push(data); client.fragmentBytes += data.length;
      if (client.fragmentBytes > MAX_MESSAGE) { client.socket.destroy(); cleanup(client); return; }
      if (fin) { const complete = Buffer.concat(client.fragments, client.fragmentBytes); client.fragments = []; client.fragmentBytes = 0; const originalOpcode = client.fragmentOpcode; client.fragmentOpcode = 0; if (originalOpcode === 1) handleMessage(client, complete); }
      continue;
    }
    if (opcode === 1 && !fin) { client.fragmentOpcode = opcode; client.fragments = [data]; client.fragmentBytes = data.length; continue; }
    if (opcode === 1) handleMessage(client, data);
  }
}
function cleanup(client) {
  if (!sockets.has(client)) return;
  sockets.delete(client); leaveRoom(client);
}
function serveStatic(req, res) {
  let rawPath;
  try { rawPath = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bad request'); return; }
  if (rawPath === '/health' || rawPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    // Intentionally do not expose active room IDs from this public health endpoint.
    res.end(JSON.stringify({ ok: true, service: 'SketchSpace', collaboration: 'in-memory-websocket', activeRooms: rooms.size, activeConnections: sockets.size })); return;
  }
  let pathname = rawPath === '/' ? '/index.html' : rawPath;
  const full = path.resolve(PUBLIC, `.${pathname}`);
  if (!full.startsWith(`${PUBLIC}${path.sep}`) && full !== path.join(PUBLIC, 'index.html')) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(full, (error, stat) => {
    let target = full;
    if (error || !stat.isFile()) {
      if (!path.extname(pathname)) target = path.join(PUBLIC, 'index.html');
      else { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
    }
    fs.readFile(target, (readError, data) => {
      if (readError) { res.writeHead(500); res.end('Server error'); return; }
      const ext = path.extname(target).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self'; connect-src 'self' ws: wss:; font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
}
const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end('Method not allowed'); return; }
  serveStatic(req, res);
});
server.on('upgrade', (req, socket) => acceptWebSocket(req, socket));
server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
server.listen(PORT, '0.0.0.0', () => console.log(`SketchSpace running on http://localhost:${PORT}`));

function shutdown() {
  for (const client of sockets) { try { sendFrame(client.socket, Buffer.alloc(0), 8); client.socket.end(); } catch {} }
  server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
