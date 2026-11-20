// Real handler + local metadata transport regressions. All authentication is
// disposable fixture data; no production account, inference or billing is used.
import { describe, test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { authPathFor, setConfigDir } from '../src/config.mjs';
import { getCatalog, resolveTarget } from '../src/router.mjs';
import { handleModels } from '../src/openai.mjs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-model-display-'));
const restoreConfigDir = setConfigDir(tmpDir);
let baseUrl;
let requests = [];
let hy3Credits = 'x0.00';
const metadataModels = () => [
  { id: 'hy3', name: 'Hy3', credits: hy3Credits },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', credits: 'x0.00' },
  { id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash', credits: 'x0.03' },
  { id: 'hy4-preview', name: 'Hy4 Preview', credits: 'x0.29' },
  { id: 'hy4flash-free', name: 'Hy4 flash', credits: 'x0.00' },
  { id: 'unknown-rate', name: 'Unknown' },
  { id: 'already-labelled', name: 'Fixture (Free)', credits: 'x0.00' },
].map(model => ({ ...model, maxInputTokens: 4096, maxOutputTokens: 2048,
  supportsImages: true, supportsToolCall: true }));

const upstream = http.createServer((req, res) => {
  requests.push({ method: req.method, path: req.url });
  if (!['/v3/config', '/console/enterprises/personal/models'].includes(req.url)) {
    res.writeHead(404); return res.end('unexpected fixture request');
  }
  const models = metadataModels();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 0, data: { models,
    agents: [{ name: 'cli', models: models.map(model => model.id) }] } }));
});

const mkCfg = (site = 'intl-cli', labelFreeModels) => ({
  defaultSite: site,
  defaultModel: 'hy3',
  allowModels: [],
  excludeModels: [],
  modelAliases: { fast: 'hy3', smart: `${site}/deepseek-v4.1-flash` },
  modelRoutes: { hy3: site },
  exposeSitePrefixed: false,
  timeouts: { metaMs: 2000 },
  sites: { [site]: { enabled: true, apiBase: baseUrl,
    origin: 'https://fixture.invalid', userAgent: 'DisplayFixture/1', product: 'SaaS',
    ...(labelFreeModels === undefined ? {} : { labelFreeModels }) } },
});

async function list(cfg) {
  let body;
  const res = {
    headersSent: false,
    writeHead(status, headers) {
      assert.equal(status, 200);
      assert.match(headers['Content-Type'], /application\/json/);
      this.headersSent = true;
    },
    end(text) { body = JSON.parse(text); },
  };
  await handleModels({ cfg, res });
  assert.equal(body.object, 'list');
  assert.equal(body.data.length, new Set(body.data.map(model => model.id)).size);
  return body.data;
}

before(async () => {
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${upstream.address().port}`;
});
beforeEach(() => {
  setConfigDir(tmpDir);
  requests = []; hy3Credits = 'x0.00';
  for (const site of ['cn-cli', 'intl-cli']) {
    fs.writeFileSync(authPathFor(site), JSON.stringify({ site,
      accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token',
      expiresAt: Date.now() + 86400_000, uid: 'fixture-user',
      enterpriseId: 'fixture-enterprise', domain: 'fixture-domain' }), { mode: 0o600 });
  }
});
after(async () => {
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  restoreConfigDir();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('handleModels: Free labels are display-only', () => {
  test('zero-priced models are labelled, paid variants and unknown rates are not', async () => {
    const cfg = mkCfg();
    await getCatalog(cfg, 'intl-cli', { force: true });
    const models = await list(cfg);
    const byId = new Map(models.map(model => [model.id, model]));
    assert.equal(byId.get('hy3').name, 'Hy3 (Free)');
    assert.equal(byId.get('deepseek-v4.1-flash').name, 'Deepseek-V4.1-Flash (Free)');
    assert.equal(byId.get('deepseek-v4.1-flash-sg').name, 'Deepseek-V4.1-Flash');
    assert.equal(byId.get('hy4-preview').name, 'Hy4 Preview');
    assert.equal(byId.get('unknown-rate').name, 'Unknown');
    assert.equal(byId.get('hy4flash-free').name, 'Hy4 flash (Free)');
    assert.equal(byId.get('already-labelled').name, 'Fixture (Free)');
    assert.equal(byId.get('hy3').credits_multiplier, 0);
    assert.equal(byId.get('deepseek-v4.1-flash-sg').credits_multiplier, 0.03);
    assert.equal(byId.get('hy4-preview').credits_multiplier, 0.29);
    assert.equal('credits_multiplier' in byId.get('unknown-rate'), false);
    assert.equal(byId.get('hy3').context_window, 4096);
    assert.equal(byId.get('hy3').max_output_tokens, 2048);
    assert.equal(byId.get('hy3').supports_images, true);
    assert.equal(byId.get('hy3').supports_tools, true);
    assert.deepEqual(models.map(model => model.id).sort(),
      ['fast', 'smart', ...metadataModels().map(model => model.id)].sort());
    assert.ok(requests.length > 0);
    assert.ok(requests.every(request => request.path === '/v3/config' && request.method === 'GET'));
  });

  test('site flag false restores names without changing IDs or any other API fields', async () => {
    const cfg = mkCfg('intl-cli', false);
    await getCatalog(cfg, 'intl-cli', { force: true });
    const plain = await list(cfg);
    cfg.sites['intl-cli'].labelFreeModels = true;
    const labelled = await list(cfg);
    const withoutName = models => models.map(({ name, ...model }) => model);
    assert.deepEqual(withoutName(labelled), withoutName(plain));
    assert.equal(plain.find(model => model.id === 'hy3').name, 'Hy3');
    assert.equal(labelled.find(model => model.id === 'hy3').name, 'Hy3 (Free)');
  });

  test('aliases, explicit routes, default and current keep resolving original IDs', async () => {
    const cfg = mkCfg();
    await getCatalog(cfg, 'intl-cli', { force: true });
    const before = JSON.stringify(cfg);
    await list(cfg);
    for (const [requested, expected] of [
      ['fast', 'hy3'], ['smart', 'deepseek-v4.1-flash'], ['hy3', 'hy3'],
      ['intl-cli/hy3', 'hy3'], ['default', 'hy3'], ['current', 'hy3'],
    ]) {
      const target = await resolveTarget(cfg, requested);
      assert.equal(target.site, 'intl-cli');
      assert.equal(target.model, expected);
    }
    assert.equal(JSON.stringify(cfg), before);
    const aliases = (await list(cfg)).filter(model => ['fast', 'smart'].includes(model.id));
    assert.equal(aliases.find(model => model.id === 'fast').name, 'fast → hy3');
    assert.equal(aliases.find(model => model.id === 'smart').name, 'smart → intl-cli/deepseek-v4.1-flash');
  });

  test('catalog cache retains raw names and a nonzero price removes only the generated label', async () => {
    const cfg = mkCfg();
    await getCatalog(cfg, 'intl-cli', { force: true });
    assert.equal((await list(cfg)).find(model => model.id === 'hy3').name, 'Hy3 (Free)');
    assert.equal((await getCatalog(cfg, 'intl-cli')).models.get('hy3').name, 'Hy3');
    hy3Credits = 'x0.29';
    await getCatalog(cfg, 'intl-cli', { force: true });
    const updated = (await list(cfg)).find(model => model.id === 'hy3');
    assert.equal(updated.id, 'hy3');
    assert.equal(updated.name, 'Hy3');
    assert.equal(updated.credits_multiplier, 0.29);
  });

  test('domestic directory uses the same opt-out rule without renaming its free ID', async () => {
    const cfg = mkCfg('cn-cli');
    await getCatalog(cfg, 'cn-cli', { force: true });
    const models = await list(cfg);
    const free = models.find(model => model.id === 'hy4flash-free');
    assert.equal(free.id, 'hy4flash-free');
    assert.equal(free.name, 'Hy4 flash (Free)');
    assert.equal(free.credits_multiplier, 0);
    assert.ok(requests.every(request => request.path === '/console/enterprises/personal/models'));
  });
});
