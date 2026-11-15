import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdbReverse, parseDevices, hasReverse } from '../src/adb.js';

const PORT = 8765;
const HEADER = 'List of devices attached\n';

// A fake adb: `devices` prints state.devices; `reverse --list` prints the serial's mappings;
// `reverse tcp:a tcp:b` adds one. state.fail, when set, makes every call fail with that error.
function fakeAdb() {
  const state = { devices: HEADER + '\n', reverses: new Map(), calls: [], fail: null };
  state.run = async (file, args) => {
    state.calls.push(args.join(' '));
    if (state.fail) throw state.fail;
    if (args[0] === 'devices') return { stdout: state.devices };
    const [flag, serial, cmd, ...rest] = args;
    assert.equal(flag, '-s');
    assert.equal(cmd, 'reverse');
    const list = state.reverses.get(serial) ?? [];
    if (rest[0] === '--list') {
      return { stdout: list.map((m) => `UsbFfs ${m}\n`).join('') };
    }
    list.push(rest.join(' '));
    state.reverses.set(serial, list);
    return { stdout: '' };
  };
  return state;
}

function collect(adb) {
  const events = [];
  for (const name of ['headset', 'reverse', 'log']) {
    adb.on(name, (e) => events.push({ name, ...e }));
  }
  return events;
}

const enoent = () => Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' });

test('parseDevices handles header, blanks, daemon chatter, tabs and spaces', () => {
  const out = [
    '* daemon not running; starting now at tcp:5037',
    '* daemon started successfully',
    'List of devices attached',
    '1WMHH000000000\tdevice',
    '2WMHH111111111   unauthorized',
    'emulator-5554\toffline',
    '3WMHH222222222 device usb:1-1 product:eureka model:Quest_3 transport_id:4',
    '',
    '',
  ].join('\n');
  assert.deepEqual(parseDevices(out), [
    { serial: '1WMHH000000000', state: 'device' },
    { serial: '2WMHH111111111', state: 'unauthorized' },
    { serial: 'emulator-5554', state: 'offline' },
    { serial: '3WMHH222222222', state: 'device' },
  ]);
  assert.deepEqual(parseDevices('List of devices attached\n\n'), []);
  assert.deepEqual(parseDevices(''), []);
});

test('hasReverse matches only the exact port mapping', () => {
  assert.equal(hasReverse('UsbFfs tcp:8765 tcp:8765\n', 8765), true);
  assert.equal(hasReverse('host-12 tcp:8765 tcp:8765', 8765), true);
  assert.equal(hasReverse('UsbFfs tcp:87650 tcp:87650\n', 8765), false);
  assert.equal(hasReverse('UsbFfs tcp:8765 tcp:9000\n', 8765), false);
  assert.equal(hasReverse('', 8765), false);
});

test('a device appearing gets the reverse applied with headset and reverse events', async () => {
  const fake = fakeAdb();
  const adb = createAdbReverse({ port: PORT, run: fake.run });
  const events = collect(adb);

  await adb.poll();
  assert.deepEqual(adb.devices, []);
  assert.deepEqual(events, []);

  fake.devices = HEADER + 'Q3SERIAL\tdevice\n\n';
  fake.calls.length = 0;
  await adb.poll();
  assert.deepEqual(adb.devices, ['Q3SERIAL']);
  assert.deepEqual(fake.calls, [
    'devices',
    '-s Q3SERIAL reverse --list',
    `-s Q3SERIAL reverse tcp:${PORT} tcp:${PORT}`,
  ]);
  assert.deepEqual(events, [
    { name: 'headset', connected: true, serial: 'Q3SERIAL' },
    { name: 'reverse', serial: 'Q3SERIAL', port: PORT },
  ]);
});

test('an existing mapping is not re-applied', async () => {
  const fake = fakeAdb();
  fake.devices = HEADER + 'Q3SERIAL\tdevice\n';
  fake.reverses.set('Q3SERIAL', [`tcp:${PORT} tcp:${PORT}`]);
  const adb = createAdbReverse({ port: PORT, run: fake.run });
  const events = collect(adb);

  await adb.poll();
  await adb.poll();
  assert.equal(fake.calls.filter((c) => c.endsWith(`tcp:${PORT} tcp:${PORT}`)).length, 0);
  assert.equal(fake.calls.filter((c) => c.endsWith('--list')).length, 2);
  assert.deepEqual(events, [{ name: 'headset', connected: true, serial: 'Q3SERIAL' }]);
});

test('a mapping that disappears while the device stays is re-applied', async () => {
  const fake = fakeAdb();
  fake.devices = HEADER + 'Q3SERIAL\tdevice\n';
  const adb = createAdbReverse({ port: PORT, run: fake.run });
  const events = collect(adb);

  await adb.poll();
  fake.reverses.clear(); // what an adb server restart looks like
  await adb.poll();
  await adb.poll();

  assert.deepEqual(events.map((e) => e.name), ['headset', 'reverse', 'reverse']);
});

test('a device leaving emits headset disconnected', async () => {
  const fake = fakeAdb();
  fake.devices = HEADER + 'Q3SERIAL\tdevice\n';
  const adb = createAdbReverse({ port: PORT, run: fake.run });
  const events = collect(adb);

  await adb.poll();
  fake.devices = HEADER + '\n';
  await adb.poll();
  assert.deepEqual(adb.devices, []);
  assert.deepEqual(events.filter((e) => e.name === 'headset'), [
    { name: 'headset', connected: true, serial: 'Q3SERIAL' },
    { name: 'headset', connected: false, serial: 'Q3SERIAL' },
  ]);
});

test('an unauthorized device gets one warning per appearance and no reverse', async () => {
  const fake = fakeAdb();
  fake.devices = HEADER + 'Q3SERIAL\tunauthorized\n';
  const adb = createAdbReverse({ port: PORT, run: fake.run });
  const events = collect(adb);

  await adb.poll();
  await adb.poll();
  await adb.poll();
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'log');
  assert.equal(events[0].level, 'warn');
  assert.match(events[0].message, /USB debugging/);
  assert.deepEqual(adb.devices, []);
  assert.ok(fake.calls.every((c) => c === 'devices'));

  fake.devices = HEADER + 'Q3SERIAL\tdevice\n';
  await adb.poll();
  fake.devices = HEADER + 'Q3SERIAL\tunauthorized\n';
  await adb.poll();
  assert.equal(events.filter((e) => e.name === 'log').length, 2);
});

test('adb missing warns once, then recovers', async () => {
  const fake = fakeAdb();
  fake.fail = enoent();
  const adb = createAdbReverse({ port: PORT, run: fake.run });
  const events = collect(adb);

  await adb.poll();
  await adb.poll();
  await adb.poll();
  assert.equal(events.length, 1);
  assert.equal(events[0].level, 'warn');
  assert.match(events[0].message, /adb not found/);

  fake.fail = null;
  fake.devices = HEADER + 'Q3SERIAL\tdevice\n';
  await adb.poll();
  assert.deepEqual(events.slice(1).map((e) => e.name + (e.level ? `:${e.level}` : '')),
    ['log:info', 'headset', 'reverse']);
});

test('repeated identical failures log once; a different failure logs again', async () => {
  const fake = fakeAdb();
  fake.fail = new Error('adb server version mismatch');
  const adb = createAdbReverse({ port: PORT, run: fake.run });
  const events = collect(adb);

  await adb.poll();
  await adb.poll();
  fake.fail = new Error('cannot connect to daemon');
  await adb.poll();
  assert.deepEqual(events.map((e) => e.level), ['warn', 'warn']);
});

test('a throwing run does not stop later polls', async () => {
  let calls = 0;
  let throwSync = true;
  const run = (file, args) => {
    calls += 1;
    if (throwSync) throw new Error('boom');
    if (args[0] === 'devices') return Promise.resolve({ stdout: HEADER + 'Q3SERIAL\tdevice\n' });
    return Promise.resolve({ stdout: '' });
  };
  const adb = createAdbReverse({ port: PORT, intervalMs: 5, run });
  const headsets = [];
  adb.on('headset', (e) => headsets.push(e));
  adb.on('log', () => {});

  adb.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(calls >= 2, `expected repeated polls, got ${calls}`);
  throwSync = false;
  await new Promise((resolve) => setTimeout(resolve, 40));
  adb.stop();
  assert.deepEqual(headsets, [{ connected: true, serial: 'Q3SERIAL' }]);
});

test('polls never overlap and stop() ends polling', async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const run = async () => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return { stdout: HEADER };
  };
  const adb = createAdbReverse({ port: PORT, intervalMs: 1, run });
  adb.start();
  adb.start();
  await Promise.all([adb.poll(), adb.poll()]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  adb.stop();
  await adb.poll();
  const after = calls;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(maxActive, 1);
  assert.ok(after >= 2);
  assert.equal(calls, after);
});
