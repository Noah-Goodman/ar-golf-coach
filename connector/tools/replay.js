// Replays a raw packet log as the v1 messages the live bridge would have sent.
//
//   node tools/replay.js <file.jsonl> [--print] [--speed <factor>] [--fast] [--port <n>]
//
// --print shows each shot's raw values before sign correction next to the v1 values, with no
// server and no adb. It is the view used for the push/pull sign test.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createBridgeServer } from '../src/server.js';
import { createAdbReverse } from '../src/adb.js';
import { ShotAssembler, decodeStatus } from '../src/decode.js';
import { SIGN, toShotMessage, toStatusMessage } from '../src/toMessage.js';

const USAGE = 'usage: node tools/replay.js <file.jsonl> [--print] [--speed <factor>] [--fast] [--port <n>]';
const CHARS = new Set(['measurement', 'control', 'status', 'battery']);
const RAD_TO_DEG = 180 / Math.PI;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseCli() {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        print: { type: 'boolean', default: false },
        speed: { type: 'string' },
        fast: { type: 'boolean', default: false },
        port: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (err) {
    fail(`${err.message}\n${USAGE}`);
  }
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (positionals.length !== 1) fail(USAGE);
  const speed = values.speed === undefined ? 1 : Number(values.speed);
  if (!(speed > 0) || !Number.isFinite(speed)) fail(`--speed must be a positive number\n${USAGE}`);
  const port = values.port === undefined ? null : Number(values.port);
  if (port !== null && !(Number.isInteger(port) && port >= 1 && port <= 65535)) {
    fail(`--port must be an integer from 1 to 65535\n${USAGE}`);
  }
  return { file: positionals[0], print: values.print, speed, fast: values.fast, port };
}

// Reproduces the DeviceState rules r10.js applies to status and battery notifications.
// A log only holds notifications from a connected session, so the replay starts connected.
function createStateTracker() {
  let state = { connected: true, ready: false, state: 'connecting', error: null, batteryPct: null, firmware: null };
  const update = (changes) => {
    const next = { ...state, ...changes };
    next.ready = next.state === 'ready' && next.error === null;
    const changed = Object.keys(next).some((k) => next[k] !== state[k]);
    state = next;
    return changed ? toStatusMessage(state) : null;
  };
  return {
    initial: () => toStatusMessage(state),
    status(decoded) {
      if (decoded.type === 'ok' && decoded.state) return update({ state: decoded.state, error: null });
      if (decoded.type === 'warn' && decoded.state === 'standby') return update({ state: 'standby' });
      if (decoded.type === 'error') return update({ error: decoded.error });
      return null;
    },
    battery: (pct) => update({ batteryPct: pct }),
  };
}

// Reads the log into entries { line, t, messages, raw?, note? }. Bad lines are reported and skipped.
function readLog(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    fail(`Cannot read ${file}: ${err.message}`);
  }

  const assembler = new ShotAssembler();
  const tracker = createStateTracker();
  const entries = [];
  const problems = [];
  let first = true;

  text.split(/\r?\n/).forEach((lineText, index) => {
    const line = index + 1;
    if (!lineText.trim()) return;

    let packet;
    try {
      packet = JSON.parse(lineText);
    } catch (err) {
      problems.push({ line, message: `not JSON (${err.message})` });
      return;
    }
    const { t, char, hex } = packet ?? {};
    if (!Number.isFinite(t) || !CHARS.has(char) || typeof hex !== 'string' || !/^([0-9a-f]{2})*$/i.test(hex)) {
      problems.push({ line, message: 'expected {"t": <ms>, "char": "measurement"|"control"|"status"|"battery", "hex": "<hex>"}' });
      return;
    }
    const bytes = Buffer.from(hex, 'hex');

    if (first) {
      entries.push({ line, t, messages: [tracker.initial()], note: 'initial' });
      first = false;
    }

    try {
      if (char === 'measurement') {
        const raw = assembler.push(bytes);
        if (raw) entries.push({ line, t, raw, messages: [toShotMessage(raw, t)] });
      } else if (char === 'status') {
        const decoded = decodeStatus(bytes);
        const message = tracker.status(decoded);
        if (message) entries.push({ line, t, messages: [message], statusText: decoded.message });
      } else if (char === 'battery') {
        if (bytes.length < 1) throw new Error('battery notification is empty');
        const message = tracker.battery(bytes.readUInt8(0));
        if (message) entries.push({ line, t, messages: [message] });
      }
    } catch (err) {
      problems.push({ line, message: `${err.name ?? 'Error'}: ${err.message}` });
    }
  });

  return { entries, problems };
}

function clock(t) {
  const d = new Date(t);
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

// Horizontal values always carry a sign character so left and right line up.
const signed = (v, decimals) => (v > 0 ? '+' : v < 0 ? '' : ' ') + v.toFixed(decimals);
const show = (v, decimals, unit = '') => (v === null || v === undefined ? '-' : `${signed(v, decimals)}${unit}`);
const plain = (v, decimals, unit = '') => (v === null || v === undefined ? '-' : `${v.toFixed(decimals)}${unit}`);
const showRad = (rad) => (rad === null ? '-' : `${signed(rad, 4)} rad  ${signed(rad * RAD_TO_DEG, 2)}°`);
const pad = (s, n) => String(s).padEnd(n);

function printShot(entry) {
  const { raw } = entry;
  const msg = entry.messages[0];
  const signOf = (s) => (s < 0 ? '×-1' : '×+1');
  console.log(`\nShot ${raw.shotId}   line ${entry.line}   ${clock(entry.t)}`);
  console.log('                    raw (before sign)          sign   v1');
  const rows = [
    ['launch direction', showRad(raw.launchDirectionRad), SIGN.launchDirection, show(msg.ball.launchDirectionDeg, 2, '°')],
    ['face angle', showRad(raw.faceAngleRad), SIGN.faceAngle, show(msg.club.faceAngleDeg, 2, '°')],
    ['path angle', showRad(raw.pathAngleRad), SIGN.pathAngle, show(msg.club.pathAngleDeg, 2, '°')],
    ['sidespin', show(raw.sidespinRpm, 0, ' rpm'), SIGN.sidespin, show(msg.ball.sidespinRpm, 0, ' rpm')],
  ];
  for (const [name, rawText, sign, v1Text] of rows) {
    console.log(`  ${pad(name, 18)}${pad(rawText, 27)}${pad(signOf(sign), 7)}${v1Text}`);
  }
  console.log(`  ball   ${plain(msg.ball.speedMph, 2, ' mph')}, launch ${plain(msg.ball.launchAngleDeg, 2, '°')}, ` +
    `backspin ${plain(msg.ball.backspinRpm, 0, ' rpm')}, spin ${msg.ball.spinMeasured === null ? '-' : msg.ball.spinMeasured ? 'measured' : 'estimated'}`);
  console.log(`  club   ${plain(msg.club.speedMph, 2, ' mph')}, attack ${plain(msg.club.attackAngleDeg, 2, '°')}`);
  console.log(`  json   ${JSON.stringify(msg)}`);
}

function printStatus(entry) {
  const s = entry.messages[0];
  const extra = entry.statusText ? `  "${entry.statusText}"` : '';
  console.log(`\nstatus  line ${entry.line}   ${clock(entry.t)}   ${s.state}${s.error ? `, error ${s.error}` : ''}` +
    `, ready ${s.ready}, battery ${s.batteryPct ?? '-'}${s.batteryPct === null ? '' : '%'}${extra}`);
}

function printAll(entries, problems) {
  const byLine = new Map(problems.map((p) => [p.line, p]));
  // The initial 'connecting' status is for live clients; the first logged packet supersedes it.
  const shown = entries.filter((e) => e.note !== 'initial');
  const all = [...shown.map((e) => ({ line: e.line, entry: e })), ...problems.map((p) => ({ line: p.line, problem: p }))]
    .sort((a, b) => a.line - b.line);
  for (const item of all) {
    if (item.problem) console.log(`\nskipped line ${item.line}: ${item.problem.message}`);
    else if (item.entry.raw) printShot(item.entry);
    else printStatus(item.entry);
  }
  const shots = shown.filter((e) => e.raw).length;
  const statuses = shown.length - shots;
  console.log(`\n${shots} shot${shots === 1 ? '' : 's'}, ${statuses} status message` +
    `${statuses === 1 ? '' : 's'}, ${byLine.size} skipped line${byLine.size === 1 ? '' : 's'}. ` +
    `SIGN = ${JSON.stringify(SIGN)} (src/toMessage.js)`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function serve(entries, args) {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    fail(err.message);
  }
  const port = args.port ?? config.port;

  let server;
  try {
    server = await createBridgeServer({ port });
  } catch (err) {
    fail(err.code === 'EADDRINUSE' ? err.message : `WebSocket server failed: ${err.message}`);
  }

  const stamp = () => new Date().toTimeString().slice(0, 8);
  const adb = createAdbReverse({ port: server.port });
  adb.on('headset', ({ connected, serial }) => console.log(`${stamp()}  headset ${serial} ${connected ? 'attached' : 'detached'}`));
  adb.on('reverse', ({ serial }) => console.log(`${stamp()}  adb reverse tcp:${server.port} tcp:${server.port} applied on ${serial}`));
  adb.on('log', ({ level, message }) => console.log(`${stamp()}  ${level === 'info' ? '' : `${level.toUpperCase()}: `}${message}`));
  adb.start();

  let stopping = false;
  const shutdown = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    adb.stop();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const firstClient = new Promise((resolve) => {
    server.on('client', ({ connected, remoteAddress }) => {
      console.log(`${stamp()}  client ${connected ? 'connected' : 'disconnected'} (${remoteAddress ?? 'unknown'})`);
      if (connected) resolve();
    });
  });

  const pace = args.fast ? 'no delays' : args.speed === 1 ? 'original timing' : `${args.speed}x speed`;
  console.log(`${stamp()}  Replaying ${args.file} on ws://127.0.0.1:${server.port} (${pace}). Waiting for a client...`);
  await firstClient;

  let previousT = entries.length ? entries[0].t : 0;
  for (const entry of entries) {
    if (!args.fast) await sleep(Math.max(0, entry.t - previousT) / args.speed);
    previousT = entry.t;
    for (const message of entry.messages) {
      if (message.type === 'shot') server.sendShot(message);
      else server.setStatus(message);
      console.log(`${stamp()}  line ${entry.line}  sent ${JSON.stringify(message)}${server.hasClient ? '' : '  (no client)'}`);
    }
  }
  console.log(`${stamp()}  Replay finished. Still serving the last status; Ctrl+C to quit.`);
}

async function main() {
  const args = parseCli();
  const { entries, problems } = readLog(args.file);
  if (args.print) {
    printAll(entries, problems);
    return;
  }
  for (const p of problems) console.error(`skipped line ${p.line}: ${p.message}`);
  await serve(entries, args);
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
