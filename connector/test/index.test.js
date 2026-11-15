import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatShotLine, formatStatusLine } from '../src/index.js';
import { decodeMeasurement } from '../src/decode.js';
import { toShotMessage, SIGN } from '../src/toMessage.js';

const fullShot = {
  v: 1,
  type: 'shot',
  shotId: 7,
  receivedAt: 1,
  ball: {
    speedMph: 132.44,
    launchAngleDeg: 14.2,
    launchDirectionDeg: 1.8,
    backspinRpm: 3100,
    sidespinRpm: -450,
    spinMeasured: true,
  },
  club: { speedMph: 92.1, faceAngleDeg: 2.5, pathAngleDeg: -1.5, attackAngleDeg: -3 },
};

test('formatShotLine shows every ball and club value', () => {
  assert.equal(
    formatShotLine(fullShot),
    'Shot 7: ball 132.4 mph, launch 14.2°, direction +1.8°, backspin 3100 rpm, sidespin -450 rpm (measured) | ' +
      'club 92.1 mph, face +2.5°, path -1.5°, attack -3.0°',
  );
});

test('formatShotLine says so when the R10 sent no club data', () => {
  const club = { speedMph: null, faceAngleDeg: null, pathAngleDeg: null, attackAngleDeg: null };
  const line = formatShotLine({ ...fullShot, ball: { ...fullShot.ball, spinMeasured: false }, club });
  assert.match(line, /sidespin -450 rpm \(estimated\) \| club not captured$/);
});

test('formatShotLine says so when the R10 sent no ball data', () => {
  const ball = {
    speedMph: null,
    launchAngleDeg: null,
    launchDirectionDeg: null,
    backspinRpm: null,
    sidespinRpm: null,
    spinMeasured: null,
  };
  const club = { speedMph: 80.5, faceAngleDeg: null, pathAngleDeg: null, attackAngleDeg: null };
  assert.equal(
    formatShotLine({ ...fullShot, ball, club }),
    'Shot 7: ball not captured | club 80.5 mph, face -, path -, attack -',
  );
});

test('formatShotLine prints a dash for a single missing value', () => {
  const line = formatShotLine({ ...fullShot, ball: { ...fullShot.ball, backspinRpm: null, spinMeasured: null } });
  assert.match(line, /backspin -, sidespin -450 rpm \|/);
});

// A ball-only shot recorded from an R10 on firmware 4.50: flags 0x0c3e carry the five ball
// fields plus spin type and shot type, and none of the four club fields.
test('a recorded ball-only shot formats with its spin and no club data', () => {
  const raw = decodeMeasurement(Buffer.from('3e0cc7a20800210b4b16d0fff80c00000001', 'hex'));
  assert.equal(raw.clubSpeedMps, null);
  assert.equal(raw.backspinRpm, 3320);
  assert.equal(raw.spinType, 0);
  assert.equal(raw.shotType, 1);
  const direction = SIGN.launchDirection > 0 ? '-0.2°' : '+0.2°';
  assert.equal(
    formatShotLine(toShotMessage(raw, 1)),
    `Shot 565959: ball 24.9 mph, launch 20.0°, direction ${direction}, backspin 3320 rpm, sidespin 0 rpm (estimated) | club not captured`,
  );
});

test('formatStatusLine copes with missing battery and firmware', () => {
  assert.equal(
    formatStatusLine({ state: 'scanning', error: null, batteryPct: null, firmware: null }),
    'R10 scanning, battery -, firmware -',
  );
  assert.equal(
    formatStatusLine({ state: 'ready', error: 'not-level', batteryPct: 86, firmware: '4.50' }),
    'R10 ready, error not-level, battery 86%, firmware 4.50',
  );
});
