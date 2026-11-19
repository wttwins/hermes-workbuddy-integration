import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defaultConfig, primaryKey } from '../server/src/config.mjs';

const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const portFromEnvironment = value => {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new Error('PORT 必须是 1-65535 的整数字符串');
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT 必须是 1-65535 的整数');
  }
  return port;
};
const validateKey = key => {
  if (typeof key !== 'string' || !key || key !== key.trim() || /[\r\n]/.test(key)) {
    throw new Error('API_KEY 必须是非空且不含换行或首尾空白的密钥');
  }
  return key;
};

/** Docker-only bootstrap. Existing bare-Node services do not use this file.
 * Explicit environment fields are persisted before the unchanged gateway starts.
 * No account credentials, site defaults, model settings or other fields are copied.
 */
export function prepareDockerConfig({ dir = process.env.WB_CONFIG_DIR || '/data', env = process.env } = {}) {
  const overrides = {};
  if (owns(env, 'PORT')) overrides.port = portFromEnvironment(env.PORT);
  if (owns(env, 'HOST')) {
    if (typeof env.HOST !== 'string' || !env.HOST.trim() || env.HOST !== env.HOST.trim()) {
      throw new Error('HOST 必须是非空监听地址，不得含首尾空白');
    }
    overrides.host = env.HOST;
  }
  if (owns(env, 'ALLOW_REMOTE_CONSOLE')) {
    if (!['true', 'false'].includes(env.ALLOW_REMOTE_CONSOLE)) {
      throw new Error('ALLOW_REMOTE_CONSOLE 只接受 true 或 false');
    }
    overrides.allowRemoteConsole = env.ALLOW_REMOTE_CONSOLE === 'true';
  }
  const direct = env.API_KEY || '';
  const keyFile = env.API_KEY_FILE || '';
  if (direct && keyFile) throw new Error('API_KEY 和 API_KEY_FILE 不能同时设置');
  if (direct) overrides.apiKey = validateKey(direct);
  if (keyFile) {
    let value;
    try { value = fs.readFileSync(keyFile, 'utf8').replace(/\r?\n$/, ''); }
    catch { throw new Error('API_KEY_FILE 无法读取，请核对挂载与权限'); }
    overrides.apiKey = validateKey(value);
  }

  const configPath = path.join(path.resolve(dir), 'config.json');
  const exists = fs.existsSync(configPath);
  let original;
  if (exists) {
    let text;
    try { text = fs.readFileSync(configPath, 'utf8'); }
    catch { throw new Error('config.json 无法读取，请确保数据目录允许 UID 1000 读写'); }
    try { original = JSON.parse(text); }
    catch { throw new Error('config.json 不是合法 JSON，未修改原文件'); }
    if (!original || typeof original !== 'object' || Array.isArray(original)) {
      throw new Error('config.json 根节点必须是对象，未修改原文件');
    }
  } else {
    original = { ...defaultConfig(), host: '0.0.0.0' };
  }
  const cfg = { ...original, ...overrides };
  if (!owns(cfg, 'port')) cfg.port = 8788;
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    throw new Error('config.json 的 port 必须为 1-65535 的整数；也可用 PORT 显式覆盖');
  }
  if (!owns(cfg, 'host')) cfg.host = '0.0.0.0';
  if (typeof cfg.host !== 'string' || !cfg.host.trim()) throw new Error('config.json 的 host 必须是监听地址');
  if (!owns(cfg, 'apiKey')) cfg.apiKey = defaultConfig().apiKey;
  if (!primaryKey(cfg)) throw new Error('Docker 网关必须配置有效主 API Key，拒绝匿名启动');
  const changed = !exists || JSON.stringify(cfg) !== JSON.stringify(original);
  if (changed) {
    const temporary = configPath + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      // The supported mount is the whole writable data directory, not a single file.
      fs.renameSync(temporary, configPath);
    } catch {
      try { fs.unlinkSync(temporary); } catch {}
      throw new Error('配置保存失败，请确保完整数据目录允许 UID 1000 读写');
    }
  }
  return { dir: path.dirname(configPath), created: !exists, changed,
    host: cfg.host, port: cfg.port, allowRemoteConsole: cfg.allowRemoteConsole === true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try {
    const dir = process.env.WB_CONFIG_DIR || '/data';
    process.env.WB_CONFIG_DIR = dir;
    prepareDockerConfig({ dir });
    // Same Node process: the gateway receives SIGINT and flushes usage/account pools.
    await import(new URL('../server/server.mjs', import.meta.url));
  } catch (error) {
    console.error('[docker] ' + error.message);
    process.exitCode = 1;
  }
}
