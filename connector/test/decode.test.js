import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  FLAG,
  DecodeError,
  hasMoreData,
  decodeMeasurement,
  ShotAssembler,
  decodeStatus,
  decodeControlPoint,
} from '../src/decode.js';

const SPEED = 2 ** -8;
const ANGLE = 2 ** -14;

// Field order, sizes and signedness from the documented layout, used to build test buffers.
const LAYOUT = [
  ['BALL_SPEED', 'ballSpeedMps', 2, false],
  ['LAUNCH_ANGLE', 'launchAngleRad', 2, true],
  ['LAUNCH_DIRECTION', 'launchDirectionRad', 2, true],
  ['BACKSPIN', 'backspinRpm', 2, true],
  ['SIDESPIN', 'sidespinRpm', 2, true],
  ['CLUB_SPEED', 'clubSpeedMps', 2, false],
  ['FACE_ANGLE', 'faceAngleRad', 2, true],
  ['PATH_ANGLE', 'pathAngleRad', 2, true],
  ['ATTACK_ANGLE', 'attackAngleRad', 2, true],
  ['SPIN_TYPE', 'spinType', 1, false],
  ['SHOT_TYPE', 'shotType', 1, false],
];
const SCALE = {
  ballSpeedMps: SPEED,
  clubSpeedMps: SPEED,
  launchAngleRad: ANGLE,
  launchDirectionRad: ANGLE,
  faceAngleRad: ANGLE,
  pathAngleRad: ANGLE,
  attackAngleRad: ANGLE,
  backspinRpm: 1,
  sidespinRpm: 1,
  spinType: 1,
  shotType: 1,
};
const ALL_KEYS = ['flags', 'shotId', ...LAYOUT.map(([, key]) => key)];

// raw: { key: integer as stored on the wire }. Flags are derived from which keys are present.
function encode(shotId, raw, extraFlags = 0) {
  let flags = extraFlags;
  const parts = [];
  for (const [flag, key, size, signed] of LAYOUT) {
    if (!(key in raw)) continue;
    flags |= FLAG[flag];
    const b = Buffer.alloc(size);
    if (size === 1) b.writeUInt8(raw[key]);
    else if (signed) b.writeInt16LE(raw[key]);
    else b.writeUInt16LE(raw[key]);
    parts.push(b);
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(flags, 0);
  header.writeUInt32LE(shotId, 2);
  return Buffer.concat([header, ...parts]);
}

function expected(shotId, raw, extraFlags = 0) {
  let flags = extraFlags;
  const out = { flags: 0, shotId };
  for (const [flag, key] of LAYOUT) {
    if (key in raw) {
      flags |= FLAG[flag];
      out[key] = raw[key] * SCALE[key];
    } else {
      out[key] = null;
    }
  }
  out.flags = flags;
  return out;
}

const FULL = {
  ballSpeedMps: 15360,
  launchAngleRad: 4061,
  launchDirectionRad: -500,
  backspinRpm: 3100,
  sidespinRpm: -450,
  clubSpeedMps: 10547,
  faceAngleRad: 700,
  pathAngleRad: -400,
  attackAngleRad: -850,
  spinType: 1,
  shotType: 1,
};

describe('FLAG', () => {
  test('bits 0 through 11 in documented order', () => {
    assert.deepEqual(FLAG, {
      MORE_DATA: 0x001,
      BALL_SPEED: 0x002,
      LAUNCH_ANGLE: 0x004,
      LAUNCH_DIRECTION: 0x008,
      BACKSPIN: 0x010,
      SIDESPIN: 0x020,
      CLUB_SPEED: 0x040,
      FACE_ANGLE: 0x080,
      PATH_ANGLE: 0x100,
      ATTACK_ANGLE: 0x200,
      SPIN_TYPE: 0x400,
      SHOT_TYPE: 0x800,
    });
  });
});

describe('DecodeError', () => {
  test('is an Error named DecodeError', () => {
    const e = new DecodeError('x');
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'DecodeError');
    assert.equal(e.message, 'x');
  });
});

describe('hasMoreData', () => {
  test('empty buffer is false', () => {
    assert.equal(hasMoreData(Buffer.alloc(0)), false);
  });
  test('reads bit 0 of the first byte only', () => {
    assert.equal(hasMoreData(Buffer.from([0x01])), true);
    assert.equal(hasMoreData(Buffer.from([0xff, 0x00])), true);
    assert.equal(hasMoreData(Buffer.from([0xfe, 0xff])), false);
    assert.equal(hasMoreData(Buffer.from([0x00, 0x01])), false);
  });
});

describe('decodeMeasurement', () => {
  test('all 11 optional fields present', () => {
    const shot = decodeMeasurement(encode(1, FULL));
    assert.deepEqual(shot, expected(1, FULL));
    assert.equal(shot.flags, 0x0ffe);
    assert.equal(shot.ballSpeedMps, 60);
    assert.deepEqual(Object.keys(shot).sort(), [...ALL_KEYS].sort());
  });

  test('no optional fields: every field key present and null', () => {
    const shot = decodeMeasurement(encode(42, {}));
    assert.deepEqual(Object.keys(shot).sort(), [...ALL_KEYS].sort());
    assert.equal(shot.flags, 0);
    assert.equal(shot.shotId, 42);
    for (const [, key] of LAYOUT) assert.equal(shot[key], null, key);
  });

  test('ball-only', () => {
    const raw = { ballSpeedMps: 12800, launchAngleRad: 5500, launchDirectionRad: 0, backspinRpm: 7400, sidespinRpm: -120 };
    const shot = decodeMeasurement(encode(3, raw));
    assert.deepEqual(shot, expected(3, raw));
    assert.equal(shot.clubSpeedMps, null);
    assert.equal(shot.faceAngleRad, null);
    assert.equal(shot.pathAngleRad, null);
    assert.equal(shot.attackAngleRad, null);
  });

  test('club-only', () => {
    const raw = { clubSpeedMps: 11520, faceAngleRad: -150, pathAngleRad: 250, attackAngleRad: -400 };
    const shot = decodeMeasurement(encode(7, raw));
    assert.deepEqual(shot, expected(7, raw));
    assert.equal(shot.ballSpeedMps, null);
  });

  for (const [flag, key, size, signed] of LAYOUT) {
    test(`single flag ${flag} alone`, () => {
      const value = size === 1 ? 2 : signed ? -1234 : 40000;
      const buf = encode(9, { [key]: value });
      assert.equal(buf.length, 6 + size);
      const shot = decodeMeasurement(buf);
      assert.deepEqual(shot, expected(9, { [key]: value }));
      assert.equal(shot.flags, FLAG[flag]);
    });
  }

  test('negative angles and spins are signed', () => {
    const raw = {
      launchAngleRad: -16384,
      launchDirectionRad: -32768,
      backspinRpm: -200,
      sidespinRpm: -32768,
      faceAngleRad: -1,
      pathAngleRad: -8192,
      attackAngleRad: -1,
    };
    const shot = decodeMeasurement(encode(5, raw));
    assert.equal(shot.launchAngleRad, -1);
    assert.equal(shot.launchDirectionRad, -2);
    assert.equal(shot.backspinRpm, -200);
    assert.equal(shot.sidespinRpm, -32768);
    assert.equal(shot.faceAngleRad, -1 / 16384);
    assert.equal(shot.pathAngleRad, -0.5);
    assert.equal(shot.attackAngleRad, -1 / 16384);
  });

  test('maximum uint16 speeds are unsigned', () => {
    const shot = decodeMeasurement(encode(6, { ballSpeedMps: 0xffff, clubSpeedMps: 0xffff }));
    assert.equal(shot.ballSpeedMps, 65535 / 256);
    assert.equal(shot.clubSpeedMps, 65535 / 256);
  });

  test('uint32 shot id', () => {
    assert.equal(decodeMeasurement(encode(0xfffffffe, {})).shotId, 0xfffffffe);
  });

  test('flags keep the MORE_DATA bit as read and it adds no field', () => {
    const shot = decodeMeasurement(encode(8, { ballSpeedMps: 256 }, FLAG.MORE_DATA));
    assert.equal(shot.flags, FLAG.MORE_DATA | FLAG.BALL_SPEED);
    assert.equal(shot.ballSpeedMps, 1);
  });

  test('trailing bytes beyond the flagged fields are ignored', () => {
    const buf = Buffer.concat([encode(10, { spinType: 1 }), Buffer.from([0xaa, 0xbb])]);
    assert.deepEqual(decodeMeasurement(buf), expected(10, { spinType: 1 }));
  });

  test('shorter than 6 bytes throws DecodeError', () => {
    for (let n = 0; n < 6; n++) {
      assert.throws(() => decodeMeasurement(Buffer.alloc(n)), DecodeError, `length ${n}`);
    }
  });

  test('truncated before a promised field throws DecodeError at several lengths', () => {
    const full = encode(1, FULL);
    assert.equal(full.length, 26);
    for (const n of [6, 7, 8, 13, 17, 23, 24, 25]) {
      assert.throws(() => decodeMeasurement(full.subarray(0, n)), DecodeError, `length ${n}`);
    }
    assert.doesNotThrow(() => decodeMeasurement(full));
  });

  test('error for a truncated buffer is a DecodeError instance with name', () => {
    try {
      decodeMeasurement(Buffer.from([0x02, 0, 1, 0, 0, 0, 0x10]));
      assert.fail('should throw');
    } catch (e) {
      assert.ok(e instanceof DecodeError);
      assert.equal(e.name, 'DecodeError');
    }
  });
});

describe('ShotAssembler', () => {
  test('single-notification shot is returned', () => {
    const a = new ShotAssembler();
    assert.deepEqual(a.push(encode(1, FULL)), expected(1, FULL));
  });

  test('repeated shot id returns null; a new id is returned', () => {
    const a = new ShotAssembler();
    assert.notEqual(a.push(encode(1, FULL)), null);
    assert.equal(a.push(encode(1, FULL)), null);
    assert.equal(a.push(encode(1, {})), null);
    assert.equal(a.push(encode(2, FULL)).shotId, 2);
    assert.equal(a.push(encode(1, FULL)).shotId, 1);
  });

  test('shot id 0 is returned the first time', () => {
    const a = new ShotAssembler();
    assert.equal(a.push(encode(0, {})).shotId, 0);
    assert.equal(a.push(encode(0, {})), null);
  });

  test('a real two-notification shot merges both headers, including path and attack angle', () => {
    // Recorded from an R10: flags 0x00ff then flags 0x0f00, both for shot id 0x22996.
    const parts = ['ff0096290200ff1db0170cfb9b15fefc241c34f9', '000f962902000b05d0fa0001'].map((h) =>
      Buffer.from(h, 'hex'),
    );
    const a = new ShotAssembler();
    assert.equal(a.push(parts[0]), null);
    assert.deepEqual(
      a.push(parts[1]),
      expected(
        0x22996,
        {
          ballSpeedMps: 7679, launchAngleRad: 6064, launchDirectionRad: -1268, backspinRpm: 5531, sidespinRpm: -770,
          clubSpeedMps: 7204, faceAngleRad: -1740, pathAngleRad: 1291, attackAngleRad: -1328, spinType: 0, shotType: 1,
        },
        FLAG.MORE_DATA,
      ),
    );
  });

  test('multi-notification shot waits while each part has MORE_DATA set', () => {
    const ball = { ballSpeedMps: FULL.ballSpeedMps, launchAngleRad: FULL.launchAngleRad };
    const club = { clubSpeedMps: FULL.clubSpeedMps, faceAngleRad: FULL.faceAngleRad };
    const rest = { pathAngleRad: FULL.pathAngleRad, spinType: FULL.spinType };
    const a = new ShotAssembler();
    assert.equal(a.push(encode(2, ball, FLAG.MORE_DATA)), null);
    assert.equal(a.push(encode(2, club, FLAG.MORE_DATA)), null);
    assert.deepEqual(a.push(encode(2, rest)), expected(2, { ...ball, ...club, ...rest }, FLAG.MORE_DATA));
  });

  test('a part for a new shot id abandons the unfinished shot', () => {
    const a = new ShotAssembler();
    assert.equal(a.push(encode(1, { ballSpeedMps: 256 }, FLAG.MORE_DATA)), null);
    assert.deepEqual(a.push(encode(2, { clubSpeedMps: 512 })), expected(2, { clubSpeedMps: 512 }));
  });

  test('decode error clears the unfinished shot and propagates', () => {
    const a = new ShotAssembler();
    assert.equal(a.push(encode(5, { clubSpeedMps: 256 }, FLAG.MORE_DATA)), null);
    assert.throws(() => a.push(Buffer.from([0x00])), DecodeError);
    // The rest of shot 5 decodes on its own, with no fields left over from before the error.
    assert.deepEqual(a.push(encode(5, { ballSpeedMps: 512 })), expected(5, { ballSpeedMps: 512 }));
  });

  test('a failed decode does not change the last returned id', () => {
    const a = new ShotAssembler();
    a.push(encode(4, {}));
    assert.throws(() => a.push(Buffer.from([0x02, 0x00, 0x05, 0, 0, 0])), DecodeError);
    assert.equal(a.push(encode(4, {})), null);
  });

  test('reset discards the unfinished shot and keeps the last id', () => {
    const a = new ShotAssembler();
    assert.equal(a.push(encode(1, FULL)).shotId, 1);
    assert.equal(a.push(encode(3, { ballSpeedMps: 256 }, FLAG.MORE_DATA)), null);
    a.reset();
    assert.equal(a.push(encode(1, FULL)), null);
    assert.deepEqual(a.push(encode(3, { clubSpeedMps: 512 })), expected(3, { clubSpeedMps: 512 }));
  });
});

describe('decodeStatus', () => {
  test('ok ready and busy', () => {
    assert.deepEqual(decodeStatus(Buffer.from([0, 0, 0])), {
      type: 'ok', code: 0, state: 'ready', error: null, message: null,
    });
    assert.deepEqual(decodeStatus(Buffer.from([0, 0, 1])), {
      type: 'ok', code: 1, state: 'busy', error: null, message: null,
    });
  });

  test('ok with an unlisted code has no state', () => {
    assert.deepEqual(decodeStatus(Buffer.from([0, 0, 7])), {
      type: 'ok', code: 7, state: null, error: null, message: null,
    });
  });

  test('warn standby, and warn with another code', () => {
    assert.deepEqual(decodeStatus(Buffer.from([0, 1, 0])), {
      type: 'warn', code: 0, state: 'standby', error: null, message: null,
    });
    assert.deepEqual(decodeStatus(Buffer.from([0, 1, 5])), {
      type: 'warn', code: 5, state: null, error: null, message: null,
    });
  });

  test('error codes', () => {
    const cases = { 0: 'unknown', 1: 'overheated', 2: 'interference', 3: 'not-level' };
    for (const [code, error] of Object.entries(cases)) {
      assert.deepEqual(decodeStatus(Buffer.from([0, 2, Number(code)])), {
        type: 'error', code: Number(code), state: null, error, message: null,
      });
    }
  });

  test('unknown error code maps to unknown', () => {
    assert.deepEqual(decodeStatus(Buffer.from([0, 2, 0x42])), {
      type: 'error', code: 0x42, state: null, error: 'unknown', message: null,
    });
  });

  test('unknown status type', () => {
    assert.deepEqual(decodeStatus(Buffer.from([0, 9, 0])), {
      type: 'unknown', code: 0, state: null, error: null, message: null,
    });
  });

  test('UTF-8 message from byte 3 when flags bit 0 is set', () => {
    const text = 'Überhitzt – 50°C';
    const buf = Buffer.concat([Buffer.from([0x01, 0x02, 0x01]), Buffer.from(text, 'utf8')]);
    assert.deepEqual(decodeStatus(buf), {
      type: 'error', code: 1, state: null, error: 'overheated', message: text,
    });
  });

  test('message bit set but no message bytes gives null', () => {
    assert.equal(decodeStatus(Buffer.from([0x01, 0, 0])).message, null);
  });

  test('message bytes without the flag bit are ignored', () => {
    assert.equal(decodeStatus(Buffer.from([0x00, 0, 0, 0x41, 0x42])).message, null);
  });

  test('shorter than 3 bytes throws DecodeError', () => {
    for (let n = 0; n < 3; n++) {
      assert.throws(() => decodeStatus(Buffer.alloc(n)), DecodeError, `length ${n}`);
    }
  });
});

describe('decodeControlPoint', () => {
  test('wake response success', () => {
    assert.deepEqual(decodeControlPoint(Buffer.from([0x80, 0x00, 0x00])), {
      isResponse: true, requestOpcode: 0, result: 0, success: true,
    });
  });

  test('failure result', () => {
    assert.deepEqual(decodeControlPoint(Buffer.from([0x80, 0x00, 0x03])), {
      isResponse: true, requestOpcode: 0, result: 3, success: false,
    });
    assert.deepEqual(decodeControlPoint(Buffer.from([0x80, 0x05, 0x01, 0xff])), {
      isResponse: true, requestOpcode: 5, result: 1, success: false,
    });
  });

  const notResponse = { isResponse: false, requestOpcode: null, result: null, success: false };

  test('too short', () => {
    assert.deepEqual(decodeControlPoint(Buffer.alloc(0)), notResponse);
    assert.deepEqual(decodeControlPoint(Buffer.from([0x80])), notResponse);
    assert.deepEqual(decodeControlPoint(Buffer.from([0x80, 0x00])), notResponse);
  });

  test('not starting with 0x80', () => {
    assert.deepEqual(decodeControlPoint(Buffer.from([0x00, 0x00, 0x00])), notResponse);
    assert.deepEqual(decodeControlPoint(Buffer.from([0x81, 0x00, 0x00])), notResponse);
  });
});

describe('synthetic session fixture', () => {
  const path = fileURLToPath(new URL('./fixtures/synthetic-session.jsonl', import.meta.url));
  const packets = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));

  test('every line is in the packet log format', () => {
    for (const p of packets) {
      assert.deepEqual(Object.keys(p), ['t', 'char', 'hex']);
      assert.ok(Number.isInteger(p.t));
      assert.ok(['measurement', 'control', 'status', 'battery'].includes(p.char));
      assert.match(p.hex, /^([0-9a-f]{2})+$/);
    }
    for (let i = 1; i < packets.length; i++) assert.ok(packets[i].t >= packets[i - 1].t);
  });

  test('replays to the exact sequence of events', () => {
    const assembler = new ShotAssembler();
    const events = [];
    for (const { t, char, hex } of packets) {
      const buf = Buffer.from(hex, 'hex');
      if (char === 'measurement') {
        const shot = assembler.push(buf);
        if (shot) events.push({ t, shot });
      } else if (char === 'status') {
        events.push({ t, status: decodeStatus(buf) });
      } else if (char === 'control') {
        events.push({ t, control: decodeControlPoint(buf) });
      } else {
        events.push({ t, battery: buf.readUInt8(0) });
      }
    }

    const wake = { isResponse: true, requestOpcode: 0, result: 0, success: true };
    const ready = { type: 'ok', code: 0, state: 'ready', error: null, message: null };
    const busy = { type: 'ok', code: 1, state: 'busy', error: null, message: null };
    const T = 1761500000000;

    assert.deepEqual(events, [
      { t: T, battery: 87 },
      { t: T + 520, control: wake },
      { t: T + 560, status: ready },
      {
        t: T + 14760,
        shot: {
          flags: 0x0ffe, shotId: 1,
          ballSpeedMps: 15360 * SPEED, launchAngleRad: 4061 * ANGLE, launchDirectionRad: -500 * ANGLE,
          backspinRpm: 3100, sidespinRpm: -450,
          clubSpeedMps: 10547 * SPEED, faceAngleRad: 700 * ANGLE, pathAngleRad: -400 * ANGLE, attackAngleRad: -850 * ANGLE,
          spinType: 1, shotType: 1,
        },
      },
      { t: T + 15070, status: busy },
      { t: T + 17170, status: ready },
      {
        // Three notifications; receivedAt for this shot is the last one's t.
        t: T + 34030,
        shot: {
          flags: 0x0fff, shotId: 2,
          ballSpeedMps: 18048 * SPEED, launchAngleRad: 3000 * ANGLE, launchDirectionRad: -1023 * ANGLE,
          backspinRpm: 5200, sidespinRpm: 610,
          clubSpeedMps: 12109 * SPEED, faceAngleRad: -300 * ANGLE, pathAngleRad: -262 * ANGLE, attackAngleRad: -1200 * ANGLE,
          spinType: 0, shotType: 1,
        },
      },
      { t: T + 34310, status: busy },
      // The repeat of shot id 2 at T + 34460 produces nothing.
      { t: T + 36360, status: ready },
      {
        t: T + 57860,
        shot: {
          flags: 0x0c3e, shotId: 3,
          ballSpeedMps: 12800 * SPEED, launchAngleRad: 5500 * ANGLE, launchDirectionRad: 0,
          backspinRpm: 7400, sidespinRpm: -120,
          clubSpeedMps: null, faceAngleRad: null, pathAngleRad: null, attackAngleRad: null,
          spinType: 0, shotType: 1,
        },
      },
      { t: T + 58160, status: busy },
      { t: T + 60160, status: ready },
      { t: T + 360160, status: { type: 'warn', code: 0, state: 'standby', error: null, message: null } },
      { t: T + 360670, control: wake },
      { t: T + 360730, status: ready },
      {
        t: T + 405730,
        status: { type: 'error', code: 3, state: null, error: 'not-level', message: 'Not level – place R10 on flat ground' },
      },
      { t: T + 414730, status: ready },
      {
        t: T + 426760,
        shot: {
          flags: 0x0fff, shotId: 4,
          ballSpeedMps: 16640 * SPEED, launchAngleRad: 2200 * ANGLE, launchDirectionRad: 420 * ANGLE,
          backspinRpm: 2400, sidespinRpm: 300,
          clubSpeedMps: 11520 * SPEED, faceAngleRad: 150 * ANGLE, pathAngleRad: 250 * ANGLE, attackAngleRad: 400 * ANGLE,
          spinType: 2, shotType: 1,
        },
      },
      { t: T + 427010, status: busy },
      { t: T + 429010, status: ready },
      { t: T + 489010, battery: 86 },
    ]);
  });

  test('multi-notification shots set MORE_DATA on every part but the last', () => {
    const measurement = packets.filter((p) => p.char === 'measurement').map((p) => Buffer.from(p.hex, 'hex'));
    assert.deepEqual(measurement.map(hasMoreData), [false, true, true, false, false, false, true, false]);
  });
});

describe('recorded session fixture', () => {
  const path = fileURLToPath(new URL('./fixtures/recorded-session.jsonl', import.meta.url));
  const measurements = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
    .filter((p) => p.char === 'measurement');

  test('every full shot has path and attack angle; club-only reads have no ball fields', () => {
    const assembler = new ShotAssembler();
    const shots = measurements.map((p) => assembler.push(Buffer.from(p.hex, 'hex'))).filter(Boolean);
    assert.deepEqual(
      shots.map((s) => [s.shotId, s.flags]),
      [[0x1e09b, 0x0840], [0x1edad, 0x0840], [0x22996, 0x0fff], [0x2af24, 0x0fff], [0x2f8e4, 0x0fff]],
    );
    for (const shot of shots.slice(0, 2)) {
      assert.equal(shot.ballSpeedMps, null);
      assert.equal(shot.pathAngleRad, null);
      assert.notEqual(shot.clubSpeedMps, null);
    }
    for (const shot of shots.slice(2)) {
      for (const [, key] of LAYOUT) assert.notEqual(shot[key], null, `${key} of shot ${shot.shotId}`);
    }
  });
});
