import fs from 'node:fs';
import path from 'node:path';

// Raw packet log: one JSON object per line, appended as notifications arrive.
export function createPacketLog(logDir, options = {}) {
  const now = options.now ?? Date.now;
  const dir = path.resolve(logDir);
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date(now()).toISOString().replace(/:/g, '-');
  const filePath = path.join(dir, `${stamp}.jsonl`);
  const stream = fs.createWriteStream(filePath, { flags: 'a' });

  let reported = false;
  const report = (err) => {
    if (reported) return;
    reported = true;
    try {
      process.stderr.write(`packet log: cannot write ${filePath}: ${err?.message ?? err}\n`);
    } catch {
      // stderr itself is unavailable; nothing left to report to.
    }
  };
  stream.on('error', report);

  let closing = null;

  return {
    path: filePath,

    write(packet) {
      if (closing) return;
      try {
        const line = JSON.stringify({ t: packet.t, char: packet.char, hex: packet.hex }) + '\n';
        stream.write(line);
      } catch (err) {
        report(err);
      }
    },

    close() {
      if (!closing) {
        closing = new Promise((resolve) => {
          if (stream.closed || stream.destroyed) {
            resolve();
            return;
          }
          stream.once('close', resolve);
          stream.end();
        });
      }
      return closing;
    },
  };
}
