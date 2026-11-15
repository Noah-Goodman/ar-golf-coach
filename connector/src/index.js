// Live bridge: R10 over Bluetooth -> v1 JSON over WebSocket -> headset via adb reverse.
// Wiring and terminal output only; decoding lives in decode.js and toMessage.js.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, loadConfig, saveConfig, resolveLogDir } from './config.js';
import { createPacketLog } from './log.js';
import { createBridgeServer } from './server.js';
import { createAdbReverse } from './adb.js';
import { R10 } from './r10.js';
import { toShotMessage, toStatusMessage } from './toMessage.js';

const SHUTDOWN_TIMEOUT_MS = 5000;

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function timestamp(date = new Date()) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function say(message, level = 'info') {
  const prefix = level === 'info' ? '' : `${level.toUpperCase()}: `;
  console.log(`${timestamp()}  ${prefix}${message}`);
}

// A number with fixed decimals and a unit, or '-' when the value is missing.
function num(value, decimals, unit = '') {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(decimals)}${unit}` : '-';
}

// Like num(), with an explicit + on positive values, for angles where the sign carries the direction.
function signed(value, decimals, unit = '') {
  const text = num(value, decimals, unit);
  return typeof value === 'number' && value > 0 ? `+${text}` : text;
}

function hasAny(group) {
  return Object.values(group).some((v) => v !== null && v !== undefined);
}

// Every value of a v1 shot on one line. A group the R10 sent nothing for reads "not captured".
export function formatShotLine(message) {
  const ball = message?.ball ?? {};
  const club = message?.club ?? {};

  let ballText = 'ball not captured';
  if (hasAny(ball)) {
    const spinSource = ball.spinMeasured === null || ball.spinMeasured === undefined
      ? ''
      : ` (${ball.spinMeasured ? 'measured' : 'estimated'})`;
    ballText = `ball ${num(ball.speedMph, 1, ' mph')}, launch ${num(ball.launchAngleDeg, 1, '°')}, ` +
      `direction ${signed(ball.launchDirectionDeg, 1, '°')}, backspin ${num(ball.backspinRpm, 0, ' rpm')}, ` +
      `sidespin ${signed(ball.sidespinRpm, 0, ' rpm')}${spinSource}`;
  }

  let clubText = 'club not captured';
  if (hasAny(club)) {
    clubText = `club ${num(club.speedMph, 1, ' mph')}, face ${signed(club.faceAngleDeg, 1, '°')}, ` +
      `path ${signed(club.pathAngleDeg, 1, '°')}, attack ${signed(club.attackAngleDeg, 1, '°')}`;
  }

  return `Shot ${message?.shotId ?? '-'}: ${ballText} | ${clubText}`;
}

export function formatStatusLine(state) {
  const parts = [`R10 ${state?.state ?? '-'}`];
  if (state?.error) parts.push(`error ${state.error}`);
  parts.push(`battery ${num(state?.batteryPct, 0, '%')}`);
  parts.push(`firmware ${state?.firmware ?? '-'}`);
  return parts.join(', ');
}

async function main() {
  let r10 = null;
  let adb = null;
  let server = null;
  let packetLog = null;
  let stopping = false;

  async function shutdown(code) {
    if (stopping) process.exit(code || 1);
    stopping = true;
    say('Stopping...');
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
    try {
      await r10?.stop();
    } catch (err) {
      say(`R10 stop failed: ${err.message}`, 'warn');
    }
    adb?.stop();
    await server?.close();
    await packetLog?.close();
    process.exit(code);
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  packetLog = createPacketLog(resolveLogDir(config));

  try {
    server = await createBridgeServer({ port: config.port });
  } catch (err) {
    console.error(err.code === 'EADDRINUSE' ? err.message : `WebSocket server failed: ${err.message}`);
    await packetLog.close();
    process.exit(1);
  }

  say(`WebSocket: ws://127.0.0.1:${server.port} (headset reaches it through adb reverse tcp:${server.port})`);
  say(`Packet log: ${packetLog.path}`);
  say(config.r10Id
    ? `Saved R10 id: ${config.r10Id}`
    : `No saved R10 id in ${CONFIG_PATH}: starting pairing.`);

  server.on('client', ({ connected, remoteAddress }) => {
    say(`WebSocket client ${connected ? 'connected' : 'disconnected'} (${remoteAddress ?? 'unknown'})`);
  });

  adb = createAdbReverse({ port: config.port });
  adb.on('headset', ({ connected, serial }) => say(`Headset ${serial} ${connected ? 'attached' : 'detached'}`));
  adb.on('reverse', ({ serial, port }) => say(`adb reverse tcp:${port} tcp:${port} applied on ${serial}`));
  adb.on('log', ({ level, message }) => say(message, level));
  adb.start();

  r10 = new R10({ r10Id: config.r10Id });
  r10.on('log', ({ level, message }) => say(message, level));
  r10.on('packet', (packet) => packetLog.write(packet));
  // Some state changes (the link coming up while still connecting) do not alter the printed line.
  let lastStatusLine = null;
  r10.on('status', (state) => {
    const line = formatStatusLine(state);
    if (line !== lastStatusLine) {
      lastStatusLine = line;
      say(line);
    }
    server.setStatus(toStatusMessage(state));
  });
  r10.on('shot', ({ raw, receivedAt }) => {
    const message = toShotMessage(raw, receivedAt);
    say(formatShotLine(message));
    server.sendShot(message);
  });
  r10.on('paired', (id) => {
    config = { ...config, r10Id: id };
    try {
      saveConfig(config);
      say(`Paired with R10 ${id}; saved to ${CONFIG_PATH}`);
    } catch (err) {
      say(`Paired with R10 ${id} but could not save ${CONFIG_PATH}: ${err.message}`, 'error');
    }
  });
  await r10.start();
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((err) => {
    console.error(err?.stack ?? err);
    process.exit(1);
  });
}
