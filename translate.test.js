import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslator, FALLBACK_LANGS, isLangCode, baseLang } from './translate.js';

// A fake fetch that records the request and answers with whatever the provider would.
const fake = answer => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined }); return { ok: true, status: 200, json: async () => answer }; };
  return { fetchImpl, calls };
};

test('no provider configured -> null', () => assert.equal(createTranslator({}), null));

test('DeepL: free key uses the free host, English maps to EN-US, detected language comes back', async () => {
  const { fetchImpl, calls } = fake({ translations: [{ detected_source_language: 'JA', text: 'Hello' }, { detected_source_language: 'EN', text: 'Hi' }] });
  const t = createTranslator({ DEEPL_API_KEY: 'abc:fx' }, fetchImpl);
  const out = await t.translateMany(['こんにちは', 'Hi'], 'en');
  assert.equal(calls[0].url, 'https://api-free.deepl.com/v2/translate');
  assert.equal(calls[0].init.headers.Authorization, 'DeepL-Auth-Key abc:fx');
  assert.deepEqual(calls[0].body, { text: ['こんにちは', 'Hi'], target_lang: 'EN-US' });
  assert.deepEqual(out, [{ text: 'Hello', from: 'ja', same: false }, { text: 'Hi', from: 'en', same: true }]);
});

test('DeepL: paid key uses the paid host', async () => {
  const { fetchImpl, calls } = fake({ translations: [{ detected_source_language: 'AR', text: 'x' }] });
  await createTranslator({ DEEPL_API_KEY: 'paidkey' }, fetchImpl).translateMany(['مرحبا'], 'ja');
  assert.equal(calls[0].url, 'https://api.deepl.com/v2/translate');
  assert.equal(calls[0].body.target_lang, 'JA');
});

test('Google: key in the URL, Chinese maps to zh-CN', async () => {
  const { fetchImpl, calls } = fake({ data: { translations: [{ translatedText: '你好', detectedSourceLanguage: 'en' }] } });
  const out = await createTranslator({ GOOGLE_TRANSLATE_API_KEY: 'k e y' }, fetchImpl).translateMany(['hello'], 'zh');
  assert.match(calls[0].url, /\?key=k%20e%20y$/);
  assert.equal(calls[0].body.target, 'zh-CN');
  assert.deepEqual(out, [{ text: '你好', from: 'en', same: false }]);
});

test('LibreTranslate: array answers and single answers both work', async () => {
  const many = fake({ translatedText: ['a', 'b'], detectedLanguage: [{ language: 'ja' }, { language: 'ar' }] });
  const out = await createTranslator({ LIBRETRANSLATE_URL: 'http://lt:5000/', LIBRETRANSLATE_API_KEY: 'k' }, many.fetchImpl).translateMany(['x', 'y'], 'en');
  assert.equal(many.calls[0].url, 'http://lt:5000/translate');
  assert.equal(many.calls[0].body.api_key, 'k');
  assert.deepEqual(out.map(o => o.from), ['ja', 'ar']);
  const one = fake({ translatedText: 'hi', detectedLanguage: { language: 'en' } });
  assert.deepEqual(await createTranslator({ LIBRETRANSLATE_URL: 'http://lt' }, one.fetchImpl).translateMany(['hi'], 'en'), [{ text: 'hi', from: 'en', same: true }]);
});

test('long lists are sent in batches; a failing service throws', async () => {
  const { fetchImpl, calls } = fake({ translations: Array.from({ length: 40 }, () => ({ detected_source_language: 'JA', text: 't' })) });
  const out = await createTranslator({ DEEPL_API_KEY: 'k:fx' }, async (u, i) => {
    const r = await fetchImpl(u, i); const n = JSON.parse(i.body).text.length;
    return { ok: true, json: async () => ({ translations: Array.from({ length: n }, () => ({ detected_source_language: 'JA', text: 't' })) }) };
  }).translateMany(Array.from({ length: 85 }, (_, i) => `t${i}`), 'en');
  assert.equal(out.length, 85); assert.equal(calls.length, 3);
  await assert.rejects(createTranslator({ DEEPL_API_KEY: 'k' }, async () => ({ ok: false, status: 456 })).translateMany(['x'], 'en'), /456/);
});

test('languages: each provider is asked for its full list', async () => {
  const deepl = fake([{ language: 'AR' }, { language: 'EN-GB' }, { language: 'ZH-HANS' }, { language: 'JA' }]);
  const d = await createTranslator({ DEEPL_API_KEY: 'k:fx' }, deepl.fetchImpl).languages();
  assert.deepEqual(d, ['AR', 'EN-GB', 'JA', 'ZH-HANS']);
  assert.equal(deepl.calls[0].url, 'https://api-free.deepl.com/v2/languages?type=target');
  const google = fake({ data: { languages: [{ language: 'af' }, { language: 'zh-CN' }, { language: 'sw' }] } });
  assert.deepEqual(await createTranslator({ GOOGLE_TRANSLATE_API_KEY: 'k' }, google.fetchImpl).languages(), ['af', 'sw', 'zh-CN']);
  const libre = fake([{ code: 'en' }, { code: 'ar' }, { code: 'ja' }]);
  assert.deepEqual(await createTranslator({ LIBRETRANSLATE_URL: 'http://lt' }, libre.fetchImpl).languages(), ['ar', 'en', 'ja']);
});

test('languages: remembered, and falls back when the provider list fails', async () => {
  const f = fake({ data: { languages: [{ language: 'af' }] } });
  const t = createTranslator({ GOOGLE_TRANSLATE_API_KEY: 'k' }, f.fetchImpl);
  await t.languages(); await t.languages();
  assert.equal(f.calls.length, 1); // second call came from memory
  const broken = createTranslator({ GOOGLE_TRANSLATE_API_KEY: 'k' }, async () => ({ ok: false, status: 500 }));
  assert.deepEqual(await broken.languages(), FALLBACK_LANGS);
});

test('language code checks', () => {
  assert.ok(['en', 'ja', 'zh-CN', 'ZH-HANS', 'fil'].every(isLangCode));
  assert.ok(['', 'english', 'x', 'en_US', 'e n', '<b>', null].every(c => !isLangCode(c)));
  assert.equal(baseLang('ZH-HANS'), 'zh');
});
