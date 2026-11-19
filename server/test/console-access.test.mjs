import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultConfig, validateConfig } from '../src/config.mjs';
import { consoleOriginAllowed, consoleCredentialAuthorized } from '../src/console-access.mjs';

const PRIMARY = 'fixture-console-primary-key';
const CLIENT = 'fixture-model-client-key';
const req = (host = '127.0.0.1:8788', origin, peer = '127.0.0.1', extra = {}) => ({
  headers: { host, ...(origin === undefined ? {} : { origin }), ...extra },
  socket: { remoteAddress: peer },
});

test('remote console is explicitly disabled by default', () => {
  assert.equal(defaultConfig().allowRemoteConsole, false);
});
for (const enabled of [true, false]) {
  test(`config preserves explicit allowRemoteConsole=${enabled}`, () => {
    const cfg = defaultConfig(); cfg.allowRemoteConsole = enabled;
    validateConfig(cfg);
    assert.equal(cfg.allowRemoteConsole, enabled);
  });
}
for (const value of ['true', 'false', 1, 0, null, [], {}]) {
  test(`invalid remote flag fails closed: ${JSON.stringify(value)}`, () => {
    const cfg = defaultConfig(); cfg.allowRemoteConsole = value;
    assert.ok(validateConfig(cfg).some(x => x.includes('allowRemoteConsole')));
    assert.equal(cfg.allowRemoteConsole, false);
  });
}

const originCases = [
  ['local navigation while disabled', req(), false, true],
  ['IPv6 local navigation', req('[::1]:8788', undefined, '::1'), false, true],
  ['IPv4-mapped local peer', req('localhost:8788', undefined, '::ffff:127.0.0.1'), false, true],
  ['local-origin compatibility', req('localhost:8788', 'http://127.0.0.1:8788'), false, true],
  ['remote Host blocked while disabled', req('192.168.10.54:8788'), false, false],
  ['forged local Host from remote peer blocked', req('127.0.0.1:8788', undefined, '192.168.10.20'), false, false],
  ['remote forwarded peer blocked while disabled', req('localhost:8788', undefined, '127.0.0.1', {'x-forwarded-for':'192.168.10.20'}), false, false],
  ['foreign local-browser Origin blocked', req('localhost:8788', 'https://evil.example'), false, false],
  ['private third-party Origin blocked', req('localhost:8788', 'http://192.168.10.99:9000'), false, false],
  ['remote navigation allowed when enabled', req('192.168.10.54:8788', undefined, '192.168.10.20'), true, true],
  ['remote same-origin allowed', req('192.168.10.54:8788', 'http://192.168.10.54:8788'), true, true],
  ['public HTTPS reverse proxy same-origin', req('console.example', 'https://console.example'), true, true],
  ['default HTTPS port normalized', req('console.example:443', 'https://console.example'), true, true],
  ['foreign private Origin blocked when enabled', req('192.168.10.54:8788', 'http://192.168.10.99:8788'), true, false],
  ['wrong origin port blocked', req('console.example:8788', 'http://console.example:9000'), true, false],
  ['null Origin blocked', req('console.example', 'null'), true, false],
  ['file Origin blocked', req('console.example', 'file://console.example'), true, false],
  ['malformed Host blocked', req('console.example/path'), true, false],
  ['Host userinfo blocked', req('admin@console.example'), true, false],
];
for (const [name, r, enabled, expected] of originCases) {
  test(name, () => assert.equal(consoleOriginAllowed(r, enabled), expected));
}

const basic = (user, pass) => 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
for (const [name, headers, key, expected] of [
  ['anonymous denied', {}, PRIMARY, false],
  ['empty key never grants console access', {}, '', false],
  ['primary Bearer accepted', {authorization:'Bearer '+PRIMARY}, PRIMARY, true],
  ['primary API key header accepted', {'x-api-key':PRIMARY}, PRIMARY, true],
  ['secondary model key denied', {authorization:'Bearer '+CLIENT}, PRIMARY, false],
  ['browser Basic admin accepted', {authorization:basic('admin', PRIMARY)}, PRIMARY, true],
  ['wrong Basic username denied', {authorization:basic('user', PRIMARY)}, PRIMARY, false],
  ['wrong Basic password denied', {authorization:basic('admin', CLIENT)}, PRIMARY, false],
  ['malformed Basic denied', {authorization:'Basic !!!'}, PRIMARY, false],
]) {
  test(name, () => assert.equal(consoleCredentialAuthorized({headers}, key), expected));
}

async function fixture(t, key = [PRIMARY, CLIENT]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-console-test-'));
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const cfg = defaultConfig();
  Object.assign(cfg, {host:'127.0.0.1', port, apiKey:key, allowRemoteConsole:false, rateLimit:{enabled:false}});
  for (const site of Object.values(cfg.sites)) site.enabled = false;
  fs.writeFileSync(path.join(dir,'config.json'), JSON.stringify(cfg));
  const server = fileURLToPath(new URL('../server.mjs', import.meta.url));
  const child = spawn(process.execPath, [server], {
    env:{PATH:process.env.PATH, HOME:dir, TMPDIR:os.tmpdir(), WB_CONFIG_DIR:dir}, stdio:'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGINT');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited; clearTimeout(timer);
    }
    fs.rmSync(dir, {recursive:true, force:true});
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i=0;i<80;i++) {
    if (child.exitCode !== null) throw new Error('fixture server exited before ready');
    try { const r=await fetch(base+'/health'); await r.arrayBuffer(); if(r.ok) {ready=true;break;} } catch {}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(ready, 'actual fixture server became healthy');
  // fetch/Undici 会覆盖 Host；用真实 HTTP 客户端保留被验收的字面 Host/Origin。
  const call = (p, headers={}, body) => new Promise((resolve, reject) => {
    const request = http.request(new URL(base+p), {
      method:body===undefined?'GET':'POST',
      headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},
    }, response => {
      const chunks=[];
      response.on('data',chunk=>chunks.push(chunk));
      response.on('error',reject);
      response.on('end',()=>resolve(new Response(Buffer.concat(chunks), {
        status:response.statusCode, headers:response.headers,
      })));
    });
    request.on('error',reject);
    request.setTimeout(10000,()=>request.destroy(new Error('HTTP fixture timeout')));
    if (body!==undefined) request.write(JSON.stringify(body));
    request.end();
  });
  return {dir, cfg, call, port};
}

test('actual HTTP switch, authentication, CSRF and persistence', async t => {
  const {dir, cfg, call, port} = await fixture(t);
  const owner = {authorization:'Bearer '+PRIMARY};
  const remote = {host:`192.168.10.54:${port}`};
  let r = await call('/console');
  assert.equal(r.status,200);
  assert.match(await r.text(), /remoteConsoleToggle/);
  r = await call('/console', remote); assert.equal(r.status,403); await r.arrayBuffer();
  r = await call('/console/api/remote-console',owner);
  assert.deepEqual(await r.json(),{enabled:false});
  r = await call('/console/api/remote-console',owner,{enabled:'true'});
  assert.equal(r.status,400); await r.arrayBuffer();
  r = await call('/console/api/remote-console',owner,{enabled:true});
  assert.equal(r.status,200); assert.equal((await r.json()).enabled,true);
  let disk=JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8'));
  assert.equal(disk.allowRemoteConsole,true);
  assert.deepEqual(disk.apiKey,cfg.apiKey); assert.equal(disk.defaultModel,cfg.defaultModel);
  r = await call('/console',remote);
  assert.equal(r.status,401); assert.match(r.headers.get('www-authenticate'), /^Basic /);
  assert.doesNotMatch(await r.text(), /__WB_TOKEN__/);
  r = await call('/console',{...remote,authorization:'Bearer '+CLIENT});
  assert.equal(r.status,401); await r.arrayBuffer();
  r = await call('/console',{...remote,authorization:basic('admin',PRIMARY)});
  assert.equal(r.status,200); assert.equal(r.headers.get('x-frame-options'),'DENY');
  const html=await r.text();
  assert.match(html,/__WB_TOKEN__/); assert.doesNotMatch(html,new RegExp(PRIMARY));
  const session=JSON.parse(html.match(/window\.__WB_TOKEN__=("[^"]+");/)[1]);
  r=await call('/console/api/remote-console',{...remote,'x-console-token':session});
  assert.equal(r.status,200); assert.deepEqual(await r.json(),{enabled:true});
  r=await call('/console/api/remote-console',{...remote,authorization:'Bearer '+CLIENT});
  assert.equal(r.status,401); await r.arrayBuffer();
  r=await call('/console/api/remote-console',{...remote,...owner,origin:'http://192.168.10.99:8788'},{enabled:false});
  assert.equal(r.status,403); assert.notEqual(r.headers.get('access-control-allow-origin'),'*'); await r.arrayBuffer();
  r=await call('/console/api/remote-console',{...remote,...owner,origin:`http://192.168.10.54:${port}`});
  assert.equal(r.status,200); assert.equal(r.headers.get('access-control-allow-origin'),`http://192.168.10.54:${port}`); await r.arrayBuffer();
  r=await call('/v1/models',remote); assert.equal(r.status,200); await r.arrayBuffer();
  r=await call('/console/api/remote-console',{...remote,'x-console-token':session},{enabled:false});
  assert.equal(r.status,200); assert.equal((await r.json()).enabled,false);
  r=await call('/console', {...remote,...owner}); assert.equal(r.status,403); await r.arrayBuffer();
  r=await call('/console'); assert.equal(r.status,200); await r.arrayBuffer();
  disk=JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8'));
  assert.equal(disk.allowRemoteConsole,false);
  assert.deepEqual(disk.apiKey,cfg.apiKey); assert.equal(disk.port,port);
});

test('keyless configuration cannot enable remote console', async t => {
  const {call}=await fixture(t,[]);
  const r=await call('/console/api/remote-console',{}, {enabled:true});
  assert.equal(r.status,400);
  assert.match(JSON.stringify(await r.json()), /API Key/);
});
