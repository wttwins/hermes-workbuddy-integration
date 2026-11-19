// Isolated image acceptance: no production data, account or model calls.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const image = process.env.IMAGE_REF || 'workbuddy-openai-proxy:ci';
const platform = process.env.TARGET_PLATFORM || '';
const suffix = crypto.randomBytes(8).toString('hex');
const name = `workbuddy-smoke-${suffix}`;
const volume = `${name}-data`;
const key = `fixture-only-${crypto.randomBytes(24).toString('hex')}`;
const cases = [];
let containerCreated = false;
let volumeCreated = false;
let base;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }).trim();
const inspect = () => JSON.parse(docker('container', 'inspect', name))[0];
const exec = code => docker('exec', name, 'node', '-e', code);
const check = (id, passed) => { cases.push({ id, passed: Boolean(passed) }); assert.ok(passed, id); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(path, authorization) {
  const headers = authorization ? { authorization } : {};
  return fetch(base + path, { headers, signal: AbortSignal.timeout(10000) });
}
async function start(port, remote, initialKey) {
  const args = ['run', '--detach', '--name', name, '--label', `workbuddy.fixture=${suffix}`, '--read-only', '--cap-drop=ALL',
    '--security-opt', 'no-new-privileges:true', '--publish', `127.0.0.1::${port}`,
    '--env', `PORT=${port}`, '--env', 'HOST=0.0.0.0', '--env', `ALLOW_REMOTE_CONSOLE=${remote}`,
    '--mount', `type=volume,source=${volume},target=/data`];
  if (initialKey) args.push('--env', `API_KEY=${key}`);
  if (platform) args.push('--platform', platform);
  args.push(image); docker(...args); containerCreated = true;
  const info = inspect();
  const published = info.NetworkSettings.Ports[`${port}/tcp`][0];
  base = `http://127.0.0.1:${published.HostPort}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const response = await request('/health'); await response.arrayBuffer(); if (response.status === 200) { ready = true; break; } } catch {}
    await delay(200);
  }
  assert.ok(ready, 'image did not become ready');
  return info;
}
function owned() {
  return inspect().Config.Labels['workbuddy.fixture'] === suffix;
}
function stopAndRemove(stage) {
  assert.ok(owned(), 'refusing to remove an unowned container');
  docker('stop', '--time', '15', name);
  check(`SIGINT_graceful_exit_${stage}`, inspect().State.ExitCode === 0);
  docker('rm', name); containerCreated = false;
}
try {
  docker('volume', 'create', '--label', `workbuddy.fixture=${suffix}`, volume); volumeCreated = true;
  await start(9000, false, true);
  check('custom_port_9000_health', (await request('/health')).status === 200);
  const closed = await request('/console'); await closed.arrayBuffer();
  check('closed_console_denies_NAT_peer', closed.status === 403);
  check('non_root_UID', exec('process.stdout.write(String(process.getuid()))') === '1000');
  check('upstream_license_in_image', exec("process.stdout.write(String(require('fs').existsSync('/app/server/LICENSE')))") === 'true');
  check('no_account_files_in_app_image', exec("const fs=require('fs');process.stdout.write(String(fs.readdirSync('/app/server').every(n=>!/^auth.*\\.json$/.test(n)&&n!=='config.json')))") === 'true');
  docker('exec', name, 'node', '/app/docker/healthcheck.mjs'); check('healthcheck_custom_port_9000', true);
  exec("require('fs').writeFileSync('/data/auth.fixture-only.json',JSON.stringify({fixture:true,no_real_account:true}),{mode:0o600})");
  const before = exec("process.stdout.write(require('fs').readFileSync('/data/auth.fixture-only.json','utf8'))");
  stopAndRemove('before_recreate');
  await start(9011, true, false);
  const cfg = JSON.parse(exec("process.stdout.write(require('fs').readFileSync('/data/config.json','utf8'))"));
  check('new_internal_port_9011', cfg.port === 9011);
  check('volume_retains_primary_key', cfg.apiKey === key);
  check('volume_retains_account_fixture', exec("process.stdout.write(require('fs').readFileSync('/data/auth.fixture-only.json','utf8'))") === before);
  const anonymous = await request('/console'); await anonymous.arrayBuffer();
  check('open_console_requires_login', anonymous.status === 401 && anonymous.headers.get('www-authenticate')?.startsWith('Basic '));
  const basic = 'Basic ' + Buffer.from('admin:' + key).toString('base64');
  const authenticated = await request('/console', basic); const html = await authenticated.text();
  check('authenticated_console_renders', authenticated.status === 200 && html.includes('remoteConsoleToggle') && !html.includes(key));
  const invalid = await request('/console', 'Bearer fixture-invalid'); await invalid.arrayBuffer();
  check('invalid_key_denied', invalid.status === 401);
  docker('exec', name, 'node', '/app/docker/healthcheck.mjs'); check('healthcheck_custom_port_9011', true);
  stopAndRemove('final');
  console.log(JSON.stringify({ image, platform: platform || 'native', cases, passed: true, real_accounts_used: false, model_calls: false }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ passed: false, cases, error: error instanceof assert.AssertionError ? error.message : error.constructor.name }));
  process.exitCode = 1;
} finally {
  if (containerCreated) {
    try { if (owned()) docker('rm', '--force', name); } catch { process.exitCode = 1; }
  }
  if (volumeCreated) {
    try {
      const info = JSON.parse(docker('volume', 'inspect', volume))[0];
      assert.equal(info.Labels['workbuddy.fixture'], suffix);
      docker('volume', 'rm', volume);
    } catch { process.exitCode = 1; }
  }
}
