import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createBridgeServer } from '../src/server.js';

const STATUS = { v: 1, type: 'status', connected: true, ready: true, state: 'ready', error: null,
  batteryPct: 87, firmware: '4.40' };
const SHOT = { v: 1, type: 'shot', shotId: 7, receivedAt: 1761500000123,
  ball: { speedMph: 132.4, launchAngleDeg: 14.2, launchDirectionDeg: 1.8, backspinRpm: 3100,
    sidespinRpm: -450, spinMeasured: false },
  club: { speedMph: null, faceAngleDeg: null, pathAngleDeg: null, attackAngleDeg: null } };

// A ws client that queues every frame so tests can await them in order.
async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames = [];
  const waiters = [];
  ws.on('message', (data, isBinary) => {
    const frame = { text: data.toString(), isBinary };
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  await once(ws, 'open');
  ws.nextFrame = () => (frames.length ? Promise.resolve(frames.shift())
    : new Promise((resolve) => waiters.push(resolve)));
  ws.pending = () => frames.length;
  return ws;
}

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

async function withServer(fn) {
  const server = await createBridgeServer({ port: 0 });
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

test('listens on 127.0.0.1 with the actual port', () => withServer(async (server) => {
  assert.ok(server.port > 0);
  assert.equal(server.hasClient, false);
}));

test('a new client immediately receives the latest status', () => withServer(async (server) => {
  server.setStatus({ ...STATUS, state: 'busy' });
  server.setStatus(STATUS);
  const ws = await connect(server.port);
  const frame = await ws.nextFrame();
  assert.equal(frame.isBinary, false);
  assert.deepEqual(JSON.parse(frame.text), STATUS);
  ws.close();
}));

test('no status is sent to a new client before one is set', () => withServer(async (server) => {
  const ws = await connect(server.port);
  await tick();
  assert.equal(ws.pending(), 0);
  ws.close();
}));

test('setStatus and sendShot reach the client as single JSON text frames', () => withServer(async (server) => {
  const ws = await connect(server.port);
  server.setStatus(STATUS);
  server.sendShot(SHOT);
  const a = await ws.nextFrame();
  const b = await ws.nextFrame();
  assert.equal(a.isBinary, false);
  assert.equal(b.isBinary, false);
  assert.equal(a.text, JSON.stringify(STATUS));
  assert.equal(b.text, JSON.stringify(SHOT));
  ws.close();
}));

test('client events report connect and disconnect', () => withServer(async (server) => {
  const events = [];
  server.on('client', (e) => events.push(e));
  const ws = await connect(server.port);
  await tick();
  assert.equal(server.hasClient, true);
  ws.close();
  await once(ws, 'close');
  await tick();
  assert.equal(server.hasClient, false);
  assert.equal(events.length, 2);
  assert.equal(events[0].connected, true);
  assert.match(events[0].remoteAddress, /127\.0\.0\.1/);
  assert.equal(events[1].connected, false);
}));

test('a new client replaces the old one without a false disconnect', () => withServer(async (server) => {
  const events = [];
  server.on('client', (e) => events.push(e));
  const first = await connect(server.port);
  const firstClosed = once(first, 'close');
  const second = await connect(server.port);

  const [code, reason] = await firstClosed;
  assert.equal(code, 1000);
  assert.equal(reason.toString(), 'replaced');
  await tick();

  assert.deepEqual(events.map((e) => e.connected), [true, true]);
  assert.equal(server.hasClient, true);

  server.sendShot(SHOT);
  const frame = await second.nextFrame();
  assert.deepEqual(JSON.parse(frame.text), SHOT);

  second.close();
  await once(second, 'close');
  await tick();
  assert.deepEqual(events.map((e) => e.connected), [true, true, false]);
  assert.equal(server.hasClient, false);
}));

test('messages from the client are ignored', () => withServer(async (server) => {
  const ws = await connect(server.port);
  ws.send('hello');
  ws.send(Buffer.from([1, 2, 3]));
  server.sendShot(SHOT);
  assert.deepEqual(JSON.parse((await ws.nextFrame()).text), SHOT);
  ws.close();
}));

test('sendShot and setStatus with no client do not throw', () => withServer(async (server) => {
  assert.doesNotThrow(() => server.sendShot(SHOT));
  assert.doesNotThrow(() => server.setStatus(STATUS));
}));

test('close() resolves with a connected client and closes it', async () => {
  const server = await createBridgeServer({ port: 0 });
  const ws = await connect(server.port);
  const closed = once(ws, 'close');
  await server.close();
  await closed;
  await server.close();
});

test('a taken port rejects with EADDRINUSE', () => withServer(async (server) => {
  await assert.rejects(createBridgeServer({ port: server.port }), (err) => {
    assert.equal(err.code, 'EADDRINUSE');
    assert.match(err.message, new RegExp(`Port ${server.port} is already in use`));
    return true;
  });
}));
