// A custom OpenAI-compatible provider: the user's own hosted model (a company gateway, a self-hosted server...). It
// rides on gg-core's generic "local" provider (what Ollama uses), as a second credential, local:custom, so nothing in
// the agent framework changes: the stored address and key go to the model id local/custom/<model name>.
//
// The address is the user's own, so it is NOT checked with safety.mjs' checkUrl (that one blocks private and
// internal hosts on purpose, for web pages the model asked to fetch). It only has to be a sane https address; the
// whole conversation, screenshots included, goes there.
import { localAuthStorageKey, parseLocalModelId, toModelInfo } from '@kenkaiiii/gg-core';
import { MIN_CONTEXT } from './local.mjs';

export const CUSTOM_ID = 'custom';
export const CUSTOM_KEY = localAuthStorageKey(CUSTOM_ID);
export const DEFAULT_NAME = 'My AI';

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/i;

/** Is this one of our custom models (local/custom/...)? */
export const isCustomModel = (id) => parseLocalModelId(String(id ?? ''))?.endpointId === CUSTOM_ID;

/**
 * Checks what the user typed. → { ok: true, value: { name, baseUrl, key, model } } or { ok: false, why } (plain words).
 * `key` may be '' (a server that needs none). A bare host gets /v1, which is where OpenAI-style servers answer.
 */
export function cleanCustom({ name, address, key, model } = {}) {
  const text = (v, max) => String(v ?? '').trim().slice(0, max);
  const raw = text(address, 500);
  if (!raw) return { ok: false, why: 'Type the address of your AI server.' };
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return { ok: false, why: "That doesn't look like an address. It should start with https://" }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, why: 'The address has to start with https://' };
  if (u.username || u.password) return { ok: false, why: "Don't put a name or password in the address. Use the API key box." };
  if (u.search || u.hash) return { ok: false, why: 'The address should be just the server, without a ? or # part.' };
  if (u.protocol === 'http:' && !LOOPBACK.test(u.hostname)) return { ok: false, why: 'The address has to start with https:// so your key travels safely. (http:// is only fine for a server on this computer.)' };
  const path = u.pathname.replace(/\/+$/, '');
  const baseUrl = `${u.origin}${path || '/v1'}`;
  const modelName = text(model, 200);
  if (!modelName) return { ok: false, why: 'Type the model name your server expects.' };
  if (/\s/.test(modelName)) return { ok: false, why: "The model name can't have spaces in it." };
  return { ok: true, value: { name: text(name, 40) || DEFAULT_NAME, baseUrl, key: text(key, 1000), model: modelName } };
}

/**
 * How a saved key is shown: the first three characters, the rest as *. A key of six characters or fewer is shown as
 * all * (three characters would give away half of it).
 */
export function maskKey(key) {
  const k = String(key ?? '');
  if (!k) return '';
  return k.length > 6 ? k.slice(0, 3) + '*'.repeat(k.length - 3) : '*'.repeat(k.length);
}

/** The server's host, for comparing "the same server" (a changed path or port is still the same machine). */
export const hostOf = (baseUrl) => { try { return new URL(baseUrl).hostname.toLowerCase(); } catch { return ''; } };

/** The model entry gg-core needs (id, name, window...). Text only, 32k window, no thinking: nothing is guessed about the server. */
export function customModelInfo({ name, baseUrl, model }) {
  return toModelInfo(
    { endpointId: CUSTOM_ID, rawId: model, contextWindow: MIN_CONTEXT, supportsThinking: false, supportsImages: false },
    { id: CUSTOM_ID, label: name || DEFAULT_NAME, baseUrl, kind: 'custom' },
  );
}

const mention = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);

/** Why a request never got an answer, in plain words, with the technical code at the end so it can be looked up. */
export function reachWhy(e) {
  const code = String(e?.cause?.code ?? e?.code ?? '');
  const tail = code ? ` (${code})` : e?.message && e.message !== 'fetch failed' ? ` (${mention(e.message)})` : '';
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || /TIMEDOUT|CONNECT_TIMEOUT/.test(code)) return `The server didn't answer in time. Check the address and that it's running${tail}.`;
  if (/^(ENOTFOUND|EAI_AGAIN)$/.test(code)) return `I couldn't find that server by name. Check how the address is spelled${tail}.`;
  if (code === 'ECONNREFUSED') return `The server refused the connection. Check the address and port, and that it's running${tail}.`;
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|SSL/.test(code)) return `This computer doesn't trust the server's security certificate. A company certificate may need to be installed${tail}.`;
  if (/ECONNRESET|SOCKET|EPIPE/.test(code)) return `The connection was closed before the server answered. A proxy or firewall may be in the way${tail}.`;
  return `I couldn't reach that address. Check it, and that this computer can get to it (a proxy may be needed)${tail}.`;
}

/**
 * One tiny request to the server before anything is saved, so a wrong address, key or model name shows up now, in
 * plain words, not as a failed chat later. → { ok: true } or { ok: false, why }.
 */
export async function testCustom({ baseUrl, key, model }, { fetchImpl = fetch, timeoutMs = 25_000 } = {}) {
  const ask = (tokens) => fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the word ok.' }], [tokens]: 8, stream: false }),
    redirect: 'error', // a redirect could carry the key somewhere else
    signal: AbortSignal.timeout(timeoutMs),
  });
  let res;
  try {
    res = await ask('max_tokens');
    if (res.status === 400 || res.status === 422) {
      const body = await res.text().catch(() => '');
      // Newer servers only take max_completion_tokens.
      if (/max_completion_tokens|max_tokens/i.test(body)) res = await ask('max_completion_tokens');
      else return { ok: false, why: `The server didn't accept the request: ${mention(body) || res.status}` };
    }
  } catch (e) {
    return { ok: false, why: reachWhy(e) };
  }
  if (res.ok) return { ok: true };
  const body = mention(await res.text().catch(() => ''));
  if (res.status === 401 || res.status === 403) return { ok: false, why: 'The server refused the API key. Check the key and try again.' };
  if (res.status === 404) return { ok: false, why: `The server doesn't know that address or model name${body ? ` (${body})` : ''}. Check both.` };
  if (res.status === 429) return { ok: true }; // it answered and knows us: busy is not wrong
  return { ok: false, why: `The server answered with an error (${res.status})${body ? `: ${body}` : ''}.` };
}

/**
 * Saves what the form holds, then tests it, and says how it went. The settings are kept whatever the test says (so
 * they never "disappear" because a server was down for a minute); only a form that can't be read at all saves
 * nothing, and says why. `input.keepKey`: the key box was left as shown (masked), so the saved key stays, whatever
 * else changed: a provider that moves to a new address usually keeps its key. `saved`: the stored credential
 * ({ accessToken, baseUrl }) or null. → { ok, why, saved, value? }: ok is the test's result, saved is whether
 * anything was kept.
 */
export async function saveCustom(auth, input, { saved = null, test = testCustom } = {}) {
  const r = cleanCustom(input);
  if (!r.ok) return { ok: false, saved: false, why: r.why };
  const { name, baseUrl, model } = r.value;
  let key = r.value.key;
  if (!key && input?.keepKey && saved?.accessToken && saved.accessToken !== 'local') key = saved.accessToken;
  await auth.setLocalEndpoint(CUSTOM_ID, baseUrl, key || undefined);
  const t = await test({ baseUrl, key, model });
  return { ok: t.ok, why: t.ok ? '' : t.why, saved: true, value: { name, baseUrl, model } };
}
