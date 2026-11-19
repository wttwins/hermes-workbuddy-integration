// Local HTTP fixture only: test retry metadata without calling a real provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authPathFor, setConfigDir } from '../src/config.mjs';
import { openChat } from '../src/upstream.mjs';

test('one chat keeps correlation headers across retries; the next chat is isolated', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-correlation-'));
  const restore = setConfigDir(dir);
  t.after(() => {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(authPathFor('intl-cli'), JSON.stringify({
    site: 'intl-cli',
    accessToken: 'fixture-access-token',
    refreshToken: 'fixture-refresh-token',
    expiresAt: Date.now() + 86400_000,
    uid: 'fixture-user',
    domain: 'www.codebuddy.ai',
  }));

  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (received.length === 1) return req.socket.destroy();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"content":"fixture-ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const port = server.address().port;
  const cfg = {
    defaultSite: 'intl-cli',
    defaultSystemPrompt: 'fixture-system',
    stripFields: [],
    context: { enabled: false },
    upstreamRetry: { attempts: 2, backoffMs: [0] },
    timeouts: { headerMs: 2000, idleMs: 2000 },
    sites: { 'intl-cli': {
      enabled: true,
      apiBase: `http://127.0.0.1:${port}`,
      origin: 'https://www.codebuddy.ai',
      userAgent: 'fixture-client',
      product: 'SaaS',
    } },
  };
  const body = { model: 'fixture-model', stream: false, messages: [{ role: 'user', content: 'fixture-user-text' }] };
  const first = await openChat(cfg, 'intl-cli', body);
  assert.equal(first.ok, true);
  for await (const _ of first.frames) { /* consume the local fixture stream */ }
  assert.equal(received.length, 2);
  const keys = ['x-conversation-id', 'x-conversation-request-id', 'x-conversation-message-id'];
  for (const key of keys) {
    assert.ok(received[0].headers[key], key);
    assert.equal(received[0].headers[key], received[1].headers[key], `${key} must survive retry`);
  }
  assert.equal(received[1].body.stream, true);
  assert.equal(received[1].body.messages[0].role, 'system');

  const second = await openChat(cfg, 'intl-cli', body);
  assert.equal(second.ok, true);
  for await (const _ of second.frames) { /* consume the second local stream */ }
  assert.equal(received.length, 3);
  for (const key of keys) assert.notEqual(received[2].headers[key], received[0].headers[key], key);
});
