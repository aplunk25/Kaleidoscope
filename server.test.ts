import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from './server';
import { prisma } from './db';

let server: Server;
let base: string;

before(async () => {
  server = app.listen(0); // port 0 = pick any free port
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  server.close();
  await prisma.$disconnect(); // otherwise the test process hangs
});

beforeEach(async () => {
  await prisma.session.deleteMany();
});

const post = (path: string, body?: unknown) =>
  fetch(base + path, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

const startSession = async (task = 'Write cover letter', plannedSeconds = 600) => {
  const res = await post('/sessions', { task, plannedSeconds });
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

test('database rejects a second open session even when the API check is bypassed', async () => {
  await prisma.session.create({ data: { task: 'a', plannedSeconds: 600 } });
  await assert.rejects(
    prisma.session.create({ data: { task: 'b', plannedSeconds: 600 } }),
  );
});

test('rejects invalid plannedSeconds', async () => {
  for (const plannedSeconds of [-5, 0, 10, 1.5, 'banana', 999999]) {
    const res = await post('/sessions', { task: 'x', plannedSeconds });
    assert.equal(res.status, 400, `plannedSeconds=${plannedSeconds}`);
  }
});

test('plannedSeconds defaults to 900', async () => {
  const res = await post('/sessions', { task: 'x' });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).plannedSeconds, 900);
});

test('rejects over-long task titles', async () => {
  const res = await post('/sessions', { task: 'x'.repeat(201) });
  assert.equal(res.status, 400);
});

test('validation errors explain what is wrong', async () => {
  const res = await post('/sessions', { task: '' });
  const body = await res.json();
  assert.equal(body.error, 'validation_failed');
  assert.equal(body.details[0].path, 'task');
});

test('rejects an empty distraction note', async () => {
  const { body } = await startSession();
  const res = await post(`/sessions/${body.id}/distractions`, { note: '   ' });
  assert.equal(res.status, 400);
});


test('stores the tiny first step', async () => {
  const res = await post('/sessions', { task: 'Write essay', firstStep: 'open the doc' });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).firstStep, 'open the doc');
});

test('pause saves a left-off note that survives resume', async () => {
  const { body } = await startSession();
  const paused = await (await post(`/sessions/${body.id}/pause`, { note: 'finishing intro' })).json();
  assert.equal(paused.leftOffNote, 'finishing intro');
  const resumed = await (await post(`/sessions/${body.id}/resume`)).json();
  assert.equal(resumed.leftOffNote, 'finishing intro');
});



test('extend adds 5 minutes by default', async () => {
  const { body } = await startSession(); // planned 600
  const res = await post(`/sessions/${body.id}/extend`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).plannedSeconds, 900);
});

test('extend accepts a custom amount', async () => {
  const { body } = await startSession();
  const res = await post(`/sessions/${body.id}/extend`, { seconds: 120 });
  assert.equal((await res.json()).plannedSeconds, 720);
});

test('a paused session can be extended', async () => {
  const { body } = await startSession();
  await post(`/sessions/${body.id}/pause`);
  const res = await post(`/sessions/${body.id}/extend`);
  assert.equal(res.status, 200);
});

test('extend counts from now when the timer already ran out', async () => {
  const { body } = await startSession(); // planned 600
  await prisma.session.update({
    where: { id: body.id },
    data: { startedAt: new Date(Date.now() - 20 * 60 * 1000) }, // 20 min ago
  });
  const res = await post(`/sessions/${body.id}/extend`, { seconds: 300 });
  const remaining = (await res.json()).remainingSeconds;
  assert.ok(remaining >= 298 && remaining <= 300, `remaining=${remaining}`);
});

test('cannot extend a closed session', async () => {
  const { body } = await startSession();
  await post(`/sessions/${body.id}/complete`);
  assert.equal((await post(`/sessions/${body.id}/extend`)).status, 409);
});

test('extend rejects invalid amounts', async () => {
  const { body } = await startSession();
  for (const seconds of [0, -60, 30, 5000, 1.5, 'x']) {
    const res = await post(`/sessions/${body.id}/extend`, { seconds });
    assert.equal(res.status, 400, `seconds=${seconds}`);
  }
});

test('extend stops at the 4 hour cap', async () => {
  const { body } = await startSession('Marathon', 4 * 60 * 60);
  assert.equal((await post(`/sessions/${body.id}/extend`)).status, 409);
});