import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');

const DEFAULTS = Object.freeze({ port: 8765, r10Id: null, logDir: 'logs' });

// Missing file -> defaults. Keys in the file override defaults; unknown keys are kept.
// Invalid JSON, a non-object, or an unusable port/r10Id/logDir throws an Error naming the file.
export function loadConfig(configPath = CONFIG_PATH) {
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ...DEFAULTS };
    throw new Error(`Cannot read config file ${configPath}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Config file ${configPath} is not valid JSON: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Config file ${configPath} must contain a JSON object, e.g. { "port": 8765 }`);
  }

  const config = { ...DEFAULTS, ...parsed };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error(`Config file ${configPath}: "port" must be an integer from 1 to 65535`);
  }
  if (config.r10Id !== null && typeof config.r10Id !== 'string') {
    throw new Error(`Config file ${configPath}: "r10Id" must be a string or null`);
  }
  if (typeof config.logDir !== 'string' || config.logDir === '') {
    throw new Error(`Config file ${configPath}: "logDir" must be a non-empty string`);
  }
  return config;
}

// Writes 2-space JSON with a trailing newline. The temp-file rename means an interrupted
// write never leaves a truncated config behind.
export function saveConfig(config, configPath = CONFIG_PATH) {
  const tmp = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, configPath);
}

// config.logDir resolved against PROJECT_ROOT when relative.
export function resolveLogDir(config) {
  return path.resolve(PROJECT_ROOT, config.logDir);
}
