// ─── Tickets backend (thin MQTT) ───────────────────────────────────────────────
//
// The ENTIRE cross-app contract is one retained MQTT topic tree: `tickets/<id>`.
// Each ticket is a retained JSON doc; an empty retained payload is a tombstone
// (delete). Because the messages are retained, the broker is the source of truth
// and a fresh launch replays every open ticket on subscribe — no local DB.
//
//   • The MONITOR is the only AUTOMATIC creator: on a sustained-outage (red)
//     rising edge it publishes one retained ticket (see the monitor's
//     maybeCreateTicket / detectTicketTransitions). It also records `recoveredAt`
//     on recovery WITHOUT closing the ticket.
//   • THIS app is the human side: list/claim/assign/resolve/reopen/comment, each
//     a read-modify-write that republishes the retained doc.
//
// Schema (must stay identical to the monitor's maybeCreateTicket):
//   { id, episodeKey, companyId, companyLabel, host,
//     severity, state, createdAt,
//     assignee, assignedBy, claimedBy,
//     recoveredAt, resolvedAt, resolvedBy,
//     updatedAt, version, history:[{at,by,action,detail}] }
//   state ∈ open | claimed | assigned | resolved   (severity is informational)
import mqtt from 'mqtt';

const TOPIC_PREFIX = 'tickets/';

let client = null;
let connState = 'grey';                 // grey (connecting) | live | black (error)
let onChange = () => {};                // called whenever the cache changes
let onConnection = () => {};            // called whenever connState changes
const cache = new Map();                // id -> retained ticket doc

function setConn(state) {
  if (state === connState) return;
  connState = state;
  try { onConnection(state); } catch { /* ignore */ }
}

function emitChange() {
  try { onChange(); } catch { /* ignore */ }
}

// id is used as the topic suffix, so it must be topic-safe. The monitor derives
// ids from the episode key via the same sanitiser; manual ids are pre-sanitised.
function safeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function publish(id, doc) {
  if (!client) return;
  // qos 1 + retain so the doc survives offline clients and is replayed on
  // subscribe; mqtt.js queues qos-1 publishes while briefly disconnected.
  try { client.publish(`${TOPIC_PREFIX}${safeId(id)}`, JSON.stringify(doc), { qos: 1, retain: true }); }
  catch { /* offline — the retained echo will reconcile later */ }
}

// ─── Connect / lifecycle ───────────────────────────────────────────────────────

export function initTickets({ host, port, onChange: changeCb, onConnection: connCb } = {}) {
  onChange = typeof changeCb === 'function' ? changeCb : onChange;
  onConnection = typeof connCb === 'function' ? connCb : onConnection;
  connectTickets({ host, port });
}

export function connectTickets({ host, port } = {}) {
  if (client) { try { client.end(true); } catch { /* ignore */ } client = null; }
  cache.clear();
  setConn('grey');

  const url = `mqtt://${host}:${port}`;
  console.log(`[TICKETS] Connecting to ${url}`);
  client = mqtt.connect(url, { clean: true, reconnectPeriod: 15_000 });

  client.on('connect', () => {
    console.log('[TICKETS] Connected — subscribing to tickets/#');
    // Fresh subscribe replays every retained ticket; rebuild the cache from it.
    cache.clear();
    client.subscribe(`${TOPIC_PREFIX}#`, { qos: 1 });
    setConn('live');
    emitChange();
  });

  client.on('message', (topic, message) => {
    if (!topic.startsWith(TOPIC_PREFIX)) return;
    const id = topic.slice(TOPIC_PREFIX.length);
    if (!message || message.length === 0) {
      // Tombstone: the retained record was cleared → ticket deleted.
      if (cache.delete(id)) emitChange();
      return;
    }
    try {
      cache.set(id, JSON.parse(message.toString()));
      emitChange();
    } catch { /* ignore malformed */ }
  });

  client.on('reconnect', () => setConn('grey'));
  client.on('offline', () => setConn('grey'));
  client.on('close', () => { if (connState === 'live') setConn('grey'); });
  client.on('error', (err) => {
    console.error('[TICKETS] MQTT error:', err && err.message);
    setConn('black');
  });
}

export function endTickets() {
  if (client) { try { client.end(true); } catch { /* ignore */ } client = null; }
}

export function ticketConnectionState() { return connState; }

// Newest first; resolved tickets sink below open ones.
export function ticketList() {
  const rank = (t) => (t.state === 'resolved' ? 1 : 0);
  return [...cache.values()].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

export function ticketGet(id) { return cache.get(safeId(id)) || null; }

// ─── Mutations ─────────────────────────────────────────────────────────────────
// Every mutation is a read-modify-write on the latest cached (retained) doc, so
// it preserves whatever the monitor most recently merged (e.g. recoveredAt) and
// never clobbers machine-owned fields. Returns { ok, ticket } or { ok:false, error }.

function mutate(id, actor, action, mutator) {
  const key = safeId(id);
  const cur = cache.get(key);
  if (!cur) return { ok: false, error: 'No such ticket' };
  const nowIso = new Date().toISOString();
  const next = { ...cur, history: [...(cur.history || [])] };
  const detail = mutator(next, nowIso);   // mutator may return an error string to abort
  if (typeof detail === 'object' && detail && detail.error) return { ok: false, error: detail.error };
  next.history.push({ at: nowIso, by: actor || 'unknown', action, detail: typeof detail === 'string' ? detail : '' });
  next.updatedAt = Date.now();
  next.version = (cur.version || 0) + 1;
  cache.set(key, next);
  publish(key, next);     // optimistic: local cache + retained publish
  emitChange();
  return { ok: true, ticket: next };
}

// Take ownership ("I'll handle this").
export function claimTicket(id, actor) {
  return mutate(id, actor, 'claimed', (t) => {
    if (t.state === 'resolved') return { error: 'Ticket is already resolved' };
    t.claimedBy = actor;
    if (t.state === 'open') t.state = 'claimed';
    return `Claimed by ${actor}`;
  });
}

// Release a claim.
export function unclaimTicket(id, actor) {
  return mutate(id, actor, 'unclaimed', (t) => {
    if (t.state === 'resolved') return { error: 'Ticket is already resolved' };
    t.claimedBy = null;
    t.state = t.assignee ? 'assigned' : 'open';
    return `Released by ${actor}`;
  });
}

// Delegate to someone else (admin action — gated in main.js).
export function assignTicket(id, assignee, actor) {
  const who = String(assignee || '').trim();
  if (!who) return { ok: false, error: 'An assignee is required' };
  return mutate(id, actor, 'assigned', (t) => {
    if (t.state === 'resolved') return { error: 'Ticket is already resolved' };
    t.assignee = who;
    t.assignedBy = actor;
    t.state = 'assigned';
    return `Assigned to ${who} by ${actor}`;
  });
}

// A human closes the ticket (recovery alone never closes it).
export function resolveTicket(id, actor) {
  return mutate(id, actor, 'resolved', (t, nowIso) => {
    if (t.state === 'resolved') return { error: 'Ticket is already resolved' };
    t.resolvedBy = actor;
    t.resolvedAt = nowIso;
    t.state = 'resolved';
    return `Resolved by ${actor}`;
  });
}

// Reopen a resolved ticket back into its working state.
export function reopenTicket(id, actor) {
  return mutate(id, actor, 'reopened', (t) => {
    if (t.state !== 'resolved') return { error: 'Ticket is not resolved' };
    t.resolvedBy = null;
    t.resolvedAt = null;
    t.state = t.assignee ? 'assigned' : (t.claimedBy ? 'claimed' : 'open');
    return `Reopened by ${actor}`;
  });
}

// Append a note without changing state.
export function commentTicket(id, text, actor) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: 'Comment text is required' };
  return mutate(id, actor, 'comment', () => body);
}

// ERPNext-style document editing: set the human-editable fields on the ticket.
// System fields (companyId/host/createdAt/recoveredAt) stay machine-owned.
const EDITABLE_TICKET_FIELDS = ['title', 'description', 'priority', 'assignee'];
export function updateTicket(id, fields = {}, actor) {
  return mutate(id, actor, 'edited', (t) => {
    const changed = [];
    for (const k of EDITABLE_TICKET_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(fields, k)) continue;
      const v = fields[k] == null || fields[k] === '' ? null : String(fields[k]);
      if ((t[k] ?? null) !== v) { t[k] = v; changed.push(k); }
    }
    if (!changed.length) return { error: 'No changes' };
    // Naming an assignee on a still-open ticket advances it to "assigned".
    if (changed.includes('assignee') && t.assignee && t.state === 'open') t.state = 'assigned';
    return `Edited ${changed.join(', ')}`;
  });
}

// Tombstone (delete) a ticket — clears its retained record on the broker.
export function deleteTicket(id) {
  const key = safeId(id);
  if (!cache.has(key)) return { ok: false, error: 'No such ticket' };
  cache.delete(key);
  if (client) { try { client.publish(`${TOPIC_PREFIX}${key}`, '', { qos: 1, retain: true }); } catch { /* ignore */ } }
  emitChange();
  return { ok: true };
}

// Manually raise a ticket (the monitor auto-creates outage tickets; this is for
// human-reported issues). Mirrors the monitor's doc shape exactly.
export function createTicket({ companyLabel, host, severity } = {}, actor) {
  const nowIso = new Date().toISOString();
  // Unique, topic-safe id. (Date.now() is fine in the main process.)
  const id = safeId(`manual_${Date.now()}_${Math.floor(Math.random() * 1e6)}`);
  const doc = {
    id, episodeKey: null,
    companyId: null, companyLabel: String(companyLabel || '(manual)'), host: String(host || ''),
    severity: severity || 'red', state: 'open', createdAt: nowIso,
    assignee: null, assignedBy: null, claimedBy: null,
    recoveredAt: null, resolvedAt: null, resolvedBy: null,
    updatedAt: Date.now(), version: 1,
    history: [{ at: nowIso, by: actor || 'unknown', action: 'created', detail: 'Created manually' }],
  };
  cache.set(id, doc);
  publish(id, doc);
  emitChange();
  return { ok: true, ticket: doc };
}
