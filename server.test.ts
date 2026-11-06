import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app, sessions } from './server';

let server: Server;
let base: string;

before(async () => {
  server = app.listen(0); // port 0 = pick any free port
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => sessions.clear()); // every test starts clean

const post = (path: string, body?: unknown) =>
  fetch(base + path, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

const startSession = async (task = 'Write cover letter') => {
  const res = await post('/sessions', { task, plannedSeconds: 600 });
  return { res, body: await res.json() };
};

test('creates an active session', async () => {
  const { res, body } = await startSession();
  assert.equal(res.status, 201);
  assert.equal(body.status, 'ACTIVE');
  assert.equal(body.task, 'Write cover letter');
});

test('rejects a task-less request', async () => {
  const res = await post('/sessions', {});
  assert.equal(res.status, 400);
});

test('only one open session at a time', async () => {
  await startSession();
  const { res } = await startSession('Second task');
  assert.equal(res.status, 409);
});

test('pause -> resume -> complete follows the state machine', async () => {
  const { body } = await startSession();
  const id = body.id;

  assert.equal((await (await post(`/sessions/${id}/pause`)).json()).status, 'PAUSED');
  assert.equal((await (await post(`/sessions/${id}/resume`)).json()).status, 'ACTIVE');
  assert.equal((await (await post(`/sessions/${id}/complete`)).json()).status, 'COMPLETED');
});

test('cannot pause a completed session', async () => {
  const { body } = await startSession();
  await post(`/sessions/${body.id}/complete`);
  const res = await post(`/sessions/${body.id}/pause`);
  assert.equal(res.status, 409);
});

test('parking lot saves a distraction on an open session', async () => {
  const { body } = await startSession();
  const res = await post(`/sessions/${body.id}/distractions`, { note: 'email Sam' });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).distractions[0].note, 'email Sam');
});

test('parking lot rejects closed sessions', async () => {
  const { body } = await startSession();
  await post(`/sessions/${body.id}/abandon`);
  const res = await post(`/sessions/${body.id}/distractions`, { note: 'too late' });
  assert.equal(res.status, 404);
});


test('unknown action returns 400', async () => {
  const { body } = await startSession();
  const res = await post(`/sessions/${body.id}/explode`);
  assert.equal(res.status, 400);
});