// Serves v1 status and shot messages with no R10 attached.
//
//   node tools/fake-shots.js [--interval <seconds>] [--no-club] [--seed <n>] [--port <n>]
//
// Press Enter for a shot. Shots are RawShot objects passed through toShotMessage, so they
// take the same unit and sign path as live data.
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createBridgeServer } from '../src/server.js';
import { createAdbReverse } from '../src/adb.js';
import { FLAG } from '../src/decode.js';
import { toShotMessage, toStatusMessage } from '../src/toMessage.js';

const USAGE = 'usage: node tools/fake-shots.js [--interval <seconds>] [--no-club] [--seed <n>] [--port <n>]';
const DEG = Math.PI / 180;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseCli() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        interval: { type: 'string' },
        'no-club': { type: 'boolean', default: false },
        seed: { type: 'string' },
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
  const interval = values.interval === undefined ? null : Number(values.interval);
  if (interval !== null && !(interval > 0)) fail(`--interval must be a positive number of seconds\n${USAGE}`);
  const seed = values.seed === undefined ? null : Number(values.seed);
  if (seed !== null && !Number.isInteger(seed)) fail(`--seed must be an integer\n${USAGE}`);
  const port = values.port === undefined ? null : Number(values.port);
  if (port !== null && !(Number.isInteger(port) && port >= 1 && port <= 65535)) {
    fail(`--port must be an integer from 1 to 65535\n${USAGE}`);
  }
  return { interval, noClub: values['no-club'], seed, port };
}

// mulberry32: small seeded PRNG returning floats in [0, 1).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Rounds to the R10's wire resolution so fake values look like decoded ones.
const speedQ = (mps) => Math.round(mps * 256) / 256;
const angleQ = (rad) => Math.round(rad * 16384) / 16384;

function makeRawShotFactory(rng, noClub) {
  const between = (lo, hi) => lo + (hi - lo) * rng();
  let shotId = 0;

  return () => {
    shotId += 1;
    const clubSpeed = between(28, 50); // m/s, about 63-112 mph
    const smash = between(1.25, 1.48);
    const face = between(-5, 5) * DEG;
    const path = between(-6, 6) * DEG;
    const withClub = !noClub && rng() >= 0.25;

    const raw = {
      flags: 0,
      shotId,
      ballSpeedMps: speedQ(clubSpeed * smash),
      launchAngleRad: angleQ(between(6, 28) * DEG),
      // Start line follows the face more than the path.
      launchDirectionRad: angleQ(0.75 * face + 0.25 * path + between(-1, 1) * DEG),
      backspinRpm: Math.round(between(1800, 8500)),
      sidespinRpm: Math.round((face - path) / DEG * 180 + between(-200, 200)),
      clubSpeedMps: withClub ? speedQ(clubSpeed) : null,
      faceAngleRad: withClub ? angleQ(face) : null,
      pathAngleRad: withClub ? angleQ(path) : null,
      attackAngleRad: withClub ? angleQ(between(-6, 3) * DEG) : null,
      spinType: rng() < 0.5 ? 1 : 0,
      shotType: 1,
    };

    const present = [
      ['ballSpeedMps', FLAG.BALL_SPEED], ['launchAngleRad', FLAG.LAUNCH_ANGLE],
      ['launchDirectionRad', FLAG.LAUNCH_DIRECTION], ['backspinRpm', FLAG.BACKSPIN],
      ['sidespinRpm', FLAG.SIDESPIN], ['clubSpeedMps', FLAG.CLUB_SPEED], ['faceAngleRad', FLAG.FACE_ANGLE],
      ['pathAngleRad', FLAG.PATH_ANGLE], ['attackAngleRad', FLAG.ATTACK_ANGLE], ['spinType', FLAG.SPIN_TYPE],
      ['shotType', FLAG.SHOT_TYPE],
    ];
    for (const [key, bit] of present) if (raw[key] !== null) raw.flags |= bit;
    return raw;
  };
}

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

async function main() {
  const args = parseCli();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    fail(err.message);
  }
  const port = args.port ?? config.port;
  const seed = args.seed ?? Math.floor(Math.random() * 2 ** 32);
  const nextRawShot = makeRawShotFactory(mulberry32(seed), args.noClub);

  let server;
  try {
    server = await createBridgeServer({ port });
  } catch (err) {
    fail(err.code === 'EADDRINUSE' ? err.message : `WebSocket server failed: ${err.message}`);
  }

  const send = (message) => {
    if (message.type === 'shot') server.sendShot(message);
    else server.setStatus(message);
    console.log(`${stamp()}  sent ${JSON.stringify(message)}${server.hasClient ? '' : '  (no client)'}`);
  };

  console.log(`${stamp()}  Fake shots on ws://127.0.0.1:${server.port} (seed ${seed}` +
    `${args.noClub ? ', no club data' : ''}). Press Enter for a shot` +
    `${args.interval ? `, or wait ${args.interval}s` : ''}. Ctrl+C to quit.`);

  server.on('client', ({ connected, remoteAddress }) => {
    console.log(`${stamp()}  client ${connected ? 'connected' : 'disconnected'} (${remoteAddress ?? 'unknown'})`);
  });

  const adb = createAdbReverse({ port: server.port });
  adb.on('headset', ({ connected, serial }) => {
    console.log(`${stamp()}  headset ${serial} ${connected ? 'attached' : 'detached'}`);
  });
  adb.on('reverse', ({ serial }) => {
    console.log(`${stamp()}  adb reverse tcp:${server.port} tcp:${server.port} applied on ${serial}`);
  });
  adb.on('log', ({ level, message }) => console.log(`${stamp()}  ${level === 'info' ? '' : `${level.toUpperCase()}: `}${message}`));
  adb.start();

  send(toStatusMessage({ connected: true, ready: true, state: 'ready', error: null, batteryPct: 100, firmware: 'fake' }));

  const shoot = () => send(toShotMessage(nextRawShot(), Date.now()));
  const timer = args.interval ? setInterval(shoot, args.interval * 1000) : null;

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', shoot);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    if (timer) clearInterval(timer);
    rl.close();
    adb.stop();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
