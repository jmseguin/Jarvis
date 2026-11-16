// The custom OpenAI-compatible provider (custom.mjs): what's accepted, the model entry, the test request, and that it
// lives beside Ollama's models. Run: npm test
import assert from 'node:assert/strict';
import { clearRuntimeModels, getAuthStorageKeys, getModel, getModelsForProvider, registerRuntimeModels } from '@kenkaiiii/gg-core';
import { CUSTOM_ID, CUSTOM_KEY, cleanCustom, customModelInfo, hostOf, isCustomModel, maskKey, reachWhy, saveCustom, testCustom } from '../custom.mjs';
import { MIN_CONTEXT, OLLAMA, connectLocal } from '../local.mjs';

const ok = (input) => { const r = cleanCustom(input); assert.equal(r.ok, true, `${JSON.stringify(input)} should pass: ${r.why}`); return r.value; };
const bad = (input, re) => { const r = cleanCustom(input); assert.equal(r.ok, false, `${JSON.stringify(input)} should be refused`); assert.match(r.why, re); };
const base = { name: 'Work AI', address: 'https://llm.example.com/v1', key: 'sk-secret', model: 'gpt-x' };

// ---- what's accepted
assert.deepEqual(ok(base), { name: 'Work AI', baseUrl: 'https://llm.example.com/v1', key: 'sk-secret', model: 'gpt-x' });
assert.equal(ok({ ...base, address: 'llm.example.com' }).baseUrl, 'https://llm.example.com/v1', 'a bare host: https, and /v1 where OpenAI-style servers answer');
assert.equal(ok({ ...base, address: 'https://llm.example.com/' }).baseUrl, 'https://llm.example.com/v1');
assert.equal(ok({ ...base, address: 'https://llm.example.com/v1///' }).baseUrl, 'https://llm.example.com/v1', 'trailing slashes go');
assert.equal(ok({ ...base, address: 'https://gw.corp.internal:8443/openai/deployments/x' }).baseUrl, 'https://gw.corp.internal:8443/openai/deployments/x', 'their own path is kept, and so is a private host');
assert.equal(ok({ ...base, address: 'http://localhost:8000/v1' }).baseUrl, 'http://localhost:8000/v1', 'http is fine for this computer');
assert.equal(ok({ ...base, address: 'http://127.0.0.1:1234' }).baseUrl, 'http://127.0.0.1:1234/v1');
assert.equal(ok({ ...base, key: '' }).key, '', 'a server that needs no key');
assert.equal(ok({ ...base, key: '  sk-x  ' }).key, 'sk-x');
assert.equal(ok({ ...base, name: '' }).name, 'My AI', 'a name is optional');
assert.equal(ok({ ...base, name: 'x'.repeat(80) }).name.length, 40);
assert.equal(ok({ ...base, model: 'vendor/model:7b' }).model, 'vendor/model:7b', 'slashes and colons are part of model names');

// ---- what's refused, in plain words
bad({ ...base, address: '' }, /address of your AI server/);
bad({ ...base, address: 'http://llm.example.com/v1' }, /https:\/\//);
bad({ ...base, address: 'ftp://llm.example.com' }, /https:\/\//);
bad({ ...base, address: 'https://user:pass@llm.example.com' }, /API key box/);
bad({ ...base, address: 'https://llm.example.com/v1?key=1' }, /\? or #/);
bad({ ...base, address: 'https://' }, /address/);
bad({ ...base, model: '' }, /model name/);
bad({ ...base, model: 'my model' }, /spaces/);
for (const why of [cleanCustom({}).why, cleanCustom({ address: 'x y' }).why, cleanCustom({ ...base, model: '' }).why]) assert.ok(!/base ?url|bearer|endpoint|\/v1 /i.test(why ?? ''), `plain words: ${why}`);

// ---- the model entry
const v = ok(base);
const info = customModelInfo(v);
assert.equal(info.id, 'local/custom/gpt-x');
assert.equal(info.provider, 'local');
assert.equal(info.contextWindow, MIN_CONTEXT);
assert.equal(info.supportsImages, false, 'text only: no screenshots are sent');
assert.equal(info.supportsThinking, false);
assert.deepEqual(info.authStorageKeys, [CUSTOM_KEY]);
assert.equal(CUSTOM_KEY, 'local:custom');
assert.match(info.name, /gpt-x/);
assert.match(info.name, /Work AI/);
assert.equal(isCustomModel(info.id), true);
assert.equal(isCustomModel('local/ollama/qwen3.5:4b'), false);
assert.equal(isCustomModel('claude-haiku-5-5'), false);
assert.equal(isCustomModel(undefined), false);

// ---- the test request
const calls = [];
const reply = (status, body = '') => async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return new Response(body, { status }); };
const t = (fetchImpl, over = {}) => testCustom({ baseUrl: v.baseUrl, key: v.key, model: v.model, ...over }, { fetchImpl, timeoutMs: 500 });

assert.deepEqual(await t(reply(200, '{"choices":[]}')), { ok: true });
assert.equal(calls[0].url, 'https://llm.example.com/v1/chat/completions');
assert.equal(calls[0].init.headers.authorization, 'Bearer sk-secret');
assert.equal(calls[0].body.model, 'gpt-x');
assert.equal(calls[0].body.max_tokens, 8, 'one tiny request');
assert.equal(calls[0].init.redirect, 'error', "a redirect must not carry the key somewhere else");
calls.length = 0;
await t(reply(200), { key: '' });
assert.equal('authorization' in calls[0].init.headers, false, 'no key, no Authorization header');

const refused = await t(reply(401, '{"error":"bad key"}'));
assert.equal(refused.ok, false); assert.match(refused.why, /refused the API key/);
assert.match((await t(reply(403))).why, /refused the API key/);
const missing = await t(reply(404, '{"error":{"message":"model not found"}}'));
assert.equal(missing.ok, false); assert.match(missing.why, /address or model name/); assert.match(missing.why, /model not found/);
assert.match((await t(reply(500, 'boom'))).why, /error \(500\)/);
assert.deepEqual(await t(reply(429)), { ok: true }, 'busy is not wrong');
assert.ok(!JSON.stringify(await t(reply(401))).includes('sk-secret'), 'the key is never in a message');

// Some servers only take max_completion_tokens.
{
  calls.length = 0;
  let n = 0;
  const twice = async (url, init) => { calls.push(JSON.parse(init.body)); return n++ === 0 ? new Response('Unsupported parameter: max_tokens', { status: 400 }) : new Response('{}', { status: 200 }); };
  assert.deepEqual(await t(twice), { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].max_completion_tokens, 8);
  assert.equal('max_tokens' in calls[1], false);
}
assert.match((await t(reply(400, 'invalid model parameter'))).why, /didn't accept the request/);

assert.match((await t(async () => { throw new TypeError('fetch failed'); })).why, /couldn't reach that address/);
assert.match((await t(async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); })).why, /didn't answer in time/);

// ---- it lives beside Ollama's models, and a rescan of Ollama doesn't drop it
const saved = [];
const auth = { setLocalEndpoint: async (id, baseUrl) => saved.push([id, baseUrl]) };
const ollamaProbe = { endpoint: OLLAMA, reachable: true, models: [{ rawId: 'qwen3.5:4b', endpointId: 'ollama', contextWindow: 32768, contextWindowKnown: true, supportsTools: true, supportsImages: true, supportsThinking: true }] };
registerRuntimeModels([info]);
await connectLocal(auth, { probe: async () => ollamaProbe });
assert.deepEqual(getModelsForProvider('local').map((m) => m.id).sort(), ['local/custom/gpt-x', 'local/ollama/qwen3.5:4b'], 'both are there');
await connectLocal(auth, { probe: async () => ({ ...ollamaProbe, models: [] }) });
assert.deepEqual(getModelsForProvider('local').map((m) => m.id), ['local/custom/gpt-x'], 'Ollama losing its models leaves the custom one');
assert.equal(getModel('local/custom/gpt-x').contextWindow, MIN_CONTEXT);
assert.deepEqual(getAuthStorageKeys('local', 'local/custom/gpt-x'), [CUSTOM_KEY], 'it runs on the saved custom credential');
clearRuntimeModels((m) => m.authStorageKeys?.includes(CUSTOM_KEY));
assert.equal(getModel('local/custom/gpt-x'), undefined, 'signing out can remove it');
assert.equal(CUSTOM_ID, 'custom');

// ---- the saved key is shown masked: the first three characters, the rest as *
assert.equal(maskKey('sk-abcdef123456'), 'sk-************');
assert.equal(maskKey('sk-abcdef123456').length, 'sk-abcdef123456'.length);
assert.equal(maskKey('abcdefg'), 'abc****', 'seven characters: the first three show');
assert.equal(maskKey('abcdef'), '******', 'six or fewer: all hidden, three would give away half');
assert.equal(maskKey('abc'), '***');
assert.equal(maskKey(''), '');
assert.equal(maskKey(undefined), '');
assert.equal(hostOf('https://LLM.example.com:8443/v1'), 'llm.example.com');
assert.equal(hostOf('not a url'), '');

// ---- why a request got no answer, in plain words (the code stays at the end for lookups)
const why = (code, name) => reachWhy(Object.assign(new TypeError('fetch failed'), { cause: { code }, ...(name ? { name } : {}) }));
assert.match(why('ENOTFOUND'), /couldn't find that server by name.*\(ENOTFOUND\)/);
assert.match(why('ECONNREFUSED'), /refused the connection.*\(ECONNREFUSED\)/);
assert.match(why('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), /doesn't trust the server's security certificate.*\(UNABLE_TO_VERIFY_LEAF_SIGNATURE\)/);
assert.match(why('SELF_SIGNED_CERT_IN_CHAIN'), /certificate/);
assert.match(why('ETIMEDOUT'), /didn't answer in time/);
assert.match(why('UND_ERR_CONNECT_TIMEOUT'), /didn't answer in time/);
assert.match(why('ECONNRESET'), /connection was closed.*proxy or firewall/);
assert.match(why('SOMETHING_ELSE'), /couldn't reach that address.*\(SOMETHING_ELSE\)/);
assert.doesNotMatch(reachWhy(new TypeError('fetch failed')), /\(\)|undefined/, 'no code: no empty brackets');

// ---- saving: the settings are kept whatever the test says
{
  const stored = [];
  const auth = { setLocalEndpoint: async (...a) => stored.push(a) };
  const pass = async () => ({ ok: true });
  const fail = async () => ({ ok: false, why: 'The server refused the API key. Check the key and try again.' });
  const form = { name: 'Work AI', address: 'https://llm.example.com/v1', key: 'sk-secret', model: 'gpt-x' };

  // A form that can't be read saves nothing and says why.
  let r = await saveCustom(auth, { ...form, model: '' }, { test: pass });
  assert.deepEqual([r.ok, r.saved], [false, false]); assert.match(r.why, /model name/);
  r = await saveCustom(auth, { ...form, address: '' }, { test: pass });
  assert.deepEqual([r.ok, r.saved], [false, false]); assert.match(r.why, /address/);
  assert.equal(stored.length, 0, 'nothing is saved from a form that is not complete');

  // Good form, good server.
  r = await saveCustom(auth, form, { test: pass });
  assert.deepEqual([r.ok, r.saved, r.why], [true, true, '']);
  assert.deepEqual(r.value, { name: 'Work AI', baseUrl: 'https://llm.example.com/v1', model: 'gpt-x' });
  assert.deepEqual(stored.at(-1), ['custom', 'https://llm.example.com/v1', 'sk-secret']);

  // Good form, the test fails: still saved, and the reason is returned.
  stored.length = 0;
  r = await saveCustom(auth, form, { test: fail });
  assert.deepEqual([r.ok, r.saved], [false, true]); assert.match(r.why, /refused the API key/);
  assert.equal(stored.length, 1, 'the settings stay even though the test failed');

  // A key box left as shown (masked) keeps the saved key for the same server...
  const savedCred = { accessToken: 'sk-saved-key', baseUrl: 'https://llm.example.com/v1' };
  stored.length = 0;
  r = await saveCustom(auth, { ...form, key: '', keepKey: true, model: 'other' }, { saved: savedCred, test: pass });
  assert.equal(r.ok, true); assert.equal(stored[0][2], 'sk-saved-key');
  r = await saveCustom(auth, { ...form, key: '', keepKey: true, address: 'https://llm.example.com/other/v2' }, { saved: savedCred, test: pass });
  assert.equal(stored.at(-1)[2], 'sk-saved-key', 'a different path on the same server is still that server');
  // ...but never goes to a different server.
  stored.length = 0;
  r = await saveCustom(auth, { ...form, key: '', keepKey: true, address: 'https://elsewhere.example.org/v1' }, { saved: savedCred, test: pass });
  assert.deepEqual([r.ok, r.saved], [false, false]); assert.match(r.why, /changed the server/);
  assert.equal(stored.length, 0);
  // A new key typed in wins; clearing the box (not "keep") means no key.
  r = await saveCustom(auth, { ...form, key: 'sk-new', keepKey: false }, { saved: savedCred, test: pass });
  assert.equal(stored.at(-1)[2], 'sk-new');
  r = await saveCustom(auth, { ...form, key: '', keepKey: false }, { saved: savedCred, test: pass });
  assert.equal(stored.at(-1)[2], undefined, 'no key: the server needs none');
  // gg-core\'s "no key" marker is not a key to keep.
  r = await saveCustom(auth, { ...form, key: '', keepKey: true }, { saved: { accessToken: 'local', baseUrl: form.address }, test: pass });
  assert.equal(stored.at(-1)[2], undefined);
}

console.log('custom tests: ok');
