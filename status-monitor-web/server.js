'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = Number(process.env.TICKETING_WEB_PORT || 8080);
const DASHBOARD_DIR = path.resolve(__dirname, '..', 'dashboard');
const DATA_DIR = path.resolve(process.env.TICKETING_DATA_DIR || '/data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const TICKETS_FILE = path.join(DATA_DIR, 'tickets.json');
const SESSION_TTL_MS = Math.max(300000, Number(process.env.TICKETING_SESSION_TTL_MS) || 12 * 60 * 60 * 1000);
const COOKIE_SECURE = process.env.TICKETING_COOKIE_SECURE === '1';
const DEFAULT_ADMIN_USERNAME = String(process.env.TICKETING_ADMIN_USERNAME || 'admin').trim() || 'admin';
const DEFAULT_ADMIN_PASSWORD = String(process.env.TICKETING_ADMIN_PASSWORD || 'admin1');
const sessions = new Map();
const eventClients = new Set();

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1024 * 1024) throw new Error('Request body is too large');
  }
  if (!raw.trim()) return {};
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON body must be an object');
  return value;
}

function safeId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function readFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeFile(file, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString('hex') };
}

function verifyPassword(password, user) {
  if (!user?.salt || !user?.hash) return false;
  const actual = Buffer.from(hashPassword(password, user.salt).hash, 'hex');
  const expected = Buffer.from(user.hash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function seedUsers() {
  const parsed = readFile(USERS_FILE, { users: [] });
  const store = parsed && Array.isArray(parsed.users) ? parsed : { users: [] };
  if (!store.users.length) {
    store.users.push({
      username: DEFAULT_ADMIN_USERNAME,
      isAdmin: true,
      permissions: { canManageUsers: true },
      visibleCompanies: null,
      mustChangePassword: DEFAULT_ADMIN_PASSWORD === 'admin1',
      ...hashPassword(DEFAULT_ADMIN_PASSWORD),
    });
    writeFile(USERS_FILE, store);
  }
  return store;
}

function rawUser(username) {
  const key = String(username || '').trim().toLowerCase();
  return seedUsers().users.find((user) => user.username.toLowerCase() === key) || null;
}

function canManageUser(user) {
  return !!(user?.isAdmin || user?.permissions?.canManageUsers);
}

function publicUser(user) {
  if (!user) return null;
  return {
    username: user.username,
    isAdmin: !!user.isAdmin,
    permissions: { canManageUsers: canManageUser(user) },
    visibleCompanies: canManageUser(user) ? null : (Array.isArray(user.visibleCompanies) ? user.visibleCompanies : []),
    mustChangePassword: !!user.mustChangePassword,
  };
}

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function sessionFor(req) {
  const token = cookies(req).ticketing_session;
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  const user = rawUser(session.username);
  if (!user) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { token, ...session, user };
}

function sessionCookie(token, maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000)) {
  return `ticketing_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${COOKIE_SECURE ? '; Secure' : ''}`;
}

function createSession(username) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function requireSession(req, res) {
  const session = sessionFor(req);
  if (!session) json(res, 401, { ok: false, error: 'Sign in to manage tickets' });
  return session;
}

function listTickets() {
  const parsed = readFile(TICKETS_FILE, []);
  const tickets = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.tickets) ? parsed.tickets : []);
  return tickets.filter((ticket) => ticket?.id).sort((left, right) => {
    const stateRank = Number(left.state === 'resolved') - Number(right.state === 'resolved');
    return stateRank || Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
  });
}

function saveTickets(tickets) {
  writeFile(TICKETS_FILE, tickets);
}

function ticketsPayload() {
  return { ok: true, tickets: listTickets(), connectionState: 'live' };
}

function emitTickets() {
  const data = JSON.stringify(ticketsPayload());
  for (const response of eventClients) response.write(`event: tickets\ndata: ${data}\n\n`);
}

function createTicket(fields, actor) {
  const now = new Date();
  const nowIso = now.toISOString();
  const ticket = {
    id: safeId(`manual_${Date.now()}_${crypto.randomInt(1000000)}`),
    episodeKey: null,
    companyId: null,
    companyLabel: String(fields.companyLabel || '(manual)'),
    host: String(fields.host || ''),
    severity: fields.severity || 'red',
    state: 'open',
    createdAt: nowIso,
    assignee: null,
    assignedBy: null,
    claimedBy: null,
    recoveredAt: null,
    resolvedAt: null,
    resolvedBy: null,
    updatedAt: now.getTime(),
    version: 1,
    history: [{ at: nowIso, by: actor, action: 'created', detail: 'Created manually' }],
  };
  const tickets = listTickets();
  tickets.unshift(ticket);
  saveTickets(tickets);
  emitTickets();
  return ticket;
}

function mutateTicket(id, actor, action, mutator) {
  const tickets = listTickets();
  const index = tickets.findIndex((ticket) => ticket.id === safeId(id));
  if (index < 0) return { ok: false, status: 404, error: 'No such ticket' };
  const current = tickets[index];
  const next = { ...current, history: [...(current.history || [])] };
  const nowIso = new Date().toISOString();
  const detail = mutator(next, nowIso);
  if (detail?.error) return { ok: false, status: 400, error: detail.error };
  next.history.push({ at: nowIso, by: actor, action, detail: typeof detail === 'string' ? detail : '' });
  next.updatedAt = Date.now();
  next.version = Number(current.version || 0) + 1;
  tickets[index] = next;
  saveTickets(tickets);
  emitTickets();
  return { ok: true, ticket: next };
}

function ticketAction(id, action, body, session) {
  const actor = session.username;
  if (action === 'claim') return mutateTicket(id, actor, 'claimed', (ticket) => {
    if (ticket.state === 'resolved') return { error: 'Ticket is already resolved' };
    ticket.claimedBy = actor;
    if (ticket.state === 'open') ticket.state = 'claimed';
    return `Claimed by ${actor}`;
  });
  if (action === 'unclaim') return mutateTicket(id, actor, 'unclaimed', (ticket) => {
    if (ticket.state === 'resolved') return { error: 'Ticket is already resolved' };
    ticket.claimedBy = null;
    ticket.state = ticket.assignee ? 'assigned' : 'open';
    return `Released by ${actor}`;
  });
  if (action === 'assign') {
    if (!canManageUser(session.user)) return { ok: false, status: 403, error: 'Only an admin can delegate tickets' };
    const assignee = String(body.assignee || '').trim();
    if (!assignee) return { ok: false, status: 400, error: 'An assignee is required' };
    return mutateTicket(id, actor, 'assigned', (ticket) => {
      if (ticket.state === 'resolved') return { error: 'Ticket is already resolved' };
      ticket.assignee = assignee;
      ticket.assignedBy = actor;
      ticket.state = 'assigned';
      return `Assigned to ${assignee} by ${actor}`;
    });
  }
  if (action === 'resolve') return mutateTicket(id, actor, 'resolved', (ticket, nowIso) => {
    if (ticket.state === 'resolved') return { error: 'Ticket is already resolved' };
    ticket.resolvedBy = actor;
    ticket.resolvedAt = nowIso;
    ticket.state = 'resolved';
    return `Resolved by ${actor}`;
  });
  if (action === 'reopen') return mutateTicket(id, actor, 'reopened', (ticket) => {
    if (ticket.state !== 'resolved') return { error: 'Ticket is not resolved' };
    ticket.resolvedBy = null;
    ticket.resolvedAt = null;
    ticket.state = ticket.assignee ? 'assigned' : (ticket.claimedBy ? 'claimed' : 'open');
    return `Reopened by ${actor}`;
  });
  if (action === 'comment') {
    const text = String(body.text || '').trim();
    if (!text) return { ok: false, status: 400, error: 'Comment text is required' };
    return mutateTicket(id, actor, 'comment', () => text);
  }
  if (action === 'update') return mutateTicket(id, actor, 'edited', (ticket) => {
    const fields = body.fields && typeof body.fields === 'object' ? body.fields : {};
    const editable = ['title', 'description', 'priority', 'assignee'];
    const changed = [];
    for (const key of editable) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
      const value = fields[key] == null || fields[key] === '' ? null : String(fields[key]);
      if ((ticket[key] ?? null) !== value) {
        ticket[key] = value;
        changed.push(key);
      }
    }
    if (!changed.length) return { error: 'No changes' };
    if (changed.includes('assignee') && ticket.assignee && ticket.state === 'open') ticket.state = 'assigned';
    return `Edited ${changed.join(', ')}`;
  });
  return { ok: false, status: 404, error: 'Unknown ticket action' };
}

async function authRoute(req, res, url) {
  const action = url.pathname.slice('/api/auth/'.length);
  const body = ['POST', 'PATCH'].includes(req.method) ? await readJson(req) : {};
  if (action === 'session' && req.method === 'GET') {
    return json(res, 200, { user: publicUser(sessionFor(req)?.user) });
  }
  if (action === 'login' && req.method === 'POST') {
    const user = rawUser(body.username);
    if (!user || !verifyPassword(body.password, user)) {
      return json(res, 401, { ok: false, error: 'Incorrect username or password' });
    }
    const token = createSession(user.username);
    return json(res, 200, { ok: true, user: publicUser(user) }, { 'set-cookie': sessionCookie(token) });
  }
  if (action === 'register' && req.method === 'POST') {
    const username = String(body.username || '').trim();
    if (!username || !body.password) return json(res, 400, { ok: false, error: 'Username and password are required' });
    const store = seedUsers();
    if (store.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
      return json(res, 409, { ok: false, error: 'That username is already taken' });
    }
    const user = {
      username,
      isAdmin: false,
      permissions: { canManageUsers: false },
      visibleCompanies: [],
      mustChangePassword: false,
      ...hashPassword(body.password),
    };
    store.users.push(user);
    writeFile(USERS_FILE, store);
    const token = createSession(username);
    return json(res, 201, { ok: true, user: publicUser(user) }, { 'set-cookie': sessionCookie(token) });
  }
  if (action === 'logout' && req.method === 'POST') {
    const session = sessionFor(req);
    if (session) sessions.delete(session.token);
    return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });
  }
  const session = requireSession(req, res);
  if (!session) return;
  if (action === 'set-password' && req.method === 'POST') {
    if (!body.password) return json(res, 400, { ok: false, error: 'Password is required' });
    const store = seedUsers();
    const user = store.users.find((item) => item.username.toLowerCase() === session.username.toLowerCase());
    Object.assign(user, hashPassword(body.password));
    user.mustChangePassword = false;
    writeFile(USERS_FILE, store);
    return json(res, 200, { ok: true, user: publicUser(user) });
  }
  if (!canManageUser(session.user)) return json(res, 403, { ok: false, error: 'Not allowed' });
  if (action === 'users' && req.method === 'GET') {
    return json(res, 200, { ok: true, users: seedUsers().users.map(publicUser) });
  }
  if (action === 'users' && req.method === 'POST') {
    const username = String(body.username || '').trim();
    if (!username || !body.password) return json(res, 400, { ok: false, error: 'Username and password are required' });
    const store = seedUsers();
    if (store.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
      return json(res, 409, { ok: false, error: 'That username is already taken' });
    }
    store.users.push({
      username,
      isAdmin: false,
      permissions: { canManageUsers: !!body.canManageUsers },
      visibleCompanies: Array.isArray(body.visibleCompanies) ? body.visibleCompanies : [],
      mustChangePassword: true,
      ...hashPassword(body.password),
    });
    writeFile(USERS_FILE, store);
    return json(res, 201, { ok: true });
  }
  const userMatch = action.match(/^users\/([^/]+)$/);
  if (userMatch && req.method === 'PATCH') {
    const username = decodeURIComponent(userMatch[1]);
    const store = seedUsers();
    const user = store.users.find((item) => item.username.toLowerCase() === username.toLowerCase());
    if (!user) return json(res, 404, { ok: false, error: 'No such account' });
    if (!user.isAdmin && body.canManageUsers !== undefined) user.permissions = { canManageUsers: !!body.canManageUsers };
    if (!user.isAdmin && Array.isArray(body.visibleCompanies)) user.visibleCompanies = body.visibleCompanies;
    if (body.password) Object.assign(user, hashPassword(body.password));
    writeFile(USERS_FILE, store);
    return json(res, 200, { ok: true });
  }
  if (userMatch && req.method === 'DELETE') {
    const username = decodeURIComponent(userMatch[1]);
    if (username.toLowerCase() === DEFAULT_ADMIN_USERNAME.toLowerCase()) {
      return json(res, 400, { ok: false, error: 'The admin account cannot be deleted' });
    }
    const store = seedUsers();
    const originalLength = store.users.length;
    store.users = store.users.filter((item) => item.username.toLowerCase() !== username.toLowerCase());
    if (store.users.length === originalLength) return json(res, 404, { ok: false, error: 'No such account' });
    writeFile(USERS_FILE, store);
    for (const [token, item] of sessions) {
      if (item.username.toLowerCase() === username.toLowerCase()) sessions.delete(token);
    }
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { ok: false, error: 'Not found' });
}

async function ticketRoute(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 2 && req.method === 'GET') return json(res, 200, ticketsPayload());
  if (parts.length === 2 && req.method === 'POST') {
    const session = requireSession(req, res);
    if (!session) return;
    const ticket = createTicket(await readJson(req), session.username);
    return json(res, 201, { ok: true, ticket });
  }
  const id = parts[2] ? safeId(decodeURIComponent(parts[2])) : '';
  if (!id) return json(res, 404, { ok: false, error: 'Not found' });
  const session = requireSession(req, res);
  if (!session) return;
  if (parts.length === 4 && req.method === 'POST') {
    const result = ticketAction(id, parts[3], await readJson(req), session);
    return json(res, result.status || (result.ok ? 200 : 400), result);
  }
  if (parts.length === 3 && req.method === 'DELETE') {
    const tickets = listTickets();
    const next = tickets.filter((ticket) => ticket.id !== id);
    if (next.length === tickets.length) return json(res, 404, { ok: false, error: 'No such ticket' });
    saveTickets(next);
    emitTickets();
    return json(res, 200, { ok: true });
  }
  return json(res, 405, { ok: false, error: 'Method not allowed' });
}

function eventStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`event: tickets\ndata: ${JSON.stringify(ticketsPayload())}\n\n`);
  eventClients.add(res);
  req.on('close', () => eventClients.delete(res));
}

function serveStatic(req, res, url) {
  const rawPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const filePath = path.resolve(DASHBOARD_DIR, `.${rawPath}`);
  if (filePath !== DASHBOARD_DIR && !filePath.startsWith(`${DASHBOARD_DIR}${path.sep}`)) {
    return json(res, 403, { ok: false, error: 'Forbidden' });
  }
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) return json(res, 404, { ok: false, error: 'Not found' });
    res.writeHead(200, {
      'content-type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': filePath.endsWith('index.html') || filePath.endsWith('web-bridge.js')
        ? 'no-cache'
        : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  (async () => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/healthz') {
      return json(res, 200, { ok: true, status: 'live', tickets: listTickets().length, eventClients: eventClients.size });
    }
    if (url.pathname === '/api/events' && req.method === 'GET') return eventStream(req, res);
    if (url.pathname.startsWith('/api/auth/')) return authRoute(req, res, url);
    if (url.pathname === '/api/tickets' || url.pathname.startsWith('/api/tickets/')) return ticketRoute(req, res, url);
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { ok: false, error: 'Method not allowed' });
    return serveStatic(req, res, url);
  })().catch((error) => {
    console.error('[ticketing-web]', error);
    if (!res.headersSent) json(res, 500, { ok: false, error: 'Internal server error' });
    else res.destroy();
  });
});

const heartbeat = setInterval(() => {
  for (const response of eventClients) response.write(': heartbeat\n\n');
}, 25000);
heartbeat.unref();

seedUsers();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Ticketing web dashboard listening on http://0.0.0.0:${PORT}`);
});

