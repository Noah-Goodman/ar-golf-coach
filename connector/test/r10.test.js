import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { R10 } from '../src/r10.js';

const UUIDS = {
  measurement: '6a4e3401667b11e3949a0800200c9a66',
  control: '6a4e3402667b11e3949a0800200c9a66',
  status: '6a4e3403667b11e3949a0800200c9a66',
  secure: '6a4e2812667b11e3949a0800200c9a66',
  battery: '2a19',
  firmware: '2a28',
};

const STATUS_READY = '000000';
const STATUS_BUSY = '000001';
const STATUS_STANDBY = '000100';
const STATUS_OVERHEATED = '000201';

// ---- fake noble ---------------------------------------------------------------------------------

class FakeChar extends EventEmitter {
  constructor(name, ops, value = Buffer.alloc(0)) {
    super();
    this.name = name;
    this.uuid = UUIDS[name];
    this.ops = ops;
    this.value = value;
    this.readFailures = 0;
  }

  async readAsync() {
    this.ops.push(`read ${this.name}`);
    if (this.readFailures > 0) {
      this.readFailures -= 1;
      throw new Error('Authentication is insufficient');
    }
    return this.value;
  }

  async writeAsync(data, withoutResponse) {
    this.ops.push({ op: 'write', name: this.name, hex: data.toString('hex'), withoutResponse });
  }

  async subscribeAsync() {
    this.ops.push(`subscribe ${this.name}`);
  }

  async unsubscribeAsync() {
    this.ops.push(`unsubscribe ${this.name}`);
  }

  notify(hex) {
    this.emit('data', Buffer.from(hex, 'hex'), true, null);
  }
}

class FakePeripheral extends EventEmitter {
  constructor({ id, localName, ops }) {
    super();
    this.id = id;
    this.advertisement = { localName };
    this.ops = ops;
    this.state = 'disconnected';
    this.connectFailures = 0;
    this.chars = {
      measurement: new FakeChar('measurement', ops),
      control: new FakeChar('control', ops),
      status: new FakeChar('status', ops),
      secure: new FakeChar('secure', ops, Buffer.from([1])),
      battery: new FakeChar('battery', ops, Buffer.from([87])),
      firmware: new FakeChar('firmware', ops, Buffer.from('4.40\0\0 ', 'utf8')),
    };
  }

  async connectAsync() {
    this.ops.push(`connect ${this.id}`);
    if (this.connectFailures > 0) {
      this.connectFailures -= 1;
      this.state = 'error';
      throw new Error('connection failed');
    }
    this.state = 'connected';
  }

  async disconnectAsync() {
    this.ops.push(`disconnect ${this.id}`);
    this.state = 'disconnected';
    this.emit('disconnect', 'local');
  }

  async discoverAllServicesAndCharacteristicsAsync() {
    this.ops.push('discover');
    return { services: [], characteristics: Object.values(this.chars) };
  }

  // The R10 dropping the link.
  drop() {
    this.state = 'disconnected';
    this.emit('disconnect', 'remote');
  }
}

// Mirrors the parts of @stoprocent/noble 2.8 that R10 uses. discoverAsync() yields each known
// peripheral once per scan and then waits; it ends only when stopScanningAsync() is called.
class FakeNoble extends EventEmitter {
  constructor(peripherals, ops) {
    super();
    this.peripherals = peripherals;
    this.ops = ops;
    this.powered = true;
    this.powerFailures = 0;
    this.powerWaiters = new Set();
    this.stopId = 0;
    this.scanWaiters = new Set();
    this.activeScans = 0;
  }

  async waitForPoweredOnAsync() {
    if (this.powerFailures > 0) {
      this.powerFailures -= 1;
      throw new Error('Timeout waiting for Noble to be powered on');
    }
    if (!this.powered) await new Promise((resolve) => this.powerWaiters.add(resolve));
  }

  powerOn() {
    this.powered = true;
    for (const resolve of this.powerWaiters) resolve();
    this.powerWaiters.clear();
  }

  async startScanningAsync() {
    this.ops.push('startScanning');
  }

  async stopScanningAsync() {
    this.ops.push('stopScanning');
    this.stopId += 1;
    for (const resolve of this.scanWaiters) resolve();
    this.scanWaiters.clear();
  }

  async *discoverAsync() {
    const id = this.stopId;
    this.activeScans += 1;
    try {
      let index = 0;
      while (id === this.stopId) {
        if (index < this.peripherals.length) {
          yield this.peripherals[index++];
        } else {
          await new Promise((resolve) => this.scanWaiters.add(resolve));
        }
      }
    } finally {
      this.activeScans -= 1;
    }
  }
}

// ---- helpers ------------------------------------------------------------------------------------

async function waitFor(predicate, label = 'condition', timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup({ r10Id = 'aabbcc', id = 'AABBCC', localName = 'Approach R10', others = [], ...options } = {}) {
  const ops = [];
  const peripheral = new FakePeripheral({ id, localName, ops });
  const otherPeripherals = others.map((o) => new FakePeripheral({ ...o, ops: [] }));
  const noble = new FakeNoble([...otherPeripherals, peripheral], ops);
  let clock = 1000;
  const r10 = new R10({ r10Id, noble, wakeDelayMs: 3, retryDelayMs: 3, now: () => ++clock, ...options });
  const events = { status: [], log: [], packet: [], shot: [], paired: [] };
  for (const name of Object.keys(events)) r10.on(name, (value) => events[name].push(value));
  const { chars } = peripheral;
  const writes = () => ops.filter((op) => typeof op === 'object' && op.op === 'write');
  const connects = () => ops.filter((op) => op === `connect ${id}`).length;
  return { ops, peripheral, otherPeripherals, noble, r10, events, chars, writes, connects };
}

// Connects, waits for the wake write, then reports ready.
async function connectReady(ctx, wakeCount = 1) {
  await waitFor(() => ctx.writes().length >= wakeCount, 'wake write');
  ctx.chars.status.notify(STATUS_READY);
  assert.equal(ctx.r10.state.state, 'ready');
}

function timeoutCount() {
  return process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
}

// ---- tests --------------------------------------------------------------------------------------

test('connect sequence: scan, connect, read, subscribe in order, then wake', async () => {
  const ctx = setup();
  await ctx.r10.start();
  await waitFor(() => ctx.writes().length === 1, 'wake write');

  const sequence = ctx.ops.filter((op) => typeof op === 'string' && op !== 'startScanning');
  assert.deepEqual(sequence.slice(sequence.indexOf('stopScanning')), [
    'stopScanning',
    'connect AABBCC',
    'discover',
    'read battery',
    'read firmware',
    'subscribe control',
    'subscribe status',
    'subscribe measurement',
    'subscribe battery',
  ]);
  assert.deepEqual(ctx.ops.at(-1), { op: 'write', name: 'control', hex: '00', withoutResponse: false });
  assert.equal(ctx.noble.activeScans, 0);

  const state = ctx.r10.state;
  assert.equal(state.batteryPct, 87);
  assert.equal(state.firmware, '4.40');
  assert.equal(state.connected, true);
  assert.equal(state.state, 'connecting');
  assert.equal(state.ready, false);

  ctx.chars.status.notify(STATUS_READY);
  assert.deepEqual(ctx.r10.state, {
    connected: true, ready: true, state: 'ready', error: null, batteryPct: 87, firmware: '4.40',
  });

  const states = ctx.events.status.map((s) => s.state);
  assert.equal(states[0], 'scanning');
  assert.ok(states.indexOf('connecting') > 0);
  assert.equal(states.at(-1), 'ready');
  assert.ok(ctx.events.status.some((s) => s.state === 'connecting' && s.connected === false));
  assert.ok(ctx.events.status.some((s) => s.state === 'connecting' && s.connected === true));

  await ctx.r10.stop();
});

test('status is emitted only on change and as a fresh copy', async () => {
  const ctx = setup();
  await ctx.r10.start();
  await connectReady(ctx);
  const count = ctx.events.status.length;
  ctx.chars.status.notify(STATUS_READY);
  ctx.chars.battery.notify('57'); // 87 again
  assert.equal(ctx.events.status.length, count);

  ctx.chars.battery.notify('50');
  assert.equal(ctx.events.status.length, count + 1);
  assert.equal(ctx.events.status.at(-1).batteryPct, 80);

  ctx.events.status.at(-1).batteryPct = 1;
  assert.equal(ctx.r10.state.batteryPct, 80);
  const copy = ctx.r10.state;
  copy.state = 'busy';
  assert.equal(ctx.r10.state.state, 'ready');

  for (let i = 1; i < ctx.events.status.length; i++) {
    assert.notDeepEqual(ctx.events.status[i], ctx.events.status[i - 1]);
  }
  await ctx.r10.stop();
});

test('busy and standby states; standby triggers another wake', async () => {
  const ctx = setup();
  await ctx.r10.start();
  await connectReady(ctx);

  ctx.chars.status.notify(STATUS_BUSY);
  assert.equal(ctx.r10.state.state, 'busy');
  assert.equal(ctx.r10.state.ready, false);

  ctx.chars.status.notify(STATUS_STANDBY);
  assert.equal(ctx.r10.state.state, 'standby');
  assert.equal(ctx.writes().length, 1);
  await waitFor(() => ctx.writes().length === 2, 'second wake');
  assert.deepEqual(ctx.writes()[1], { op: 'write', name: 'control', hex: '00', withoutResponse: false });

  ctx.chars.status.notify(STATUS_READY);
  assert.equal(ctx.r10.state.ready, true);
  await ctx.r10.stop();
});

test('error status sets error and clears ready; a later OK status clears it', async () => {
  const ctx = setup();
  await ctx.r10.start();
  await connectReady(ctx);

  ctx.chars.status.notify(STATUS_OVERHEATED);
  assert.equal(ctx.r10.state.error, 'overheated');
  assert.equal(ctx.r10.state.state, 'ready');
  assert.equal(ctx.r10.state.ready, false);

  ctx.chars.status.notify(STATUS_READY);
  assert.equal(ctx.r10.state.error, null);
  assert.equal(ctx.r10.state.ready, true);
  await ctx.r10.stop();
});

test('shots: split notifications give one shot, repeated ids give none', async () => {
  const ctx = setup();
  await ctx.r10.start();
  await connectReady(ctx);

  // flags 0x0003 (more data + ball speed), shot id 0x01020304, then ball speed 0x2000 (32 m/s).
  ctx.chars.measurement.notify('030004030201');
  assert.equal(ctx.events.shot.length, 0);
  ctx.chars.measurement.notify('0020');
  assert.equal(ctx.events.shot.length, 1);
  const { raw, receivedAt } = ctx.events.shot[0];
  assert.equal(raw.shotId, 0x01020304);
  assert.equal(raw.ballSpeedMps, 32);
  assert.equal(receivedAt, ctx.events.packet.at(-1).t);

  ctx.chars.measurement.notify('0200040302010020');
  assert.equal(ctx.events.shot.length, 1);

  ctx.chars.measurement.notify('0200050302010020');
  assert.equal(ctx.events.shot.length, 2);
  assert.equal(ctx.events.shot[1].raw.shotId, 0x01020305);
  await ctx.r10.stop();
});

test('a malformed measurement logs a warning and the connection survives', async () => {
  const ctx = setup();
  await ctx.r10.start();
  await connectReady(ctx);

  ctx.chars.measurement.notify('020009000000'); // promises ball speed, ends after the header
  assert.equal(ctx.events.shot.length, 0);
  assert.ok(ctx.events.log.some((l) => l.level === 'warn' && /measurement/.test(l.message)));
  ctx.chars.status.notify('00'); // too short
  assert.ok(ctx.events.log.some((l) => l.level === 'warn' && /status/.test(l.message)));

  assert.equal(ctx.r10.state.connected, true);
  ctx.chars.measurement.notify('02000a0000000020');
  assert.equal(ctx.events.shot.length, 1);
  assert.equal(ctx.events.shot[0].raw.shotId, 10);
  await ctx.r10.stop();
});

test('packet events for all four characteristics, before decoding', async () => {
  const ctx = setup();
  await ctx.r10.start();
  await connectReady(ctx);
  ctx.events.packet.length = 0;

  ctx.chars.control.notify('800000');
  ctx.chars.status.notify(STATUS_BUSY);
  ctx.chars.measurement.notify('0200');
  ctx.chars.battery.notify('40');

  assert.deepEqual(
    ctx.events.packet.map(({ char, hex }) => ({ char, hex })),
    [
      { char: 'control', hex: '800000' },
      { char: 'status', hex: STATUS_BUSY },
      { char: 'measurement', hex: '0200' },
      { char: 'battery', hex: '40' },
    ],
  );
  for (const packet of ctx.events.packet) {
    assert.deepEqual(Object.keys(packet), ['t', 'char', 'hex']);
    assert.equal(typeof packet.t, 'number');
  }
  assert.ok(ctx.events.log.some((l) => l.level === 'info' && /0x00 succeeded/.test(l.message)));
  ctx.chars.control.notify('800003');
  assert.ok(ctx.events.log.some((l) => l.level === 'warn' && /failed/.test(l.message)));
  await ctx.r10.stop();
});

test('disconnect emits disconnected then scanning, then reconnects and works again', async () => {
  const ctx = setup();
  await ctx.r10.start();
  await connectReady(ctx);
  ctx.chars.measurement.notify('030001000000'); // partial shot, discarded by the disconnect
  const before = ctx.events.status.length;

  ctx.peripheral.drop();
  await waitFor(() => ctx.events.status.length >= before + 2, 'disconnect statuses');
  assert.deepEqual(ctx.events.status[before], {
    connected: false, ready: false, state: 'disconnected', error: null, batteryPct: null, firmware: null,
  });
  assert.equal(ctx.events.status[before + 1].state, 'scanning');
  assert.equal(ctx.events.status[before + 1].connected, false);

  await connectReady(ctx, 2);
  assert.equal(ctx.connects(), 2);
  assert.equal(ctx.r10.state.batteryPct, 87);

  ctx.chars.measurement.notify('0200020000000020');
  assert.equal(ctx.events.shot.length, 1);
  assert.equal(ctx.events.shot[0].raw.shotId, 2);
  await ctx.r10.stop();
});

test('no wake write after a disconnect during the wake delay', async () => {
  const ctx = setup({ wakeDelayMs: 30, retryDelayMs: 5000 });
  await ctx.r10.start();
  await waitFor(() => ctx.ops.includes('subscribe battery'), 'subscriptions');
  ctx.peripheral.drop();
  await pause(60);
  assert.equal(ctx.writes().length, 0);
  assert.equal(ctx.connects(), 1);
  await ctx.r10.stop();
  assert.equal(ctx.writes().length, 0);
});

test('no standby wake write after a disconnect', async () => {
  const ctx = setup({ wakeDelayMs: 20, retryDelayMs: 5000 });
  await ctx.r10.start();
  await connectReady(ctx);
  ctx.chars.status.notify(STATUS_STANDBY);
  ctx.peripheral.drop();
  await pause(50);
  assert.equal(ctx.writes().length, 1);
  await ctx.r10.stop();
});

test('a failing connect is retried', async () => {
  const ctx = setup();
  ctx.peripheral.connectFailures = 2;
  await ctx.r10.start();
  await connectReady(ctx);
  assert.equal(ctx.connects(), 3);
  assert.equal(ctx.events.log.filter((l) => l.level === 'warn' && /connection failed/.test(l.message)).length, 2);
  assert.ok(ctx.events.status.some((s) => s.state === 'disconnected'));
  await ctx.r10.stop();
});

test('a missing characteristic is a failed connect', async () => {
  const ctx = setup();
  const firmware = ctx.peripheral.chars.firmware;
  delete ctx.peripheral.chars.firmware;
  await ctx.r10.start();
  await waitFor(() => ctx.events.log.some((l) => /missing characteristics: firmware/.test(l.message)), 'warning');
  assert.equal(ctx.ops.filter((op) => op === 'disconnect AABBCC').length >= 1, true);
  ctx.peripheral.chars.firmware = firmware;
  await connectReady(ctx);
  await ctx.r10.stop();
});

test('Bluetooth power-on failure is logged and retried', async () => {
  const ctx = setup();
  ctx.noble.powerFailures = 1;
  await ctx.r10.start();
  await connectReady(ctx);
  assert.ok(ctx.events.log.some((l) => l.level === 'warn' && /not powered on/.test(l.message)));
  await ctx.r10.stop();
});

test('scanning ignores peripherals with another id', async () => {
  const ctx = setup({ others: [{ id: 'ddeeff', localName: 'Approach R10' }] });
  await ctx.r10.start();
  await connectReady(ctx);
  assert.equal(ctx.ops.includes('connect ddeeff'), false);
  await ctx.r10.stop();
});

test('pairing with no saved id, then a normal connect with that id', async () => {
  const ctx = setup({ r10Id: null, others: [{ id: '112233', localName: 'Fitbit Charge' }, { id: '445566' }] });
  await ctx.r10.start();
  assert.equal(ctx.events.status[0].state, 'needs-pairing');
  assert.equal(ctx.events.status[0].connected, false);
  assert.ok(ctx.events.log.some((l) => l.level === 'info' && /pairing mode \(solid blue light\)/.test(l.message)));

  await connectReady(ctx);
  assert.deepEqual(ctx.events.paired, ['aabbcc']);
  for (const other of ctx.otherPeripherals) assert.equal(other.ops.length, 0);

  const strings = ctx.ops.filter((op) => typeof op === 'string');
  const pairPart = strings.slice(0, strings.indexOf('disconnect AABBCC') + 1);
  assert.deepEqual(pairPart.filter((op) => op !== 'startScanning'), [
    'stopScanning', 'connect AABBCC', 'discover', 'read secure', 'disconnect AABBCC',
  ]);
  assert.equal(ctx.connects(), 2);
  assert.ok(ctx.events.status.some((s) => s.state === 'scanning'));
  assert.equal(ctx.r10.state.state, 'ready');

  // The paired id is used from now on, including after a disconnect.
  ctx.peripheral.drop();
  await connectReady(ctx, 2);
  assert.deepEqual(ctx.events.paired, ['aabbcc']);
  assert.equal(ctx.ops.filter((op) => op === 'read secure').length, 1);
  await ctx.r10.stop();
});

test('pairing id is normalised to lowercase without colons', async () => {
  const ctx = setup({ r10Id: '', id: 'AA:BB:CC:DD:EE:FF', localName: 'GARMIN R10' });
  await ctx.r10.start();
  await waitFor(() => ctx.events.paired.length === 1, 'paired');
  assert.equal(ctx.events.paired[0], 'aabbccddeeff');
  await connectReady(ctx);
  await ctx.r10.stop();
});

test('a rejected secure read is repeated on the same connection until bonding completes', async () => {
  const ctx = setup({ r10Id: null, pairRetryMs: 2 });
  ctx.chars.secure.readFailures = 3;
  await ctx.r10.start();
  await connectReady(ctx);
  assert.deepEqual(ctx.events.paired, ['aabbcc']);
  assert.equal(ctx.ops.filter((op) => op === 'read secure').length, 4);
  assert.equal(ctx.events.log.filter((l) => /Waiting for macOS to pair/.test(l.message)).length, 1);
  assert.equal(ctx.events.log.some((l) => /Pairing not finished/.test(l.message)), false);

  // One connection for all four reads, then the normal connect.
  assert.equal(ctx.connects(), 2);
  const strings = ctx.ops.filter((op) => typeof op === 'string');
  assert.ok(strings.lastIndexOf('read secure') < strings.indexOf('disconnect AABBCC'));
  await ctx.r10.stop();
});

test('pairing starts over when the secure read keeps rejecting past its time limit', async () => {
  const ctx = setup({ r10Id: null, pairRetryMs: 2, secureReadTimeoutMs: 15 });
  ctx.chars.secure.readFailures = Infinity;
  await ctx.r10.start();
  await waitFor(() => ctx.connects() >= 2, 'second pairing attempt');
  assert.ok(ctx.events.log.some((l) => l.level === 'warn' && /Pairing not finished/.test(l.message)));
  assert.deepEqual(ctx.events.paired, []);
  assert.equal(ctx.r10.state.state, 'needs-pairing');

  // Bonding completes during a later attempt.
  ctx.chars.secure.readFailures = 0;
  await connectReady(ctx);
  assert.deepEqual(ctx.events.paired, ['aabbcc']);
  await ctx.r10.stop();
});

test('a disconnect while waiting for bonding ends the attempt and pairing is retried', async () => {
  const ctx = setup({ r10Id: null, pairRetryMs: 2 });
  ctx.chars.secure.readFailures = Infinity;
  await ctx.r10.start();
  await waitFor(() => ctx.ops.filter((op) => op === 'read secure').length >= 2, 'repeated secure read');
  ctx.peripheral.drop();
  await waitFor(() => ctx.connects() >= 2, 'second pairing attempt');
  assert.ok(ctx.events.log.some((l) => l.level === 'warn' && /not in pairing mode/.test(l.message)));
  await waitFor(() => ctx.ops.filter((op) => op === 'read secure').length >= 4, 'reads on the second attempt');
  ctx.peripheral.drop();
  await waitFor(() => ctx.connects() >= 3, 'third pairing attempt');
  assert.equal(ctx.events.log.filter((l) => /not in pairing mode/.test(l.message)).length, 1);
  assert.ok(ctx.events.log.some((l) => /refused pairing again/.test(l.message)));
  ctx.chars.secure.readFailures = 0;
  await connectReady(ctx);
  assert.deepEqual(ctx.events.paired, ['aabbcc']);
  await ctx.r10.stop();
});

test('listeners do not accumulate across reconnects', async () => {
  const ctx = setup();
  await ctx.r10.start();
  await connectReady(ctx);
  for (let i = 2; i <= 5; i++) {
    ctx.peripheral.drop();
    await connectReady(ctx, i);
    assert.equal(ctx.peripheral.listenerCount('disconnect'), 1);
    for (const name of ['measurement', 'control', 'status', 'battery']) {
      assert.equal(ctx.chars[name].listenerCount('data'), 1, name);
    }
  }
  await ctx.r10.stop();
  assert.equal(ctx.peripheral.listenerCount('disconnect'), 0);
  for (const char of Object.values(ctx.chars)) assert.equal(char.listenerCount('data'), 0);
});

async function assertStoppedCleanly(ctx, timersBefore) {
  const started = Date.now();
  await ctx.r10.stop();
  await ctx.r10.stop();
  assert.ok(Date.now() - started < 200, 'stop() is prompt');
  assert.equal(ctx.r10.state.state, 'disconnected');
  assert.equal(ctx.r10.state.connected, false);
  assert.equal(ctx.noble.activeScans, 0);
  assert.equal(ctx.peripheral.listenerCount('disconnect'), 0);
  for (const char of Object.values(ctx.chars)) assert.equal(char.listenerCount('data'), 0);
  assert.ok(timeoutCount() <= timersBefore, 'no timers left behind');
  const opsAfter = ctx.ops.length;
  const statusAfter = ctx.events.status.length;
  await pause(30);
  assert.equal(ctx.ops.length, opsAfter, 'nothing happens after stop');
  assert.equal(ctx.events.status.length, statusAfter);
}

test('stop() while waiting for Bluetooth power', async () => {
  const timers = timeoutCount();
  const ctx = setup();
  ctx.noble.powered = false;
  await ctx.r10.start();
  await pause(5);
  await assertStoppedCleanly(ctx, timers);
  assert.equal(ctx.connects(), 0);
});

test('stop() while scanning', async () => {
  const timers = timeoutCount();
  const ctx = setup({ id: '999999' });
  await ctx.r10.start();
  await waitFor(() => ctx.noble.activeScans === 1, 'scan');
  await assertStoppedCleanly(ctx, timers);
  assert.ok(ctx.ops.includes('stopScanning'));
});

test('stop() while connecting', async () => {
  const timers = timeoutCount();
  const ctx = setup();
  let release;
  ctx.peripheral.connectAsync = function () {
    this.ops.push(`connect ${this.id}`);
    this.state = 'connecting';
    return new Promise((resolve) => { release = resolve; });
  };
  ctx.peripheral.cancelConnect = function () {
    this.ops.push('cancelConnect');
    this.state = 'disconnected';
  };
  await ctx.r10.start();
  await waitFor(() => ctx.connects() === 1, 'connect');
  await assertStoppedCleanly(ctx, timers);
  assert.ok(ctx.ops.includes('cancelConnect'));
  release();
});

test('stop() while connected disconnects', async () => {
  const timers = timeoutCount();
  const ctx = setup({ wakeDelayMs: 1000 });
  await ctx.r10.start();
  await waitFor(() => ctx.ops.includes('subscribe battery'), 'subscriptions');
  await assertStoppedCleanly(ctx, timers);
  assert.ok(ctx.ops.includes('disconnect AABBCC'));
  assert.equal(ctx.writes().length, 0);
});

test('stop() during the retry delay', async () => {
  const timers = timeoutCount();
  const ctx = setup({ retryDelayMs: 10000 });
  ctx.peripheral.connectFailures = 1;
  await ctx.r10.start();
  await waitFor(() => ctx.events.log.some((l) => /connection failed/.test(l.message)), 'failure');
  await assertStoppedCleanly(ctx, timers);
  assert.equal(ctx.connects(), 1);
});

test('stop() before start() and twice is safe', async () => {
  const ctx = setup();
  await ctx.r10.stop();
  await ctx.r10.stop();
  assert.equal(ctx.ops.length, 0);
});

test('a disconnect during the connect sequence leads to one cleanup and one retry', async () => {
  const ctx = setup({ retryDelayMs: 20 });
  const original = ctx.peripheral.discoverAllServicesAndCharacteristicsAsync;
  let first = true;
  ctx.peripheral.discoverAllServicesAndCharacteristicsAsync = function () {
    if (!first) return original.call(this);
    first = false;
    this.ops.push('discover');
    // noble rejects the in-flight operation as well as emitting 'disconnect'.
    const pending = new Promise((_, reject) => setTimeout(() => reject(new Error('Disconnected remote')), 5));
    setTimeout(() => this.drop(), 1);
    return pending;
  };
  await ctx.r10.start();
  await connectReady(ctx);
  await pause(40);
  assert.equal(ctx.connects(), 2);
  assert.equal(ctx.events.status.filter((s) => s.state === 'disconnected').length, 1);
  assert.equal(ctx.events.log.filter((l) => l.message === 'R10 disconnected').length, 1);
  assert.equal(ctx.events.log.filter((l) => l.level === 'warn').length, 0);
  await ctx.r10.stop();
});
