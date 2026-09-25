// settings/translator/googleTranslator.js
// Uses Google's public (undocumented) "gtx" translate endpoint - the same
// one many small free tools use. No API key required, but it's not an
// official/supported API: it can rate-limit, change its response shape,
// or stop working without notice. For heavier/production use, Google's
// official Cloud Translation API (paid, key-based) would be the
// supported alternative - this is deliberately the simple/free option,
// and also serves as the reference example for writing your own script
// here to connect a different translation engine.
//
// Every translator script in this folder must export:
//   async function translate(text, fromLang, toLang) -> Promise<string>
// fromLang/toLang are short codes (e.g. "ja", "en", "zh", "ko").

const https = require('https');
const { URL } = require('url');

async function translate(text, fromLang, toLang) {
  if (!text || !text.trim()) return '';

  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', fromLang || 'ja');
  url.searchParams.set('tl', toLang || 'en');
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', text);

  const body = await get(url.toString());

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error('googleTranslator: unexpected response (not JSON) - the endpoint may have changed or rate-limited this request');
  }

  // Response shape: [[[translatedChunk, originalChunk, ...], ...], ...]
  const segments = parsed && parsed[0];
  if (!Array.isArray(segments)) {
    throw new Error('googleTranslator: unexpected response shape');
  }

  return segments.map(seg => seg[0]).join('');
}

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`googleTranslator: HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

module.exports = { translate };
