'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 43991;
const ROOT = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticketing-web-smoke-'));
let child;

async function waitFor(url) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function json(url, options = {}) {
  const response = await fetch(url, options);
  return { response, payload: await response.json() };
}

async function post(url, body, cookie = '') {
  return json(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function main() {
  child = spawn(process.execPath, ['status-monitor-web/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      TICKETING_WEB_PORT: String(PORT),
      TICKETING_DATA_DIR: dataDir,
      TICKETING_ADMIN_USERNAME: 'smoke-admin',
      TICKETING_ADMIN_PASSWORD: 'smoke-password',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });

  const base = `http://127.0.0.1:${PORT}`;
  const health = await waitFor(`${base}/healthz`);
  assert.equal((await health.json()).status, 'live');

  const index = await (await fetch(`${base}/`)).text();
  assert.match(index, /<title>Ticketing<\/title>/);
  assert.match(index, /web-bridge\.js/);

  const initial = await json(`${base}/api/tickets`);
  assert.equal(initial.response.status, 200);
  assert.deepEqual(initial.payload.tickets, []);

  const eventController = new AbortController();
  const stream = await fetch(`${base}/api/events`, { signal: eventController.signal });
  assert.match(stream.headers.get('content-type'), /^text\/event-stream/);
  const firstEvent = await stream.body.getReader().read();
  assert.match(Buffer.from(firstEvent.value).toString('utf8'), /event: tickets/);
  eventController.abort();

  const badLogin = await post(`${base}/api/auth/login`, { username: 'smoke-admin', password: 'wrong' });
  assert.equal(badLogin.response.status, 401);

  const login = await post(`${base}/api/auth/login`, { username: 'smoke-admin', password: 'smoke-password' });
  assert.equal(login.response.status, 200);
  const adminCookie = login.response.headers.get('set-cookie').split(';', 1)[0];

  const session = await json(`${base}/api/auth/session`, { headers: { cookie: adminCookie } });
  assert.equal(session.payload.user.username, 'smoke-admin');
  assert.equal(session.payload.user.isAdmin, true);

  const unauthenticatedCreate = await post(`${base}/api/tickets`, { companyLabel: 'Blocked' });
  assert.equal(unauthenticatedCreate.response.status, 401);

  const created = await post(`${base}/api/tickets`, {
    companyLabel: 'Smoke Company',
    host: '192.0.2.10',
    severity: 'red',
  }, adminCookie);
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.ticket.state, 'open');
  const id = created.payload.ticket.id;

  const claimed = await post(`${base}/api/tickets/${id}/claim`, {}, adminCookie);
  assert.equal(claimed.payload.ticket.claimedBy, 'smoke-admin');
  assert.equal(claimed.payload.ticket.state, 'claimed');

  const assigned = await post(`${base}/api/tickets/${id}/assign`, { assignee: 'Viewer One' }, adminCookie);
  assert.equal(assigned.payload.ticket.state, 'assigned');

  const commented = await post(`${base}/api/tickets/${id}/comment`, { text: 'Smoke comment' }, adminCookie);
  assert.equal(commented.payload.ticket.history.at(-1).detail, 'Smoke comment');

  const updated = await post(`${base}/api/tickets/${id}/update`, {
    fields: { title: 'Smoke title', priority: 'high' },
  }, adminCookie);
  assert.equal(updated.payload.ticket.title, 'Smoke title');
  assert.equal(updated.payload.ticket.priority, 'high');

  const resolved = await post(`${base}/api/tickets/${id}/resolve`, {}, adminCookie);
  assert.equal(resolved.payload.ticket.state, 'resolved');
  const reopened = await post(`${base}/api/tickets/${id}/reopen`, {}, adminCookie);
  assert.equal(reopened.payload.ticket.state, 'assigned');

  const createdUser = await post(`${base}/api/auth/users`, {
    username: 'viewer',
    password: 'viewer-password',
    canManageUsers: false,
  }, adminCookie);
  assert.equal(createdUser.response.status, 201);
  const viewerLogin = await post(`${base}/api/auth/login`, { username: 'viewer', password: 'viewer-password' });
  assert.equal(viewerLogin.response.status, 200);
  const viewerCookie = viewerLogin.response.headers.get('set-cookie').split(';', 1)[0];
  const forbiddenAssign = await post(`${base}/api/tickets/${id}/assign`, { assignee: 'Nobody' }, viewerCookie);
  assert.equal(forbiddenAssign.response.status, 403);

  const deleted = await json(`${base}/api/tickets/${id}`, {
    method: 'DELETE',
    headers: { cookie: adminCookie },
  });
  assert.equal(deleted.payload.ok, true);
  const finalList = await json(`${base}/api/tickets`);
  assert.equal(finalList.payload.tickets.some((ticket) => ticket.id === id), false);

  if (errors) throw new Error(errors);
  console.log('Web smoke: static UI, health, sessions, authorization, SSE, persistence, and every ticket mutation passed.');
}

main().finally(() => {
  if (child && !child.killed) child.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

