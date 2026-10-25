// system/browser-headers.js
// Request-header "profiles" for talking to dlsite.com from Node. Some
// networks/VPN exit nodes get Mozilla/Firefox-looking traffic rejected, so
// Chromium-style headers are tried first (matching NW.js's own Chromium
// version when available) and Firefox-style headers are the fallback.
//
// NOTE: this only changes the HTTP headers. Node's TLS handshake is still
// Node's, so a server that fingerprints TLS rather than headers is
// unaffected by either profile.

function chromeMajor() {
  const v = (typeof process !== 'undefined' && process.versions && process.versions.chromium) || '';
  const major = /^(\d+)\./.exec(v);
  return major ? major[1] : '131';
}

function chromiumProfile() {
  const major = chromeMajor();
  const full = (process.versions && process.versions.chromium) || `${major}.0.0.0`;
  return {
    name: 'chromium',
    headers: {
      'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8',
      'Upgrade-Insecure-Requests': '1',
      'sec-ch-ua': `"Chromium";v="${major}", "Not_A Brand";v="24"`,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1'
    }
  };
}

function firefoxProfile() {
  return {
    name: 'firefox',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Upgrade-Insecure-Requests': '1'
    }
  };
}

/** Profiles in the order they should be tried: Chromium first, Mozilla as fallback. */
function getProfiles() {
  return [chromiumProfile(), firefoxProfile()];
}

module.exports = { getProfiles };
