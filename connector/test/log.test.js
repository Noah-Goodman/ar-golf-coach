import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPacketLog } from '../src/log.js';

const NOW = Date.UTC(2026, 10, 15, 13, 4, 5, 678);
const FILE_NAME = '2026-11-15T13-04-05.678Z.jsonl';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'r10-log-test-'));
}

test('creates the directory and a timestamped .jsonl file', async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'nested', 'logs');

  const log = createPacketLog(dir, { now: () => NOW });
  assert.equal(log.path, path.join(dir, FILE_NAME));
  await log.close();
  assert.ok(fs.existsSync(log.path));
});

test('resolves a relative directory against the working directory', async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relative = path.relative(process.cwd(), path.join(root, 'rel'));

  const log = createPacketLog(relative, { now: () => NOW });
  assert.ok(path.isAbsolute(log.path));
  assert.equal(log.path, path.join(root, 'rel', FILE_NAME));
  await log.close();
});

test('writes one JSON object per line with keys t, char, hex', async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const log = createPacketLog(root, { now: () => NOW });
  log.write({ hex: '000000', char: 'status', t: 1 });
  log.write({ t: 2, char: 'measurement', hex: '0200', extra: true });
  await log.close();

  const text = fs.readFileSync(log.path, 'utf8');
  assert.equal(
    text,
    '{"t":1,"char":"status","hex":"000000"}\n{"t":2,"char":"measurement","hex":"0200"}\n',
  );
});

test('appends to an existing file', async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = createPacketLog(root, { now: () => NOW });
  first.write({ t: 1, char: 'battery', hex: '57' });
  await first.close();
  const second = createPacketLog(root, { now: () => NOW });
  second.write({ t: 2, char: 'battery', hex: '56' });
  await second.close();

  assert.equal(fs.readFileSync(first.path, 'utf8').trim().split('\n').length, 2);
});

test('close is safe to call twice and writes after close are ignored', async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const log = createPacketLog(root, { now: () => NOW });
  log.write({ t: 1, char: 'control', hex: '800000' });
  await Promise.all([log.close(), log.close()]);
  await log.close();
  assert.doesNotThrow(() => log.write({ t: 2, char: 'control', hex: '800000' }));
  assert.equal(fs.readFileSync(log.path, 'utf8').split('\n').length, 2);
});

test('a write failure does not throw and is reported once on stderr', async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // A directory where the log file should be makes the open fail.
  fs.mkdirSync(path.join(root, FILE_NAME));

  const messages = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    messages.push(String(chunk));
    return true;
  };
  try {
    const log = createPacketLog(root, { now: () => NOW });
    for (let i = 0; i < 5; i++) log.write({ t: i, char: 'measurement', hex: '00' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (let i = 0; i < 5; i++) log.write({ t: i, char: 'measurement', hex: '00' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await log.close();
  } finally {
    process.stderr.write = original;
  }
  const reports = messages.filter((m) => m.includes('packet log'));
  assert.equal(reports.length, 1);
});
