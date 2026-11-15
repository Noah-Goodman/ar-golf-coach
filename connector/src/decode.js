// Pure decoders for the Garmin Approach R10 BLE characteristics. No I/O.

export const FLAG = {
  MORE_DATA: 1 << 0,
  BALL_SPEED: 1 << 1,
  LAUNCH_ANGLE: 1 << 2,
  LAUNCH_DIRECTION: 1 << 3,
  BACKSPIN: 1 << 4,
  SIDESPIN: 1 << 5,
  CLUB_SPEED: 1 << 6,
  FACE_ANGLE: 1 << 7,
  PATH_ANGLE: 1 << 8,
  ATTACK_ANGLE: 1 << 9,
  SPIN_TYPE: 1 << 10,
  SHOT_TYPE: 1 << 11,
};

export class DecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DecodeError';
  }
}

const SPEED_SCALE = 2 ** -8; // uint16 -> m/s
const ANGLE_SCALE = 2 ** -14; // int16 -> rad

// Optional measurement fields in flag-bit order. Each is read at a running offset
// only when its bit is set.
const FIELDS = [
  { bit: FLAG.BALL_SPEED, key: 'ballSpeedMps', size: 2, read: (b, o) => b.readUInt16LE(o) * SPEED_SCALE },
  { bit: FLAG.LAUNCH_ANGLE, key: 'launchAngleRad', size: 2, read: (b, o) => b.readInt16LE(o) * ANGLE_SCALE },
  { bit: FLAG.LAUNCH_DIRECTION, key: 'launchDirectionRad', size: 2, read: (b, o) => b.readInt16LE(o) * ANGLE_SCALE },
  { bit: FLAG.BACKSPIN, key: 'backspinRpm', size: 2, read: (b, o) => b.readInt16LE(o) },
  { bit: FLAG.SIDESPIN, key: 'sidespinRpm', size: 2, read: (b, o) => b.readInt16LE(o) },
  { bit: FLAG.CLUB_SPEED, key: 'clubSpeedMps', size: 2, read: (b, o) => b.readUInt16LE(o) * SPEED_SCALE },
  { bit: FLAG.FACE_ANGLE, key: 'faceAngleRad', size: 2, read: (b, o) => b.readInt16LE(o) * ANGLE_SCALE },
  { bit: FLAG.PATH_ANGLE, key: 'pathAngleRad', size: 2, read: (b, o) => b.readInt16LE(o) * ANGLE_SCALE },
  { bit: FLAG.ATTACK_ANGLE, key: 'attackAngleRad', size: 2, read: (b, o) => b.readInt16LE(o) * ANGLE_SCALE },
  { bit: FLAG.SPIN_TYPE, key: 'spinType', size: 1, read: (b, o) => b.readUInt8(o) },
  { bit: FLAG.SHOT_TYPE, key: 'shotType', size: 1, read: (b, o) => b.readUInt8(o) },
];

const HEADER_LENGTH = 6; // uint16 flags + uint32 shot id

// True when bit 0 of this notification's first byte is set.
export function hasMoreData(notification) {
  return notification.length > 0 && (notification[0] & FLAG.MORE_DATA) !== 0;
}

export function decodeMeasurement(buffer) {
  if (buffer.length < HEADER_LENGTH) {
    throw new DecodeError(`measurement too short: ${buffer.length} bytes, need at least ${HEADER_LENGTH}`);
  }
  const flags = buffer.readUInt16LE(0);
  const shot = { flags, shotId: buffer.readUInt32LE(2) };
  let offset = HEADER_LENGTH;
  for (const field of FIELDS) {
    if ((flags & field.bit) === 0) {
      shot[field.key] = null;
      continue;
    }
    if (offset + field.size > buffer.length) {
      throw new DecodeError(
        `measurement ends at ${buffer.length} bytes before ${field.key} at offset ${offset} (flags 0x${flags.toString(16)})`,
      );
    }
    shot[field.key] = field.read(buffer, offset);
    offset += field.size;
  }
  return shot;
}

// Fields of `part` that are present overwrite those of `base`; flags are ORed together.
function mergeParts(base, part) {
  const merged = { ...base, flags: base.flags | part.flags };
  for (const field of FIELDS) {
    if (part[field.key] !== null) merged[field.key] = part[field.key];
  }
  return merged;
}

// The R10 can split one shot across several notifications. Each notification is a complete
// measurement with its own flags and shot id, carrying a subset of the fields; MORE_DATA in its
// flags means another notification for the same shot follows. A real shot arrives as
// flags 0x00ff (ball fields, club speed, face angle) then flags 0x0f00 (path, attack, spin type,
// shot type). The parts must be decoded one by one: concatenating the bytes and decoding once
// reads only the first header's flags and drops every field in the later notifications.
export class ShotAssembler {
  #pending = null;
  #lastShotId = null;

  push(notification) {
    let part;
    try {
      part = decodeMeasurement(notification);
    } catch (err) {
      this.#pending = null;
      throw err;
    }

    // A part for a different shot id abandons the unfinished one.
    const shot = this.#pending?.shotId === part.shotId ? mergeParts(this.#pending, part) : part;
    if (part.flags & FLAG.MORE_DATA) {
      this.#pending = shot;
      return null;
    }

    this.#pending = null;
    if (shot.shotId === this.#lastShotId) return null;
    this.#lastShotId = shot.shotId;
    return shot;
  }

  reset() {
    this.#pending = null;
  }
}

const STATUS_TYPES = { 0x00: 'ok', 0x01: 'warn', 0x02: 'error' };
const ERROR_CODES = { 0x00: 'unknown', 0x01: 'overheated', 0x02: 'interference', 0x03: 'not-level' };

export function decodeStatus(buffer) {
  if (buffer.length < 3) {
    throw new DecodeError(`status too short: ${buffer.length} bytes, need at least 3`);
  }
  const hasMessage = (buffer[0] & 0x01) !== 0;
  const type = STATUS_TYPES[buffer[1]] ?? 'unknown';
  const code = buffer[2];

  let state = null;
  if (type === 'ok' && code === 0x00) state = 'ready';
  else if (type === 'ok' && code === 0x01) state = 'busy';
  else if (type === 'warn' && code === 0x00) state = 'standby';

  const error = type === 'error' ? (ERROR_CODES[code] ?? 'unknown') : null;
  const message = hasMessage && buffer.length > 3 ? buffer.toString('utf8', 3) : null;

  return { type, code, state, error, message };
}

const CONTROL_RESPONSE = 0x80;

export function decodeControlPoint(buffer) {
  if (!buffer || buffer.length < 3 || buffer[0] !== CONTROL_RESPONSE) {
    return { isResponse: false, requestOpcode: null, result: null, success: false };
  }
  const result = buffer[2];
  return { isResponse: true, requestOpcode: buffer[1], result, success: result === 0x00 };
}
