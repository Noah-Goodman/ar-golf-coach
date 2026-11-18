// Pure conversion of decoded R10 data into v1 JSON messages for the headset. No I/O.

export const PROTOCOL_VERSION = 1;
export const MPS_TO_MPH = 2.236936;

// Multiplier applied to each raw value. For the three angles the goal is positive = right of
// the target line, seen from behind the ball. The R10 sends all three with positive = left
// (checked on hardware, right-handed: face and path showed mirrored in the headset, and the raw
// launch direction matches 0.75 x face + 0.25 x path in sign on every logged shot), so all three
// are negated. sidespin is negated so that positive = the ball curves right: the raw sidespin has
// the same sign as raw face minus path on every logged shot, and that difference is positive when
// the ball curves left.
export const SIGN = { launchDirection: -1, faceAngle: -1, pathAngle: -1, sidespin: -1 };

const RAD_TO_DEG = 180 / Math.PI;

// Rounds half away from zero so that round2(-x) === -round2(x), and never returns -0.
function round2(value) {
  const rounded = (Math.sign(value) * Math.round(Math.abs(value) * 100)) / 100;
  return rounded + 0;
}

function speedMph(mps) {
  return mps === null ? null : round2(mps * MPS_TO_MPH);
}

function angleDeg(rad, sign = 1) {
  return rad === null ? null : round2(sign * rad * RAD_TO_DEG);
}

function spin(rpm, sign = 1) {
  return rpm === null ? null : sign * rpm + 0;
}

export function toShotMessage(raw, receivedAt) {
  return {
    v: PROTOCOL_VERSION,
    type: 'shot',
    shotId: raw.shotId,
    receivedAt,
    ball: {
      speedMph: speedMph(raw.ballSpeedMps),
      launchAngleDeg: angleDeg(raw.launchAngleRad),
      launchDirectionDeg: angleDeg(raw.launchDirectionRad, SIGN.launchDirection),
      backspinRpm: spin(raw.backspinRpm),
      sidespinRpm: spin(raw.sidespinRpm, SIGN.sidespin),
      spinMeasured: raw.spinType === null ? null : raw.spinType === 1,
    },
    club: {
      speedMph: speedMph(raw.clubSpeedMps),
      faceAngleDeg: angleDeg(raw.faceAngleRad, SIGN.faceAngle),
      pathAngleDeg: angleDeg(raw.pathAngleRad, SIGN.pathAngle),
      attackAngleDeg: angleDeg(raw.attackAngleRad),
    },
  };
}

export function toStatusMessage(deviceState) {
  return {
    v: PROTOCOL_VERSION,
    type: 'status',
    connected: deviceState.connected,
    ready: deviceState.ready,
    state: deviceState.state,
    error: deviceState.error ?? null,
    batteryPct: deviceState.batteryPct ?? null,
    firmware: deviceState.firmware ?? null,
  };
}
