// Translation providers. Configure ONE in server/.env (checked in this order):
//   DEEPL_API_KEY            DeepL (free keys end in ":fx" and use the free endpoint automatically)
//   GOOGLE_TRANSLATE_API_KEY Google Cloud Translation (Basic, v2): the widest language coverage
//   LIBRETRANSLATE_URL       a LibreTranslate server (self-hosted is free); LIBRETRANSLATE_API_KEY is optional
// With none set, translation is simply off and the site hides the feature.
// The language list is NOT hard-coded: each provider is asked which languages it supports, so readers can
// translate into every language your provider offers.

// Only used if the provider's own list can't be fetched.
export const FALLBACK_LANGS = ['en', 'ja', 'ar', 'zh', 'ko', 'es', 'fr', 'de', 'pt', 'ru', 'it', 'id', 'tr', 'nl', 'pl', 'uk',
  'hi', 'th', 'vi', 'he', 'fa', 'bn', 'ur', 'ms', 'sv', 'da', 'fi', 'no', 'el', 'cs', 'hu', 'ro', 'bg', 'sr', 'hr', 'sk', 'sl',
  'lt', 'lv', 'et', 'ca', 'sw', 'ta', 'te', 'mr', 'tl'];

export const isLangCode = s => typeof s === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(s);
export const baseLang = code => String(code || '').toLowerCase().split(/[-_]/)[0];
const DEEPL_TARGET = { en: 'EN-US', pt: 'PT-BR', zh: 'ZH-HANS' }; // DeepL wants a variant for these bare codes
const GOOGLE_TARGET = { zh: 'zh-CN' };
const BATCH = 40; // texts per request; DeepL allows 50

async function call(fetchImpl, url, { method = 'POST', headers = {}, body } = {}) {
  const res = await fetchImpl(url, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`translation service answered ${res.status}`);
  return res.json();
}

const adapters = {
  deepl: ({ DEEPL_API_KEY: key }, f) => {
    const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    const headers = { Authorization: `DeepL-Auth-Key ${key}` };
    return {
      name: 'DeepL',
      async languages() { return (await call(f, `${host}/v2/languages?type=target`, { method: 'GET', headers })).map(l => l.language); },
      async run(texts, target) {
        const data = await call(f, `${host}/v2/translate`, { headers, body: { text: texts, target_lang: DEEPL_TARGET[target.toLowerCase()] || target.toUpperCase() } });
        return data.translations.map(t => ({ text: t.text, from: baseLang(t.detected_source_language) }));
      },
    };
  },

  google: ({ GOOGLE_TRANSLATE_API_KEY: key }, f) => {
    const url = path => `https://translation.googleapis.com/language/translate/v2${path}?key=${encodeURIComponent(key)}`;
    return {
      name: 'Google Translate',
      async languages() { return (await call(f, url('/languages'), { method: 'GET' })).data.languages.map(l => l.language); },
      async run(texts, target) {
        const data = await call(f, url(''), { body: { q: texts, target: GOOGLE_TARGET[target.toLowerCase()] || target, format: 'text' } });
        return data.data.translations.map(t => ({ text: t.translatedText, from: baseLang(t.detectedSourceLanguage) }));
      },
    };
  },

  libretranslate: ({ LIBRETRANSLATE_URL: url, LIBRETRANSLATE_API_KEY: key }, f) => {
    const root = url.replace(/\/$/, '');
    return {
      name: 'LibreTranslate',
      async languages() { return (await call(f, `${root}/languages`, { method: 'GET' })).map(l => l.code); },
      async run(texts, target) {
        const data = await call(f, `${root}/translate`, { body: { q: texts, source: 'auto', target, format: 'text', ...(key ? { api_key: key } : {}) } });
        // With several texts LibreTranslate answers with arrays; with one it may answer with single values.
        const out = [].concat(data.translatedText), det = [].concat(data.detectedLanguage ?? []);
        return out.map((text, i) => ({ text, from: baseLang(det[i]?.language ?? det[0]?.language) }));
      },
    };
  },
};

// Returns null when no provider is configured, else { name, languages(), translateMany(texts, target) }.
export function createTranslator(env = process.env, fetchImpl = fetch) {
  const kind = env.DEEPL_API_KEY ? 'deepl' : env.GOOGLE_TRANSLATE_API_KEY ? 'google' : env.LIBRETRANSLATE_URL ? 'libretranslate' : null;
  if (!kind) return null;
  const adapter = adapters[kind](env, fetchImpl);
  let cached = null; // { at, list }
  return {
    name: adapter.name,

    // Every language the provider can translate INTO, remembered for 6 hours.
    async languages() {
      if (cached && Date.now() - cached.at < 6 * 3600e3) return cached.list;
      try {
        const list = [...new Set((await adapter.languages()).filter(isLangCode))].sort();
        if (list.length) { cached = { at: Date.now(), list }; return list; }
      } catch { /* fall through to the last good list or the built-in one */ }
      return cached?.list || FALLBACK_LANGS;
    },

    async translateMany(texts, target) {
      const out = [];
      for (let i = 0; i < texts.length; i += BATCH) out.push(...await adapter.run(texts.slice(i, i + BATCH), target));
      return out.map(r => ({ ...r, same: !!r.from && r.from === baseLang(target) }));
    },
  };
}
