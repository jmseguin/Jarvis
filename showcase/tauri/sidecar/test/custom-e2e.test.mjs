// The custom provider end to end, against a mock OpenAI-compatible server on this computer: the form's checks, the test
// request, the saved credential, and a real agent chat over it (streaming, with the key and model name on the wire).
// Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '@kenkaiiii/gg-agent';
import { AuthStorage, clearRuntimeModels, getAuthStorageKeys, registerRuntimeModels } from '@kenkaiiii/gg-core';
import { agentEvents } from '../agentstream.mjs';
import { CUSTOM_ID, CUSTOM_KEY, cleanCustom, customModelInfo, testCustom } from '../custom.mjs';

const KEY = 'sk-test-12345';
const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = body ? JSON.parse(body) : null;
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: json });
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"no such route"}}'); }
    if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"bad key"}}'); }
    if (json.model !== 'house-model') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"model not found"}}'); }
    if (!json.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: json.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: json.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.write(chunk({ role: 'assistant', content: '' }));
    res.write(chunk({ content: 'hello ' }));
    res.write(chunk({ content: 'from the house model' }));
    res.write(chunk({}, 'stop'));
    res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: json.model, choices: [], usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-assistant-custom-'));
const cleanup = () => { server.close(); server.closeAllConnections?.(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } };
// Windows can briefly lock a file an antivirus is scanning: try the write again.
const retry = async (fn, n = 5) => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= n || e?.code !== 'EPERM') throw e; await new Promise((r) => setTimeout(r, 150 * (i + 1))); } } };

try {
  // The form's input: a bare local address gets /v1, and the checks pass.
  const r = cleanCustom({ name: 'House AI', address: origin, key: KEY, model: 'house-model' });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.value.baseUrl, `${origin}/v1`);

  // The test request: wrong key, wrong model and the right setup.
  assert.match((await testCustom({ ...r.value, key: 'nope' })).why, /refused the API key/);
  assert.match((await testCustom({ ...r.value, model: 'other' })).why, /address or model name/);
  assert.deepEqual(await testCustom(r.value), { ok: true });
  assert.equal(seen.at(-1).auth, `Bearer ${KEY}`);

  // Saved like the app does it, and read back the way the agent resolves it.
  const auth = new AuthStorage(path.join(dir, 'auth.json'));
  await retry(() => auth.setLocalEndpoint(CUSTOM_ID, r.value.baseUrl, r.value.key));
  assert.equal(await auth.hasCredentials(CUSTOM_KEY), true);
  const info = customModelInfo(r.value);
  registerRuntimeModels([info]);
  const creds = await auth.resolveCredentials('local', { storageKeys: getAuthStorageKeys('local', info.id) });
  assert.equal(creds.baseUrl, `${origin}/v1`, 'the stored address comes back with the credential');
  assert.equal(creds.accessToken, KEY);

  // A real chat over it: streamed text arrives, with the key and the typed model name on the wire.
  seen.length = 0;
  const agent = new Agent({
    provider: 'local', model: info.id, system: 'You are a test.', tools: [], maxTurns: 1, supportsImages: false,
    resolveCredentials: async () => ({ apiKey: creds.accessToken }), baseUrl: creds.baseUrl,
  });
  let text = '';
  for await (const e of agentEvents(agent.prompt('say hi'))) {
    if (e.type === 'text_delta') text += e.text;
    else if (e.type === 'error') throw e.error;
  }
  assert.equal(text, 'hello from the house model');
  const call = seen.find((c) => c.url === '/v1/chat/completions');
  assert.ok(call, 'the chat reached the server');
  assert.equal(call.auth, `Bearer ${KEY}`);
  assert.equal(call.body.model, 'house-model', 'the wire carries the typed name, not local/custom/...');
  assert.equal(call.body.stream, true);

  // No key at all: a server that needs none gets no Authorization header.
  await retry(() => auth.setLocalEndpoint(CUSTOM_ID, r.value.baseUrl));
  const bare = await auth.resolveCredentials('local', { storageKeys: [CUSTOM_KEY] });
  assert.equal(bare.accessToken, 'local', "gg-core's marker for 'no key'");
  assert.equal(bare.baseUrl, `${origin}/v1`);
} finally {
  clearRuntimeModels((m) => m.authStorageKeys?.includes(CUSTOM_KEY));
  cleanup();
}
console.log('custom end-to-end tests: ok');
