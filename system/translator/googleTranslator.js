// system/translator/googleTranslator.js
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

// settings/translator/googleTranslator.js

async function translate(text, fromLang, toLang) {
  if (!text || !text.trim()) return '';

  const sl = fromLang || 'ja';
  const tl = toLang || 'en';
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;

  // Use Chromium's native fetch (available globally in NW.js renderer/mixed context)
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': '*/*',
    }
  });

  if (res.status === 429) {
    throw new Error('googleTranslator: Rate limited (HTTP 429). Try again shortly.');
  }

  if (!res.ok) {
    throw new Error(`googleTranslator: HTTP ${res.status}`);
  }

  const parsed = await res.json();

  // Response shape: [[[translatedChunk, originalChunk, ...], ...], ...]
  const segments = parsed && parsed[0];
  if (!Array.isArray(segments)) {
    throw new Error('googleTranslator: unexpected response shape');
  }

  return segments.map(seg => seg[0]).join('');
}

module.exports = { translate };

function get(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    };

    https.get(url, options, (res) => {
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
