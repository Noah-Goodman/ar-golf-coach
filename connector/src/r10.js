import { EventEmitter } from 'node:events';
import { ShotAssembler, decodeStatus, decodeControlPoint } from './decode.js';

// noble reports UUIDs lowercase without dashes.
const UUID = {
  measurement: '6a4e3401667b11e3949a0800200c9a66',
  control: '6a4e3402667b11e3949a0800200c9a66',
  status: '6a4e3403667b11e3949a0800200c9a66',
  secure: '6a4e2812667b11e3949a0800200c9a66',
  battery: '2a19',
  firmware: '2a28',
};

// The order OpenGolfSim's working connector subscribes in. Whether the R10 requires it is unknown.
const SUBSCRIBE_ORDER = ['control', 'status', 'measurement', 'battery'];

const PAIRING_NAME = /garmin|approach/i;
const WAKE = Buffer.from([0x00]);

// Bounds on single Bluetooth operations. CoreBluetooth never times out a connect on its own,
// and noble's disconnect/read promises never settle if the binding has nothing to act on.
const DEFAULT_TIMEOUTS = {
  connectTimeoutMs: 15000,
  opTimeoutMs: 10000,
  // How long one pairing attempt keeps the link up and repeats the secure read; covers the time
  // the user needs to accept the macOS pairing prompt.
  secureReadTimeoutMs: 60000,
  teardownTimeoutMs: 2000,
};

const NEVER = new Promise(() => {});

const DISCONNECTED_FIELDS = { connected: false, error: null, batteryPct: null, firmware: null };

class AttemptEnded extends Error {
  constructor(reason) {
    super(reason === 'stopped' ? 'stopped' : 'R10 disconnected');
    this.name = 'AttemptEnded';
    this.reason = reason;
  }
}

export function normaliseId(id) {
  if (id === null || id === undefined) return '';
  return String(id).toLowerCase().replace(/[:-]/g, '');
}

function uuidOf(characteristic) {
  return String(characteristic?.uuid ?? '').toLowerCase().replace(/-/g, '');
}

function errorMessage(err) {
  return err?.message ?? String(err);
}

export class R10 extends EventEmitter {
  constructor(options = {}) {
    super();
    this._id = normaliseId(options.r10Id);
    this._noble = options.noble ?? null;
    this._ownsNoble = false;
    this._wakeDelayMs = options.wakeDelayMs ?? 500;
    this._retryDelayMs = options.retryDelayMs ?? 2000;
    this._pairRetryMs = options.pairRetryMs ?? 1500;
    this._now = options.now ?? Date.now;
    this._timeouts = {};
    for (const [key, value] of Object.entries(DEFAULT_TIMEOUTS)) {
      this._timeouts[key] = options[key] ?? value;
    }

    this._assembler = new ShotAssembler();
    this._state = {
      connected: false,
      ready: false,
      state: 'disconnected',
      error: null,
      batteryPct: null,
      firmware: null,
    };

    this._started = false;
    this._stopped = false;
    this._stopping = null;
    this._loop = null;
    this._attempt = null;
    this._sleep = null;
    this._pairingAnnounced = false;
    this._refusalAnnounced = false;
  }

  get state() {
    return { ...this._state };
  }

  async start() {
    if (this._started) return;
    this._started = true;
    this._loop = this._run();
  }

  stop() {
    if (!this._stopping) {
      this._stopping = this._shutdown();
    }
    return this._stopping;
  }

  async _shutdown() {
    this._stopped = true;
    if (this._sleep) this._sleep.cancel();
    if (this._attempt) this._attempt.end('stopped');
    if (this._loop) await this._loop;
    if (this._ownsNoble && this._noble) {
      try {
        this._noble.stop();
      } catch {
        // The binding may already be gone.
      }
      this._noble.removeAllListeners('warning');
      this._noble = null;
      this._ownsNoble = false;
    }
    this._setState({ ...DISCONNECTED_FIELDS, state: 'disconnected' });
  }

  // ---- lifecycle loop -------------------------------------------------------------------------

  // The only owner of the connection lifecycle. Every attempt (pairing or connect) is torn down
  // here exactly once before the next one begins.
  async _run() {
    while (!this._stopped) {
      const attempt = this._newAttempt();
      let outcome;
      try {
        const noble = await this._getNoble();
        attempt.noble = noble;
        outcome = this._id ? await this._connectAndRun(attempt) : await this._pair(attempt);
      } catch (err) {
        outcome = err;
      }
      await this._teardown(attempt);
      this._attempt = null;
      if (this._stopped) break;

      if (outcome === 'paired') {
        this._setState({ ...DISCONNECTED_FIELDS, state: 'scanning' });
        continue;
      }

      // A disconnect can surface either as our own AttemptEnded or as noble rejecting the
      // operation that was in flight; both are the same event.
      const dropped = outcome instanceof AttemptEnded || attempt.endReason === 'disconnected';
      if (dropped && attempt.bondRequested) {
        // An R10 that is not in pairing mode answers the system's pairing request by hanging up.
        if (!this._refusalAnnounced) {
          this._refusalAnnounced = true;
          this._log(
            'warn',
            'The R10 dropped the connection as soon as macOS asked to pair, which is what it does when it is ' +
              'not in pairing mode. Hold its power button until the light is SOLID blue (flashing blue means ' +
              'it is trying to reconnect to a phone it already knows), and turn Bluetooth off on that phone. ' +
              'Retrying until it accepts.',
          );
        } else {
          this._log('info', 'R10 refused pairing again');
        }
      } else if (dropped) {
        this._log('info', 'R10 disconnected');
      } else if (attempt.kind === 'pair') {
        this._log('warn', `Pairing not finished: ${errorMessage(outcome)}. Retrying.`);
      } else {
        this._log('warn', `R10 connection failed: ${errorMessage(outcome)}. Retrying.`);
      }

      if (attempt.reachedConnect && attempt.kind === 'connect') {
        this._setState({ ...DISCONNECTED_FIELDS, state: 'disconnected' });
        this._setState({ state: 'scanning' });
      }

      await this._delayLoop(this._retryDelayMs);
    }
  }

  async _getNoble() {
    if (this._noble) return this._noble;
    // Loaded here so that importing this module never loads the native Bluetooth binding.
    const mod = await import('@stoprocent/noble');
    const withBindings = mod.withBindings ?? mod.default?.withBindings;
    const noble = withBindings('default');
    // noble prints its own warnings to the console by default; route them through 'log'.
    noble.removeAllListeners('warning');
    noble.on('warning', (message) => this._log('warn', `noble: ${message}`));
    this._noble = noble;
    this._ownsNoble = true;
    return noble;
  }

  _newAttempt() {
    let rejectEnded;
    const attempt = {
      kind: this._id ? 'connect' : 'pair',
      noble: null,
      peripheral: null,
      chars: {},
      dataListeners: [],
      disconnectListener: null,
      timers: new Set(),
      wakeTimer: null,
      reachedConnect: false,
      bondRequested: false,
      closed: false,
      endReason: null,
      ended: new Promise((_, reject) => {
        rejectEnded = reject;
      }),
      end: (reason) => {
        if (attempt.endReason) return;
        attempt.endReason = reason;
        rejectEnded(new AttemptEnded(reason));
      },
    };
    attempt.ended.catch(() => {});
    this._attempt = attempt;
    if (this._stopped) attempt.end('stopped');
    return attempt;
  }

  // Waits for `promise`, but gives up as soon as the attempt ends (disconnect or stop) or after
  // `timeoutMs` (0 = no limit). With a null attempt only the timeout applies. The timer is always
  // cleared, so nothing fires later.
  async _step(attempt, promise, timeoutMs, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
        timer.unref?.();
      }
    });
    try {
      return await Promise.race([promise, attempt ? attempt.ended : NEVER, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  _delay(attempt, ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        attempt.timers.delete(timer);
        resolve();
      }, ms);
      attempt.timers.add(timer);
    });
  }

  // Retry pause between attempts; stop() cancels it.
  _delayLoop(ms) {
    if (this._stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._sleep = null;
        resolve();
      }, ms);
      this._sleep = {
        cancel: () => {
          clearTimeout(timer);
          this._sleep = null;
          resolve();
        },
      };
    });
  }

  // ---- shared steps ---------------------------------------------------------------------------

  async _poweredOn(attempt) {
    try {
      await this._step(attempt, attempt.noble.waitForPoweredOnAsync(), 0, 'power on');
    } catch (err) {
      if (err instanceof AttemptEnded) throw err;
      throw new Error(`Bluetooth is not powered on (${errorMessage(err)})`);
    }
  }

  // Scans until `match(peripheral)` is true. noble's discoverAsync() only ends when scanning is
  // stopped or the adapter leaves poweredOn; stopScanningAsync() is what releases a pending
  // iteration, so it runs on every exit path, including stop() and disconnect.
  async _scanFor(attempt, match) {
    const noble = attempt.noble;
    await this._step(attempt, noble.startScanningAsync(), this._timeouts.opTimeoutMs, 'start scanning');
    const iterator = noble.discoverAsync();
    try {
      for (;;) {
        const { value, done } = await this._step(attempt, iterator.next(), 0, 'scan');
        if (done) throw new Error('scanning ended before the R10 was found');
        if (match(value)) return value;
      }
    } finally {
      try {
        await this._step(
          null,
          noble.stopScanningAsync(),
          this._timeouts.teardownTimeoutMs,
          'stop scanning',
        );
      } catch (err) {
        this._log('warn', `Could not stop scanning: ${errorMessage(err)}`);
      }
      // Once scanning has stopped the generator is finished or parked at a yield, so this
      // settles promptly; it is not awaited in case the binding never reported the stop.
      Promise.resolve()
        .then(() => iterator.return())
        .catch(() => {});
    }
  }

  async _connectPeripheral(attempt, peripheral) {
    attempt.peripheral = peripheral;
    attempt.disconnectListener = () => attempt.end('disconnected');
    peripheral.on('disconnect', attempt.disconnectListener);
    attempt.reachedConnect = true;
    await this._step(attempt, peripheral.connectAsync(), this._timeouts.connectTimeoutMs, 'connect');
  }

  async _discover(attempt) {
    const result = await this._step(
      attempt,
      attempt.peripheral.discoverAllServicesAndCharacteristicsAsync(),
      this._timeouts.opTimeoutMs,
      'service discovery',
    );
    const found = {};
    for (const characteristic of result?.characteristics ?? []) {
      const uuid = uuidOf(characteristic);
      for (const [name, wanted] of Object.entries(UUID)) {
        if (uuid === wanted && !found[name]) found[name] = characteristic;
      }
    }
    return found;
  }

  // ---- pairing --------------------------------------------------------------------------------

  async _pair(attempt) {
    this._setState({ ...DISCONNECTED_FIELDS, state: 'needs-pairing' });
    if (!this._pairingAnnounced) {
      this._pairingAnnounced = true;
      this._log(
        'info',
        'No saved R10. Put the R10 in pairing mode (solid blue light) and accept the macOS pairing prompt.',
      );
    } else {
      this._log('info', 'Looking for an R10 in pairing mode');
    }

    await this._poweredOn(attempt);
    const peripheral = await this._scanFor(attempt, (p) =>
      PAIRING_NAME.test(p?.advertisement?.localName ?? ''),
    );
    this._log('info', `Found ${peripheral.advertisement.localName} (${normaliseId(peripheral.id)}); connecting to pair`);
    await this._connectPeripheral(attempt, peripheral);
    const chars = await this._discover(attempt);
    if (!chars.secure) throw new Error('secure characteristic not found');

    await this._bond(attempt, chars.secure);

    const id = normaliseId(peripheral.id);
    this._id = id;
    this.emit('paired', id);
    return 'paired';
  }

  // Reads the secure characteristic until the read succeeds. On macOS the first read of an
  // unbonded R10 is rejected with "Encryption is insufficient", and that rejection is what makes
  // the system start bonding. Don't disconnect on a rejected read: dropping the link cancels the
  // bonding macOS has just begun. The link stays up and the read is repeated until it goes
  // through or secureReadTimeoutMs has passed.
  async _bond(attempt, secure) {
    const deadline = Date.now() + this._timeouts.secureReadTimeoutMs;
    let announced = false;
    for (;;) {
      const remaining = deadline - Date.now();
      try {
        await this._step(attempt, secure.readAsync(), Math.max(remaining, 1), 'secure read');
        return;
      } catch (err) {
        if (err instanceof AttemptEnded) throw err;
        if (Date.now() + this._pairRetryMs >= deadline) {
          throw new Error(`secure read rejected (${errorMessage(err)})`);
        }
        attempt.bondRequested = true;
        if (!announced) {
          announced = true;
          this._log(
            'info',
            `R10 asked for an encrypted link (${errorMessage(err)}). Waiting for macOS to pair: accept the pairing prompt if one appears.`,
          );
        }
        await this._step(attempt, this._delay(attempt, this._pairRetryMs), 0, 'pairing wait');
      }
    }
  }

  // ---- connect and run ------------------------------------------------------------------------

  async _connectAndRun(attempt) {
    this._setState({ state: 'scanning' });
    this._log('info', `Scanning for R10 ${this._id}`);
    await this._poweredOn(attempt);
    const peripheral = await this._scanFor(attempt, (p) => normaliseId(p?.id) === this._id);

    this._log('info', 'R10 found, connecting');
    this._setState({ state: 'connecting' });
    await this._connectPeripheral(attempt, peripheral);
    this._setState({ connected: true });

    const chars = await this._discover(attempt);
    const missing = ['measurement', 'control', 'status', 'battery', 'firmware'].filter((n) => !chars[n]);
    if (missing.length > 0) throw new Error(`missing characteristics: ${missing.join(', ')}`);
    attempt.chars = chars;

    const batteryData = await this._step(attempt, chars.battery.readAsync(), this._timeouts.opTimeoutMs, 'battery read');
    const firmwareData = await this._step(attempt, chars.firmware.readAsync(), this._timeouts.opTimeoutMs, 'firmware read');
    const batteryPct = Buffer.isBuffer(batteryData) && batteryData.length >= 1 ? batteryData.readUInt8(0) : null;
    let firmware = Buffer.isBuffer(firmwareData) ? firmwareData.toString('utf8').replace(/[\0\s]+$/, '') : '';
    if (firmware === '') firmware = null;
    this._setState({ batteryPct, firmware });

    for (const name of SUBSCRIBE_ORDER) {
      const characteristic = chars[name];
      // Every 'data' event is handled: reads all complete before these listeners exist, and the
      // macOS binding's isNotification flag is unreliable while any read is pending.
      const listener = (data) => {
        if (Buffer.isBuffer(data)) this._onNotification(attempt, name, data);
      };
      characteristic.on('data', listener);
      attempt.dataListeners.push({ characteristic, listener });
    }
    for (const name of SUBSCRIBE_ORDER) {
      await this._step(attempt, chars[name].subscribeAsync(), this._timeouts.opTimeoutMs, `subscribe ${name}`);
    }

    await this._step(attempt, this._delay(attempt, this._wakeDelayMs), 0, 'wake delay');
    await this._writeWake(attempt);
    this._log('info', 'R10 connected');

    // Runs until a disconnect or stop() ends the attempt.
    await attempt.ended;
  }

  async _writeWake(attempt) {
    if (attempt.endReason || attempt.closed) return;
    await this._step(attempt, attempt.chars.control.writeAsync(WAKE, false), this._timeouts.opTimeoutMs, 'wake');
  }

  _scheduleWake(attempt) {
    if (attempt.wakeTimer) return;
    const timer = setTimeout(() => {
      attempt.timers.delete(timer);
      attempt.wakeTimer = null;
      if (attempt.endReason || attempt.closed) return;
      this._writeWake(attempt).catch((err) => {
        if (!(err instanceof AttemptEnded)) this._log('warn', `Wake failed: ${errorMessage(err)}`);
      });
    }, this._wakeDelayMs);
    attempt.wakeTimer = timer;
    attempt.timers.add(timer);
  }

  // ---- notifications --------------------------------------------------------------------------

  _onNotification(attempt, char, data) {
    if (attempt.closed) return;
    const t = this._now();
    try {
      this.emit('packet', { t, char, hex: data.toString('hex') });
      switch (char) {
        case 'measurement':
          this._onMeasurement(data, t);
          break;
        case 'status':
          this._onStatus(attempt, data);
          break;
        case 'control':
          this._onControl(data);
          break;
        case 'battery':
          if (data.length >= 1) this._setState({ batteryPct: data.readUInt8(0) });
          break;
      }
    } catch (err) {
      this._log('error', `Error handling ${char} notification ${data.toString('hex')}: ${errorMessage(err)}`);
    }
  }

  _onMeasurement(data, t) {
    let raw;
    try {
      raw = this._assembler.push(data);
    } catch (err) {
      this._log('warn', `Could not decode measurement ${data.toString('hex')}: ${errorMessage(err)}`);
      return;
    }
    if (raw) this.emit('shot', { raw, receivedAt: t });
  }

  _onStatus(attempt, data) {
    let status;
    try {
      status = decodeStatus(data);
    } catch (err) {
      this._log('warn', `Could not decode status ${data.toString('hex')}: ${errorMessage(err)}`);
      return;
    }
    if (status.message) this._log('info', `R10 status message: ${status.message}`);

    if (status.type === 'ok' && status.state) {
      this._setState({ state: status.state, error: null });
    } else if (status.type === 'warn' && status.state === 'standby') {
      this._setState({ state: 'standby' });
      this._scheduleWake(attempt);
    } else if (status.type === 'error') {
      this._setState({ error: status.error ?? 'unknown' });
    } else {
      this._log('info', `Unhandled R10 status ${data.toString('hex')}`);
    }
  }

  _onControl(data) {
    const response = decodeControlPoint(data);
    if (!response.isResponse) {
      this._log('info', `Control notification ${data.toString('hex')}`);
    } else if (response.success) {
      this._log('info', `Control request 0x${response.requestOpcode.toString(16).padStart(2, '0')} succeeded`);
    } else {
      this._log(
        'warn',
        `Control request 0x${response.requestOpcode.toString(16).padStart(2, '0')} failed with result 0x${response.result.toString(16).padStart(2, '0')}`,
      );
    }
  }

  // ---- teardown -------------------------------------------------------------------------------

  async _teardown(attempt) {
    attempt.closed = true;
    for (const timer of attempt.timers) clearTimeout(timer);
    attempt.timers.clear();
    attempt.wakeTimer = null;

    for (const { characteristic, listener } of attempt.dataListeners) {
      characteristic.removeListener('data', listener);
    }
    attempt.dataListeners = [];
    attempt.chars = {};

    const peripheral = attempt.peripheral;
    if (peripheral) {
      if (attempt.disconnectListener) {
        peripheral.removeListener('disconnect', attempt.disconnectListener);
        attempt.disconnectListener = null;
      }
      try {
        if (peripheral.state === 'connecting' && typeof peripheral.cancelConnect === 'function') {
          peripheral.cancelConnect();
        } else if (peripheral.state === 'connected') {
          await this._step(
            null,
            peripheral.disconnectAsync(),
            this._timeouts.teardownTimeoutMs,
            'disconnect',
          );
        }
      } catch (err) {
        this._log('warn', `Could not disconnect cleanly: ${errorMessage(err)}`);
      }
      attempt.peripheral = null;
    }

    this._assembler.reset();
  }

  // ---- state and logging ----------------------------------------------------------------------

  _setState(patch) {
    const next = { ...this._state, ...patch };
    next.ready = next.state === 'ready' && next.error === null;
    const changed = Object.keys(next).some((key) => next[key] !== this._state[key]);
    if (!changed) return;
    this._state = next;
    this.emit('status', { ...next });
  }

  _log(level, message) {
    this.emit('log', { level, message });
  }
}
