import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';

const RUN_TIMEOUT_MS = 10_000;

// Runs a command and resolves { stdout }. The timeout keeps a hung adb from stalling polling.
function defaultRun(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: RUN_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        // execFile's message already names the command; stderr carries adb's own explanation.
        const detail = String(stderr ?? '').trim();
        if (detail && !err.message.includes(detail)) err.message = `${err.message.trim()}: ${detail}`;
        reject(err);
      } else {
        resolve({ stdout: String(stdout) });
      }
    });
  });
}

// Parses `adb devices` output into [{ serial, state }]. Skips the header, blank lines and the
// "* daemon ..." lines adb prints while starting its server. Serial and state are tab-separated
// in practice; whitespace separation is accepted too.
export function parseDevices(stdout) {
  const devices = [];
  for (const rawLine of String(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('*') || /^List of devices attached/i.test(line)) continue;
    let serial;
    let rest;
    const tab = line.indexOf('\t');
    if (tab >= 0) {
      serial = line.slice(0, tab).trim();
      rest = line.slice(tab + 1).trim();
    } else {
      [serial, rest = ''] = line.split(/\s+(.*)/s);
    }
    const state = rest.split(/\s+/)[0];
    if (serial && state) devices.push({ serial, state });
  }
  return devices;
}

// True when `adb reverse --list` output has a line forwarding device tcp:<port> to host tcp:<port>.
// Lines look like "<transport> tcp:8765 tcp:8765".
export function hasReverse(stdout, port) {
  const pattern = new RegExp(`(^|\\s)tcp:${port}\\s+tcp:${port}(\\s|$)`);
  return String(stdout).split(/\r?\n/).some((line) => pattern.test(line.trim()));
}

class AdbReverse extends EventEmitter {
  #port;
  #intervalMs;
  #adbPath;
  #run;
  #running = false;
  #generation = 0;
  #timer = null;
  #inFlight = null;
  #devices = [];
  #unauthorized = new Set();
  #adbMissing = false;
  // Failure messages already logged, keyed by what failed, so a repeating failure logs once.
  #failures = new Map();

  constructor({ port, intervalMs = 2000, adbPath = 'adb', run = defaultRun }) {
    super();
    this.#port = port;
    this.#intervalMs = intervalMs;
    this.#adbPath = adbPath;
    this.#run = run;
  }

  get devices() {
    return [...this.#devices];
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#loop(++this.#generation);
  }

  stop() {
    this.#running = false;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  // Runs one poll. A call while a poll is in progress returns that poll instead of starting another.
  // Never rejects.
  poll() {
    if (!this.#inFlight) {
      this.#inFlight = this.#poll().finally(() => {
        this.#inFlight = null;
      });
    }
    return this.#inFlight;
  }

  // generation ends a loop left over from before a stop() followed by a quick start().
  async #loop(generation) {
    await this.poll();
    if (!this.#running || generation !== this.#generation) return;
    // The next poll is scheduled only after this one finishes, so polls never overlap.
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#loop(generation);
    }, this.#intervalMs);
  }

  #exec(args) {
    // Promise.resolve().then() turns a synchronous throw from run into a rejection.
    return Promise.resolve().then(() => this.#run(this.#adbPath, args));
  }

  #log(level, message) {
    this.emit('log', { level, message });
  }

  #failed(key, err) {
    if (err?.code === 'ENOENT') {
      if (!this.#adbMissing) {
        this.#adbMissing = true;
        this.#log('warn', `adb not found ("${this.#adbPath}"). Install Android platform-tools to forward ` +
          `port ${this.#port} to the headset; still checking every ${this.#intervalMs / 1000}s.`);
      }
      return;
    }
    const message = err?.killed ? `timed out after ${RUN_TIMEOUT_MS / 1000}s` : String(err?.message ?? err).trim();
    if (this.#failures.get(key) === message) return;
    this.#failures.set(key, message);
    const what = key === 'devices' ? 'adb devices' : `adb reverse for ${key}`;
    this.#log('warn', `${what} failed: ${message}`);
  }

  #succeeded(key) {
    this.#failures.delete(key);
  }

  async #poll() {
    let stdout;
    try {
      ({ stdout } = await this.#exec(['devices']));
    } catch (err) {
      this.#failed('devices', err);
      return;
    }
    if (this.#adbMissing) {
      this.#adbMissing = false;
      this.#log('info', 'adb is available.');
    }
    this.#succeeded('devices');

    const listed = parseDevices(stdout);
    this.#updateUnauthorized(listed);

    const current = listed.filter((d) => d.state === 'device').map((d) => d.serial);
    const previous = this.#devices;
    this.#devices = current;
    for (const serial of previous) {
      if (!current.includes(serial)) {
        this.#failures.delete(serial);
        this.emit('headset', { connected: false, serial });
      }
    }
    for (const serial of current) {
      if (!previous.includes(serial)) this.emit('headset', { connected: true, serial });
    }

    for (const serial of current) {
      await this.#ensureReverse(serial);
    }
  }

  #updateUnauthorized(listed) {
    const now = new Set(listed.filter((d) => d.state === 'unauthorized').map((d) => d.serial));
    for (const serial of now) {
      if (!this.#unauthorized.has(serial)) {
        this.#log('warn', `Headset ${serial} is unauthorized: put the headset on and accept the ` +
          '"Allow USB debugging" prompt.');
      }
    }
    this.#unauthorized = now;
  }

  // Checked on every poll: an adb server restart drops the forward while the device stays listed.
  async #ensureReverse(serial) {
    const port = this.#port;
    try {
      const { stdout } = await this.#exec(['-s', serial, 'reverse', '--list']);
      if (!hasReverse(stdout, port)) {
        await this.#exec(['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
        this.emit('reverse', { serial, port });
      }
      this.#succeeded(serial);
    } catch (err) {
      this.#failed(serial, err);
    }
  }
}

// options: { port, intervalMs = 2000, adbPath = 'adb', run = execFile wrapper }
export function createAdbReverse(options) {
  return new AdbReverse(options);
}
