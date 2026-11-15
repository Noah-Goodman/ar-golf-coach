import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT, CONFIG_PATH, loadConfig, saveConfig, resolveLogDir } from '../src/config.js';

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r10-config-test-'));
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const file = (name) => path.join(dir, name);

test('paths point at the project root', () => {
  assert.ok(fs.existsSync(path.join(PROJECT_ROOT, 'package.json')));
  assert.equal(CONFIG_PATH, path.join(PROJECT_ROOT, 'config.json'));
});

test('a missing file gives the defaults', () => {
  assert.deepEqual(loadConfig(file('missing.json')), { port: 8765, r10Id: null, logDir: 'logs' });
});

test('keys in the file override defaults and unknown keys are kept', () => {
  fs.writeFileSync(file('override.json'), JSON.stringify({ port: 9001, r10Id: 'abc123', extra: { a: 1 } }));
  assert.deepEqual(loadConfig(file('override.json')),
    { port: 9001, r10Id: 'abc123', logDir: 'logs', extra: { a: 1 } });
});

test('unknown keys survive a save/load round trip', () => {
  const p = file('roundtrip.json');
  fs.writeFileSync(p, JSON.stringify({ note: 'keep me', logDir: '/var/tmp/r10' }));
  const config = loadConfig(p);
  config.r10Id = 'deadbeef';
  saveConfig(config, p);
  assert.deepEqual(loadConfig(p), { port: 8765, r10Id: 'deadbeef', logDir: '/var/tmp/r10', note: 'keep me' });
});

test('invalid JSON throws a clear error naming the file', () => {
  const p = file('broken.json');
  fs.writeFileSync(p, '{ "port": 8765,, }');
  assert.throws(() => loadConfig(p), (err) => {
    assert.ok(err.message.includes(p));
    assert.match(err.message, /not valid JSON/);
    return true;
  });
});

test('a non-object throws', () => {
  for (const [name, text] of [['array.json', '[1,2]'], ['null.json', 'null'], ['num.json', '42']]) {
    fs.writeFileSync(file(name), text);
    assert.throws(() => loadConfig(file(name)), /must contain a JSON object/);
  }
});

test('an unusable port throws', () => {
  fs.writeFileSync(file('port.json'), '{ "port": "8765" }');
  assert.throws(() => loadConfig(file('port.json')), /"port" must be an integer/);
});

test('saveConfig writes 2-space JSON with a trailing newline', () => {
  const p = file('saved.json');
  saveConfig({ port: 8765, r10Id: null, logDir: 'logs' }, p);
  assert.equal(fs.readFileSync(p, 'utf8'), '{\n  "port": 8765,\n  "r10Id": null,\n  "logDir": "logs"\n}\n');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
});

test('resolveLogDir resolves relative paths against the project root', () => {
  assert.equal(resolveLogDir({ logDir: 'logs' }), path.join(PROJECT_ROOT, 'logs'));
  assert.equal(resolveLogDir({ logDir: '/var/tmp/r10' }), '/var/tmp/r10');
});
