import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { PROTOCOL_VERSION, MPS_TO_MPH, SIGN, toShotMessage, toStatusMessage } from '../src/toMessage.js';

const DEG = 180 / Math.PI;
const rad = (deg) => deg / DEG;

// Reference rounding for expectations: 2 decimals, half away from zero, no -0.
function round2(x) {
  return (Math.sign(x) * Math.round(Math.abs(x) * 100)) / 100 + 0;
}

function rawShot(fields = {}) {
  return {
    flags: 0,
    shotId: 1,
    ballSpeedMps: null,
    launchAngleRad: null,
    launchDirectionRad: null,
    backspinRpm: null,
    sidespinRpm: null,
    clubSpeedMps: null,
    faceAngleRad: null,
    pathAngleRad: null,
    attackAngleRad: null,
    spinType: null,
    shotType: null,
    ...fields,
  };
}

const FULL = rawShot({
  flags: 0x0ffe,
  shotId: 1234,
  ballSpeedMps: 59.2,
  launchAngleRad: rad(14.2),
  launchDirectionRad: rad(1.8),
  backspinRpm: 3100,
  sidespinRpm: -450,
  clubSpeedMps: 41.17,
  faceAngleRad: rad(2.5),
  pathAngleRad: rad(-1.5),
  attackAngleRad: rad(-3),
  spinType: 0,
  shotType: 1,
});

function assertNoNegativeZero(value, path = 'message') {
  if (typeof value === 'number') {
    assert.ok(!Object.is(value, -0), `${path} is -0`);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoNegativeZero(v, `${path}.${k}`);
  }
}

describe('constants', () => {
  test('protocol version and unit factor', () => {
    assert.equal(PROTOCOL_VERSION, 1);
    assert.equal(MPS_TO_MPH, 2.236936);
  });

  // Documents the defaults shipped before the push/pull sign test. Update this test, and only
  // this test, when a constant is flipped after that test.
  test('SIGN default values', () => {
    assert.deepEqual(SIGN, { launchDirection: -1, faceAngle: -1, pathAngle: -1, sidespin: -1 });
  });

  test('every SIGN value is 1 or -1', () => {
    assert.deepEqual(Object.keys(SIGN).sort(), ['faceAngle', 'launchDirection', 'pathAngle', 'sidespin']);
    for (const v of Object.values(SIGN)) assert.ok(v === 1 || v === -1);
  });
});

describe('toShotMessage', () => {
  test('full shot has exactly the v1 shape and values', () => {
    const msg = toShotMessage(FULL, 1761500000123);
    assert.deepEqual(msg, {
      v: 1,
      type: 'shot',
      shotId: 1234,
      receivedAt: 1761500000123,
      ball: {
        speedMph: round2(59.2 * MPS_TO_MPH),
        launchAngleDeg: 14.2,
        launchDirectionDeg: round2(SIGN.launchDirection * 1.8),
        backspinRpm: 3100,
        sidespinRpm: SIGN.sidespin * -450,
        spinMeasured: false,
      },
      club: {
        speedMph: round2(41.17 * MPS_TO_MPH),
        faceAngleDeg: round2(SIGN.faceAngle * 2.5),
        pathAngleDeg: round2(SIGN.pathAngle * -1.5),
        attackAngleDeg: -3,
      },
    });
    assert.equal(msg.ball.speedMph, 132.43);
    assert.equal(msg.club.speedMph, 92.09);
  });

  test('top-level, ball and club key sets are exact', () => {
    const msg = toShotMessage(FULL, 0);
    assert.deepEqual(Object.keys(msg), ['v', 'type', 'shotId', 'receivedAt', 'ball', 'club']);
    assert.deepEqual(Object.keys(msg.ball), [
      'speedMph', 'launchAngleDeg', 'launchDirectionDeg', 'backspinRpm', 'sidespinRpm', 'spinMeasured',
    ]);
    assert.deepEqual(Object.keys(msg.club), ['speedMph', 'faceAngleDeg', 'pathAngleDeg', 'attackAngleDeg']);
  });

  test('no total spin, face-to-path, shot type or flags in the message', () => {
    const text = JSON.stringify(toShotMessage(FULL, 0));
    for (const word of ['total', 'Total', 'shotType', 'flags', 'faceToPath']) {
      assert.ok(!text.includes(word), word);
    }
  });

  test('all-null shot passes null through every position', () => {
    const msg = toShotMessage(rawShot({ shotId: 9 }), 5);
    assert.deepEqual(msg, {
      v: 1,
      type: 'shot',
      shotId: 9,
      receivedAt: 5,
      ball: {
        speedMph: null, launchAngleDeg: null, launchDirectionDeg: null,
        backspinRpm: null, sidespinRpm: null, spinMeasured: null,
      },
      club: { speedMph: null, faceAngleDeg: null, pathAngleDeg: null, attackAngleDeg: null },
    });
  });

  test('each field null on its own stays null and leaves the others set', () => {
    const map = {
      ballSpeedMps: ['ball', 'speedMph'],
      launchAngleRad: ['ball', 'launchAngleDeg'],
      launchDirectionRad: ['ball', 'launchDirectionDeg'],
      backspinRpm: ['ball', 'backspinRpm'],
      sidespinRpm: ['ball', 'sidespinRpm'],
      spinType: ['ball', 'spinMeasured'],
      clubSpeedMps: ['club', 'speedMph'],
      faceAngleRad: ['club', 'faceAngleDeg'],
      pathAngleRad: ['club', 'pathAngleDeg'],
      attackAngleRad: ['club', 'attackAngleDeg'],
    };
    const full = toShotMessage(FULL, 0);
    for (const [rawKey, [group, key]] of Object.entries(map)) {
      const msg = toShotMessage({ ...FULL, [rawKey]: null }, 0);
      assert.equal(msg[group][key], null, rawKey);
      assert.deepEqual({ ...msg, [group]: { ...msg[group], [key]: full[group][key] } }, full, rawKey);
    }
  });

  test('ball-only shot has a full club object of nulls', () => {
    const msg = toShotMessage(
      rawShot({ ballSpeedMps: 50, launchAngleRad: rad(20), launchDirectionRad: 0, backspinRpm: 7400, sidespinRpm: -120, spinType: 1 }),
      0,
    );
    assert.deepEqual(msg.club, { speedMph: null, faceAngleDeg: null, pathAngleDeg: null, attackAngleDeg: null });
    assert.equal(msg.ball.speedMph, round2(50 * MPS_TO_MPH));
    assert.equal(msg.ball.spinMeasured, true);
  });

  test('sign constants apply to launch direction, face, path and sidespin', () => {
    for (const deg of [3.21, -3.21]) {
      const msg = toShotMessage(
        rawShot({ launchDirectionRad: rad(deg), faceAngleRad: rad(deg), pathAngleRad: rad(deg), sidespinRpm: deg > 0 ? 500 : -500 }),
        0,
      );
      assert.equal(msg.ball.launchDirectionDeg, round2(SIGN.launchDirection * deg));
      assert.equal(msg.club.faceAngleDeg, round2(SIGN.faceAngle * deg));
      assert.equal(msg.club.pathAngleDeg, round2(SIGN.pathAngle * deg));
      assert.equal(msg.ball.sidespinRpm, SIGN.sidespin * (deg > 0 ? 500 : -500));
    }
  });

  test('launch angle, attack angle and backspin are never sign-adjusted', () => {
    const msg = toShotMessage(rawShot({ launchAngleRad: rad(-2.5), attackAngleRad: rad(4.75), backspinRpm: -150 }), 0);
    assert.equal(msg.ball.launchAngleDeg, -2.5);
    assert.equal(msg.club.attackAngleDeg, 4.75);
    assert.equal(msg.ball.backspinRpm, -150);
  });

  test('negative angles survive conversion', () => {
    const msg = toShotMessage(rawShot({ launchAngleRad: -0.5, attackAngleRad: -0.1 }), 0);
    assert.equal(msg.ball.launchAngleDeg, round2(-0.5 * DEG));
    assert.equal(msg.ball.launchAngleDeg, -28.65);
    assert.equal(msg.club.attackAngleDeg, -5.73);
  });

  test('speeds and angles are rounded to 2 decimals', () => {
    const msg = toShotMessage(rawShot({ ballSpeedMps: 65535 / 256, launchAngleRad: 4061 / 16384, clubSpeedMps: 1 / 256 }), 0);
    assert.equal(msg.ball.speedMph, 572.65);
    assert.equal(msg.ball.launchAngleDeg, 14.2);
    assert.equal(msg.club.speedMph, 0.01);
    for (const v of [msg.ball.speedMph, msg.ball.launchAngleDeg, msg.club.speedMph]) {
      assert.equal(Math.round(v * 100) / 100, v);
    }
  });

  test('spin passes through as the integer read', () => {
    const msg = toShotMessage(rawShot({ backspinRpm: 32767, sidespinRpm: -32768 }), 0);
    assert.equal(msg.ball.backspinRpm, 32767);
    assert.equal(msg.ball.sidespinRpm, SIGN.sidespin * -32768);
  });

  test('never emits -0', () => {
    const tiny = -1e-6;
    const msgs = [
      toShotMessage(
        rawShot({
          ballSpeedMps: 0, clubSpeedMps: 0, launchAngleRad: 0, launchDirectionRad: 0, faceAngleRad: 0,
          pathAngleRad: 0, attackAngleRad: 0, backspinRpm: 0, sidespinRpm: 0, spinType: 0,
        }),
        0,
      ),
      toShotMessage(
        rawShot({
          launchAngleRad: tiny, launchDirectionRad: tiny, faceAngleRad: tiny, pathAngleRad: tiny, attackAngleRad: tiny,
        }),
        0,
      ),
      toShotMessage(
        rawShot({
          launchAngleRad: -tiny, launchDirectionRad: -tiny, faceAngleRad: -tiny, pathAngleRad: -tiny, attackAngleRad: -tiny,
        }),
        0,
      ),
      toShotMessage(rawShot({ launchDirectionRad: -0, faceAngleRad: -0, pathAngleRad: -0, sidespinRpm: -0, backspinRpm: -0 }), 0),
    ];
    for (const msg of msgs) {
      assertNoNegativeZero(msg);
      for (const group of [msg.ball, msg.club]) {
        for (const [k, v] of Object.entries(group)) {
          if (typeof v === 'number') assert.ok(Object.is(v, 0), `${k} = ${v}`);
        }
      }
    }
  });

  test('spinMeasured is true only for spinType 1', () => {
    assert.equal(toShotMessage(rawShot({ spinType: 1 }), 0).ball.spinMeasured, true);
    for (const t of [0, 2, 3, 255]) {
      assert.equal(toShotMessage(rawShot({ spinType: t }), 0).ball.spinMeasured, false, `spinType ${t}`);
    }
    assert.equal(toShotMessage(rawShot({ spinType: null }), 0).ball.spinMeasured, null);
  });

  test('does not mutate the raw shot', () => {
    const copy = structuredClone(FULL);
    toShotMessage(FULL, 0);
    assert.deepEqual(FULL, copy);
  });
});

describe('toStatusMessage', () => {
  test('ready state has exactly the v1 shape', () => {
    const msg = toStatusMessage({
      connected: true, ready: true, state: 'ready', error: null, batteryPct: 87, firmware: '4.40',
    });
    assert.deepEqual(msg, {
      v: 1, type: 'status', connected: true, ready: true, state: 'ready', error: null, batteryPct: 87, firmware: '4.40',
    });
    assert.deepEqual(Object.keys(msg), ['v', 'type', 'connected', 'ready', 'state', 'error', 'batteryPct', 'firmware']);
  });

  test('disconnected state with nulls', () => {
    assert.deepEqual(
      toStatusMessage({ connected: false, ready: false, state: 'disconnected', error: null, batteryPct: null, firmware: null }),
      { v: 1, type: 'status', connected: false, ready: false, state: 'disconnected', error: null, batteryPct: null, firmware: null },
    );
  });

  test('error passes through and ready stays as given', () => {
    const msg = toStatusMessage({
      connected: true, ready: false, state: 'ready', error: 'not-level', batteryPct: 55, firmware: '4.40',
    });
    assert.equal(msg.error, 'not-level');
    assert.equal(msg.ready, false);
    assert.equal(msg.state, 'ready');
  });

  test('missing optional values become null, never undefined', () => {
    const msg = toStatusMessage({ connected: false, ready: false, state: 'needs-pairing' });
    assert.equal(msg.error, null);
    assert.equal(msg.batteryPct, null);
    assert.equal(msg.firmware, null);
  });

  test('battery 0 stays 0', () => {
    const msg = toStatusMessage({ connected: true, ready: true, state: 'ready', error: null, batteryPct: 0, firmware: '' });
    assert.equal(msg.batteryPct, 0);
    assert.equal(msg.firmware, '');
  });
});
