// Regression: the international chat endpoint requires conversation metadata.
// All credentials below are fixtures; no production configuration is loaded.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chatHeaders, commonHeaders, refreshHeaders, billingHeaders } from '../src/headers.mjs';
import { prepareBody } from '../src/upstream.mjs';

const conversationHeaders = [
  'X-Conversation-Id',
  'X-Conversation-Request-Id',
  'X-Conversation-Message-Id',
];
const intl = {
  origin: 'https://www.codebuddy.ai',
  userAgent: 'CLI/2.185.0 CodeBuddy/2.185.0',
  product: 'SaaS',
};
const auth = {
  accessToken: 'fixture-access-token',
  refreshToken: 'fixture-refresh-token',
  uid: 'fixture-account',
  domain: 'www.codebuddy.ai',
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hexId = /^[0-9a-f]{32}$/;

describe('chatHeaders: international conversation metadata', () => {
  test('provides the three conversation headers in accepted UUID formats', () => {
    const h = chatHeaders(intl, auth);
    assert.match(h['X-Conversation-Id'], uuid);
    assert.match(h['X-Conversation-Request-Id'], hexId);
    assert.match(h['X-Conversation-Message-Id'], hexId);
  });

  test('uses the same identifier for the model message and HTTP request', () => {
    const h = chatHeaders(intl, auth);
    assert.equal(h['X-Conversation-Message-Id'], h['X-Request-ID']);
  });

  test('isolates stateless requests rather than reusing a global conversation', () => {
    const batch = Array.from({ length: 32 }, () => chatHeaders(intl, auth));
    for (const key of conversationHeaders) {
      assert.equal(new Set(batch.map(h => h[key])).size, batch.length, key);
    }
  });

  test('preserves domestic identity while adding compatible metadata', () => {
    const cn = { ...intl, origin: 'https://www.codebuddy.cn' };
    const h = chatHeaders(cn, { ...auth, domain: 'www.codebuddy.cn' });
    assert.equal(h.Origin, cn.origin);
    assert.equal(h['X-Domain'], 'www.codebuddy.cn');
    for (const key of conversationHeaders) assert.ok(h[key], key);
  });

  test('preserves authorization and does not send the refresh token to chat', () => {
    const h = chatHeaders(intl, auth);
    assert.equal(h.Authorization, 'Bearer fixture-access-token');
    assert.equal(h['X-User-Id'], auth.uid);
    assert.equal(h['X-Product'], 'SaaS');
    assert.equal(h['User-Agent'], intl.userAgent);
    assert.equal(h['X-Refresh-Token'], undefined);
  });

  test('does not put conversation identifiers into generic headers', () => {
    const h = commonHeaders(intl);
    for (const key of conversationHeaders) assert.equal(h[key], undefined);
  });

  test('keeps refresh and billing header policies separate from chat metadata', () => {
    const refresh = refreshHeaders(intl, auth);
    const billing = billingHeaders(intl, auth);
    assert.equal(refresh['X-Refresh-Token'], auth.refreshToken);
    assert.equal(billing['X-Refresh-Token'], undefined);
    for (const key of conversationHeaders) {
      assert.equal(refresh[key], undefined);
      assert.equal(billing[key], undefined);
    }
  });

  test('retains the existing first-system and upstream-stream adaptations', () => {
    const src = { model: 'fixture-model', stream: false, messages: [{ role: 'user', content: 'OK' }] };
    const body = prepareBody({ defaultSystemPrompt: 'fixture-system', stripFields: [] }, src);
    assert.equal(body.stream, true);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[0].content, 'fixture-system');
    assert.equal(body.messages[1].role, 'user');
    assert.equal(src.stream, false);
  });
});
