// Model-directory transport regressions. All credentials and upstreams are
// disposable local fixtures; no production config or real inference is used.
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authPathFor, setConfigDir } from '../src/config.mjs';
import { fetchModels } from '../src/upstream.mjs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-model-discovery-'));
const restoreConfigDir = setConfigDir(tmpDir);
const sites = ['cn-cli', 'intl-cli', 'intl-work'];
const consolePath = '/console/enterprises/personal/models';
let mode = 'both';
let requests = [];
let baseUrl;

const metadata = () => ({
  code: 0,
  data: {
    models: [
      { id: 'cli-model', name: 'Fixture CLI', credits: 'x1 credits',
        maxInputTokens: 4096, maxOutputTokens: 2048,
        supportsImages: true, supportsToolCall: true, supportsReasoning: true },
      { id: 'disabled-cli', name: 'Disabled', disabled: true },
      { id: 'image-only', name: 'Image fixture' },
    ],
    agents: [{ name: 'cli', models: ['cli-model', 'disabled-cli'] }],
  },
});

const server = http.createServer((req, res) => {
  requests.push({ path: req.url, method: req.method, headers: req.headers });
  if (!['/v3/config', consolePath].includes(req.url)) {
    res.writeHead(404); return res.end('unexpected fixture path');
  }
  if (mode === 'hang') return;
  if (mode === 'http-error' || (mode === 'cli-only' && req.url === consolePath)) {
    res.writeHead(500); return res.end('fixture legacy directory unavailable');
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (mode === 'malformed') return res.end('{invalid json');
  if (mode === 'business-error') return res.end(JSON.stringify({ code: 7, msg: 'fixture denied' }));
  const body = metadata();
  if (mode === 'empty-agent-models') body.data.agents[0].models = [];
  res.end(JSON.stringify(body));
});

const mkCfg = (metaMs = 2000) => ({
  defaultSite: 'intl-cli',
  timeouts: { metaMs },
  sites: Object.fromEntries(sites.map(site => [site, {
    enabled: true, apiBase: baseUrl, origin: 'https://fixture.invalid',
    userAgent: 'ModelDirectoryFixture/1', product: 'SaaS',
  }])),
});

before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => {
  setConfigDir(tmpDir);
  mode = 'both'; requests = [];
  for (const site of sites) {
    fs.writeFileSync(authPathFor(site), JSON.stringify({
      site, accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token',
      expiresAt: Date.now() + 86400_000, uid: 'fixture-user',
      enterpriseId: 'fixture-enterprise', domain: 'fixture-domain',
    }), { mode: 0o600 });
  }
});
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  restoreConfigDir();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('fetchModels: site-specific model directory', () => {
  test('intl-cli uses the native /v3/config directory and preserves headers/filtering', async () => {
    mode = 'cli-only';
    const result = await fetchModels(mkCfg(), 'intl-cli');
    assert.deepEqual(requests.map(r => r.path), ['/v3/config']);
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].headers.accept, 'application/json');
    assert.equal(requests[0].headers.authorization, 'Bearer fixture-access-token');
    assert.equal(requests[0].headers['x-user-id'], 'fixture-user');
    assert.equal(requests[0].headers['x-enterprise-id'], 'fixture-enterprise');
    assert.equal(requests[0].headers['x-domain'], 'fixture-domain');
    assert.deepEqual(result, [{
      id: 'cli-model', name: 'Fixture CLI', credits: 'x1 credits',
      contextWindow: 4096, maxTokens: 2048,
      supportsImages: true, supportsToolCall: true, supportsReasoning: true,
    }]);
  });

  for (const site of ['cn-cli', 'intl-work']) {
    test(`${site} retains its existing console-directory transport`, async () => {
      const result = await fetchModels(mkCfg(), site);
      assert.deepEqual(requests.map(r => r.path), [consolePath]);
      assert.deepEqual(result.map(m => m.id), ['cli-model']);
    });
  }

  test('empty CLI membership retains the existing non-disabled fallback', async () => {
    mode = 'empty-agent-models';
    const result = await fetchModels(mkCfg(), 'intl-cli');
    assert.deepEqual(result.map(m => m.id), ['cli-model', 'image-only']);
  });

  test('intl-cli HTTP failures remain available to the catalog fallback', async () => {
    mode = 'http-error';
    await assert.rejects(fetchModels(mkCfg(), 'intl-cli'), error =>
      error.status === 500 && error.site === 'intl-cli' && /HTTP 500/.test(error.message));
  });

  test('malformed metadata retains the existing 502 classification', async () => {
    mode = 'malformed';
    await assert.rejects(fetchModels(mkCfg(), 'intl-cli'), error =>
      error.status === 502 && error.site === 'intl-cli' && /无法解析/.test(error.message));
  });

  test('nonzero business codes retain the existing error classification', async () => {
    mode = 'business-error';
    await assert.rejects(fetchModels(mkCfg(), 'intl-cli'), error =>
      error.status === 502 && error.site === 'intl-cli' && /code=7/.test(error.message));
  });

  test('intl-cli directory requests remain bounded by metaMs', async () => {
    mode = 'hang';
    await assert.rejects(fetchModels(mkCfg(150), 'intl-cli'), error =>
      error.status === 504 && error.site === 'intl-cli' && error.transport === true);
  });
});
