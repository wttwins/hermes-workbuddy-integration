import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareDockerConfig } from '../../docker/entrypoint.mjs';

const withDir = fn => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-docker-config-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};
const raw = dir => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const existing = { host: '127.0.0.1', port: 7777, apiKey: 'existing-primary-fixture',
  allowRemoteConsole: false, defaultSite: 'intl-cli', defaultModel: 'original-model',
  custom: { preserved: true }, sites: { 'intl-cli': { apiBase: 'https://example.test' } } };
const put = (dir, obj = existing) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(obj));

test('Docker empty volume initializes a private configuration and stable random key', () => withDir(dir => {
  prepareDockerConfig({ dir, env: {} });
  const a = raw(dir);
  assert.equal(a.host, '0.0.0.0'); assert.equal(a.port, 8788);
  assert.equal(a.allowRemoteConsole, false); assert.ok(a.apiKey.length >= 20);
  assert.equal(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600);
  prepareDockerConfig({ dir, env: {} }); assert.equal(raw(dir).apiKey, a.apiKey);
}));
test('Docker PORT and HOST override only their persisted configuration fields', () => withDir(dir => {
  put(dir); const auth = path.join(dir, 'auth.intl-cli.json'); fs.writeFileSync(auth, 'opaque-fixture');
  prepareDockerConfig({ dir, env: { PORT: '9000', HOST: '0.0.0.0' } });
  assert.deepEqual(raw(dir), { ...existing, port: 9000, host: '0.0.0.0' });
  assert.equal(fs.readFileSync(auth, 'utf8'), 'opaque-fixture');
}));
test('Docker omitted variables preserve an existing valid config byte for byte', () => withDir(dir => {
  put(dir); const before = fs.readFileSync(path.join(dir, 'config.json'));
  prepareDockerConfig({ dir, env: {} }); assert.deepEqual(fs.readFileSync(path.join(dir, 'config.json')), before);
}));
for (const port of ['0', '65536', '-1', '9000abc', '9000.5', '', ' 9000 ', '1e3']) {
  test(`Docker rejects malformed PORT ${JSON.stringify(port)} before touching existing data`, () => withDir(dir => {
    put(dir); const before = fs.readFileSync(path.join(dir, 'config.json'));
    assert.throws(() => prepareDockerConfig({ dir, env: { PORT: port } }), /PORT/);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'config.json')), before);
  }));
}
for (const port of ['1', '65535']) {
  test(`Docker accepts valid PORT boundary ${port}`, () => withDir(dir => {
    prepareDockerConfig({ dir, env: { PORT: port } }); assert.equal(raw(dir).port, Number(port));
  }));
}
test('Docker rejects an invalid port without creating configuration', () => withDir(dir => {
  assert.throws(() => prepareDockerConfig({ dir, env: { PORT: 'invalid' } }), /PORT/);
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
}));
for (const value of ['true', 'false']) {
  test(`Docker ALLOW_REMOTE_CONSOLE=${value} is an explicit boolean`, () => withDir(dir => {
    prepareDockerConfig({ dir, env: { ALLOW_REMOTE_CONSOLE: value } });
    assert.equal(raw(dir).allowRemoteConsole, value === 'true');
  }));
}
for (const value of ['1', 'yes', 'TRUE', '']) {
  test(`Docker rejects non-boolean ALLOW_REMOTE_CONSOLE ${JSON.stringify(value)}`, () => withDir(dir => {
    assert.throws(() => prepareDockerConfig({ dir, env: { ALLOW_REMOTE_CONSOLE: value } }), /ALLOW_REMOTE_CONSOLE/);
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
  }));
}
test('Docker cannot start with a keyless existing configuration', () => withDir(dir => {
  put(dir, { ...existing, apiKey: [] });
  const before = fs.readFileSync(path.join(dir, 'config.json'));
  assert.throws(() => prepareDockerConfig({ dir, env: { ALLOW_REMOTE_CONSOLE: 'true' } }), /API Key/);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'config.json')), before);
}));
test('Docker optional API_KEY supplies the primary key and empty means preserve', () => withDir(dir => {
  put(dir); prepareDockerConfig({ dir, env: { API_KEY: 'provided-fixture-key' } });
  assert.equal(raw(dir).apiKey, 'provided-fixture-key');
  prepareDockerConfig({ dir, env: { API_KEY: '' } }); assert.equal(raw(dir).apiKey, 'provided-fixture-key');
}));
test('Docker supports a key file and rejects ambiguous credential inputs', () => withDir(dir => {
  const keyfile = path.join(dir, 'key.txt'); fs.writeFileSync(keyfile, 'file-fixture-key\n');
  prepareDockerConfig({ dir, env: { API_KEY_FILE: keyfile } }); assert.equal(raw(dir).apiKey, 'file-fixture-key');
  assert.throws(() => prepareDockerConfig({ dir, env: { API_KEY_FILE: keyfile, API_KEY: 'another-key' } }), /API_KEY/);
}));
test('Docker malformed JSON is not overwritten and errors do not echo secrets', () => withDir(dir => {
  const invalid = '{"apiKey":"sensitive-fixture-value",'; fs.writeFileSync(path.join(dir, 'config.json'), invalid);
  assert.throws(() => prepareDockerConfig({ dir, env: { PORT: '9000' } }), error => !error.message.includes('sensitive-fixture-value'));
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), invalid);
}));
test('Docker requires an object configuration root', () => withDir(dir => {
  put(dir, []); assert.throws(() => prepareDockerConfig({ dir, env: {} }), /config.json/);
}));
test('Docker rejects an empty or whitespace-only HOST', () => withDir(dir => {
  put(dir); assert.throws(() => prepareDockerConfig({ dir, env: { HOST: '  ' } }), /HOST/);
}));
test('Docker failed configuration writes preserve the original file and remove temporary secrets', t => withDir(dir => {
  put(dir); const before = fs.readFileSync(path.join(dir, 'config.json'));
  const originalWrite = fs.writeFileSync;
  const failure = t.mock.method(fs, 'writeFileSync', (...args) => {
    if (typeof args[0] === 'number') throw new Error('fixture disk write failure');
    return originalWrite(...args);
  });
  try {
    assert.throws(() => prepareDockerConfig({ dir, env: { PORT: '9000' } }), /配置保存失败/);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'config.json')), before);
    assert.deepEqual(fs.readdirSync(dir), ['config.json']);
  } finally { failure.mock.restore(); }
}));
