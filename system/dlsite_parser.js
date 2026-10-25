// system/dlsite_parser.js
// DLsite product-page scraper. Ported from the old WinForms app's
// DLSitePage.cs (see its Get*() methods) and Game.cs's DownloadInfo()
// orchestration, rewritten against the site's current markup using
// cheerio (a real DOM/CSS-selector parser) instead of raw substring
// search wherever the page offers a real hook - the old app's
// string-scanning approach is exactly what broke once DLsite redesigned
// the site (see the earlier GetTags fix in this project's history).
//
// SCOPE: matches DLSitePage.cs, not Game.cs - this returns data,
// including remote image URLs, but does not download/save images to
// disk. In the old app that was a separate step (GameImage.Load(),
// called from Game.cs, not from DLSitePage.cs); here it's
// system/image-downloader.js, called from system/library-import.js.
// DLsite codes only - FANZA/DMM codes (d_123456) are never passed to this
// module (see library-import.js's runParseWithGuards).
//
// `dlcParent` (see extractDlcParent) is not stored on game records; it
// only exists so the add flow can warn about a DLC whose base game is
// already in the library.
//
// GUARDS:
// - Never evaluates anything from the fetched page. cheerio only ever
//   parses markup into a queryable tree; nothing here calls eval(),
//   `Function(...)`, or any similar sink on fetched content, and no
//   <script> tag content is ever read as anything but (unused) text.
// - Redirects / dead or geo-locked pages: fetchPage() follows redirects
//   itself and keeps the final URL. isValidProductPage() then refuses to
//   treat the result as usable unless (a) the final URL still contains
//   the requested product code (i.e. we weren't bounced to an error page
//   or the site's front page) and (b) the page has the DOM landmarks a
//   real product page always has. Anything else makes fetchGameInfo()
//   resolve to null rather than a wrong or empty parse.
// - Never overwriting good data with bad: every per-field extractor
//   OMITS its key from the result object entirely if it can't confidently
//   find that field, rather than setting it to null/''. Callers (see
//   system/library-import.js's applyParsedInfo) only ever overwrite a
//   field that's actually present in the result, so a failed or partial
//   parse can never blank out data that was already there.
//
// fetchGameInfo(productCode, options?) -> Promise<ParsedGameInfo | null>
//   options.fields: string[] - which of ALL_FIELDS to extract/return.
//     Defaults to every field. This is the "partial information
//     retrieval" hook - e.g. fetchGameInfo(code, { fields: ['dlsiteRating'] })
//     re-checks just the rating without touching anything else, useful
//     for a lightweight refresh vs. a full first-time scrape. The page
//     is still fetched once regardless (the site doesn't offer a way to
//     ask for less than the whole page); `fields` only controls what
//     gets parsed out of it and returned.

const https = require('https');
const { URL } = require('url'); // explicit require rather than the bare global - see system/dom-bridge.js for why bare globals aren't trusted in this environment
const cheerio = require('cheerio');
const { getProfiles } = require('./browser-headers.js');

const ALL_FIELDS = [
  'title', 'circle', 'category', 'releaseDate', 'version',
  'sizeBytes', 'dlsiteRating', 'tags', 'description', 'images', 'dlcParent'
];

async function fetchGameInfo(productCode, options) {
  options = options || {};
  const fields = options.fields || ALL_FIELDS;
  const url = buildProductUrl(productCode);

  // Attempt order. FIRST, Chromium's own network stack (the page's real
  // window.fetch): it honors the system proxy/PAC, certificates and cookies
  // exactly like the browser that works over the DLsite-only VPN, which
  // Node's https does not. Then Node requests as a fallback: Chromium-style
  // headers, then Mozilla-style. Each is tried with the extended URL (utm_* +
  // locale query, as Chromium lands on) and then the plain one. The first
  // attempt that yields a real product page wins.
  const urlFor = (variant) => variant === 'extended' ? buildExtendedProductUrl(productCode) : url;
  const attempts = [];
  for (const variant of ['extended', 'plain']) {
    attempts.push({ label: `chromium-net/${variant}`, run: () => fetchPageViaChromium(urlFor(variant)) });
  }
  for (const profile of getProfiles()) {
    for (const variant of ['extended', 'plain']) {
      attempts.push({ label: `node-${profile.name}/${variant}`, run: () => fetchPage(urlFor(variant), profile.headers) });
    }
  }

  let page = null;
  for (const attempt of attempts) {
    try {
      const candidate = await attempt.run();
      if (isValidProductPage(candidate, productCode)) {
        page = candidate;
        break;
      }
      console.warn(`dlsite_parser: [${attempt.label}] not a real product page for`, productCode, '- final URL:', candidate.finalUrl);
    } catch (e) {
      console.warn(`dlsite_parser: [${attempt.label}] fetch failed for`, productCode, '-', e.message);
    }
  }

  if (!page) {
    console.error('dlsite_parser: no usable page for', productCode, 'with any attempt');
    return null;
  }

  const $ = cheerio.load(page.html);
  const result = {};

  if (fields.includes('title')) {
    const value = extractTitle($);
    if (value !== undefined) result.title = value;
  }
  if (fields.includes('circle')) {
    const value = extractCircle($);
    if (value !== undefined) result.circle = value;
  }
  if (fields.includes('category')) {
    const value = extractCategory($);
    if (value !== undefined) result.category = value;
  }
  if (fields.includes('releaseDate')) {
    const value = extractReleaseDate($);
    if (value !== undefined) result.releaseDate = value;
  }
  if (fields.includes('version')) {
    const value = extractVersion($);
    if (value !== undefined) result.version = value;
  }
  if (fields.includes('sizeBytes')) {
    const value = extractSizeBytes($);
    if (value !== undefined) result.sizeBytes = value;
  }
  if (fields.includes('dlsiteRating')) {
    const value = extractRating($);
    if (value !== undefined) result.dlsiteRating = value;
  }
  if (fields.includes('tags')) {
    const value = extractTags($);
    if (value !== undefined) result.tags = value;
  }
  if (fields.includes('description')) {
    const value = extractDescription($);
    if (value !== undefined) result.description = value;
  }
  if (fields.includes('images')) {
    const value = extractImages($);
    if (value !== undefined) result.images = value;
  }
  if (fields.includes('dlcParent')) {
    // Present only when this page is identified as a DLC AND a parent product code was found.
    const value = extractDlcParent($, productCode);
    if (value !== undefined) result.dlcParent = value;
  }

  return result;
}

// ---------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------

function buildProductUrl(productCode) {
  const prefix = productCode.slice(0, 2).toUpperCase();
  // Matches the old app's Type mapping (rj/re -> Maniax, vj -> Pro,
  // bj -> Book), translated to the current site's URL sections.
  const section = prefix === 'VJ' ? 'soft' : prefix === 'BJ' ? 'books' : 'maniax';
  return `https://www.dlsite.com/${section}/work/=/product_id/${productCode}.html`;
}

/** The URL form Chromium lands on: same page plus utm_* and locale query params. */
function buildExtendedProductUrl(productCode) {
  const locale = process.env.DLSITE_LOCALE || 'en_US';
  return `${buildProductUrl(productCode)}?utm_source=booster&utm_medium=booster&utm_campaign=booster&locale=${encodeURIComponent(locale)}`;
}

/**
 * Fetches through Chromium's own network stack (the real page window's
 * fetch, via dom-bridge) so system proxy/PAC settings, certificates and the
 * browser cookie jar apply - unlike Node's https, which ignores all of them.
 * Throws on failure (including a cross-origin block), letting the caller
 * fall through to the Node-based attempts.
 */
async function fetchPageViaChromium(url) {
  const win = require('./dom-bridge.js').getWindow();
  if (!win || typeof win.fetch !== 'function') throw new Error('Chromium fetch unavailable');

  const controller = new win.AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await win.fetch(url, { credentials: 'include', redirect: 'follow', signal: controller.signal });
    if (!res.ok) throw new Error(`Unexpected HTTP ${res.status} fetching ${url}`);
    return { finalUrl: res.url || url, html: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** GETs a URL, following redirects itself so the final URL can be checked. Never executes anything from the response - this only ever collects raw text. `baseHeaders` is a browser profile's header set (see browser-headers.js). */
function fetchPage(url, baseHeaders, maxRedirects) {
  if (maxRedirects === undefined) maxRedirects = 5;

  // Reads the language variable set elsewhere (e.g., 'en_US', 'ja_JP', 'zh_TW')
  const locale = process.env.DLSITE_LOCALE;
  const headers = Object.assign({}, baseHeaders);

  if (locale) {
    headers['Cookie'] = `locale=${locale};`;
  }

  return new Promise((resolve, reject) => {
    function get(currentUrl, redirectsLeft) {
      const req = https.get(currentUrl, { headers }, (res) => {
        const statusCode = res.statusCode;

        if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location) {
          res.resume(); // discard the body, we're not using this response
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects fetching ' + url));
            return;
          }
          const nextUrl = new URL(res.headers.location, currentUrl).toString();
          get(nextUrl, redirectsLeft - 1);
          return;
        }

        if (statusCode !== 200) {
          res.resume();
          reject(new Error(`Unexpected HTTP ${statusCode} fetching ${currentUrl}`));
          return;
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ finalUrl: currentUrl, html: body }));
      });
      req.setTimeout(20000, () => req.destroy(new Error('Timed out fetching ' + currentUrl))); // a hung VPN route should fall through to the next profile
      req.on('error', reject);
    }

    get(url, maxRedirects);
  });
}

function isValidProductPage(page, productCode) {
  if (!page.finalUrl.toUpperCase().includes(productCode.toUpperCase())) {
    return false; // redirected away from the product entirely
  }
  // A real product page always has these landmarks; a removed, geo-locked,
  // or otherwise substituted page won't.
  return page.html.includes('id="work_name"') && page.html.includes('id="work_outline"');
}

// ---------------------------------------------------------------
// Field extractors - each returns undefined (never null/'') when it
// can't confidently find the field, per the "never overwrite good data
// with bad" guard described at the top of this file.
// ---------------------------------------------------------------

function extractTitle($) {
  const title = $('#work_name').first().text().trim();
  return title || undefined;
}

function extractCircle($) {
  const link = $('.maker_name a').first();
  if (!link.length) return undefined;

  const name = link.text().trim();
  if (!name) return undefined;

  const href = link.attr('href') || '';
  const match = /maker_id\/([A-Za-z]{2}\d+)/.exec(href);
  const rgCode = match ? match[1].toUpperCase() : null;

  return { name, rgCode };
}

function extractCategory($) {
  const span = $('#category_type span[title]').first();
  const category = (span.attr('title') || span.text() || '').trim();
  return category || undefined;
}

function extractReleaseDate($) {
  // The release-date link's URL carries exact numeric year/mon/day query
  // segments - more reliable than parsing the human-readable link text
  // (which varies by locale/language).
  const href = $('#work_outline a[href*="/new/=/year/"]').first().attr('href');
  if (!href) return undefined;

  const match = /year\/(\d{4})\/mon\/(\d{1,2})\/day\/(\d{1,2})/.exec(href);
  if (!match) return undefined;

  const year = match[1];
  const month = match[2].padStart(2, '0');
  const day = match[3].padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function extractVersion($) {
  // <tr><th>Update information</th><td>Aug 06 2025 <div class="btn_ver_up">
  // <a href="#version_up">Update information</a></div></td></tr>
  // The value is free text - sometimes a date, sometimes an incremental
  // version number - so it's kept verbatim rather than parsed as either.
  // The nested "Update information" link/div is just a jump-to-changelog
  // control and isn't part of the value itself.
  let version;
  $('#work_outline th').each((i, el) => {
    if ($(el).text().trim() === 'Update information') {
      const td = $(el).next('td').clone();
      td.find('.btn_ver_up').remove();
      const text = td.text().trim();
      if (text) version = text;
    }
  });
  return version;
}

function extractSizeBytes($) {
  const sizeText = $('.work_spec_list dt')
    .filter((i, el) => $(el).text().trim() === 'File size')
    .next('dd')
    .first()
    .text()
    .trim();
  if (!sizeText) return undefined;

  const match = /([\d.]+)\s*(KB|MB|GB|TB)/i.exec(sizeText);
  if (!match) return undefined;

  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multiplier = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[unit];
  return Math.round(value * multiplier);
}

function extractRating($) {
  // Schema.org microdata - present directly in the page now, unlike the
  // old app's era, where this needed a separate AJAX request
  // (JapaneseDLSitePage.DownloadRating()) because it wasn't in the HTML.
  const value = $('[itemprop="aggregateRating"] [itemprop="ratingValue"]').first().attr('content');
  if (!value) return undefined;
  const num = parseFloat(value);
  return isNaN(num) ? undefined : num;
}

function extractTags($) {
  const tags = [];
  $('.main_genre a').each((i, el) => {
    const text = $(el).text().trim();
    if (text) tags.push(text);
  });
  return tags.length ? tags : undefined;
}

/**
 * Text only - excludes images, video, and any other non-text content, per
 * the task's requirement. There can be more than one .work_parts.type_text
 * block on a page; all of them are included, joined with a blank line.
 */
function extractDescription($) {
  const parts = [];

  $('.work_parts.type_text').each((i, el) => {
    const clone = $(el).clone();
    clone.find('img, video, iframe, audio, source, picture, script, style').remove();
    clone.find('br').replaceWith('\n');
    const text = clone.text().replace(/\u00A0/g, ' ').trim();
    if (text) parts.push(text);
  });

  return parts.length ? parts.join('\n\n') : undefined;
}

/**
 * Returns REMOTE URLs only (thumbUrl / galleryUrls) - see the SCOPE note
 * at the top of this file. Naming them distinctly from the local
 * `images.thumb`/`images.gallery` paths used elsewhere in the app is
 * deliberate, so a future image-download step can't be mistaken for
 * already having run.
 */
function extractImages($) {
  const nodes = $('.product-slider-data > div[data-src]');
  if (!nodes.length) return undefined;

  const urls = nodes.toArray().map((el) => normalizeImageUrl($(el).attr('data-src'))).filter(Boolean);
  if (!urls.length) return undefined;

  return { thumbUrl: urls[0], galleryUrls: urls.slice(1) };
}

/**
 * DLC detection. Returns the parent product code (string) if this page is a
 * DLC, else undefined. Two signals:
 *  1. The edition list ("Type" row, .work_edition_linklist): the .current
 *     item's label starts with "DLC" -> the first other item that isn't
 *     itself a DLC is the parent.
 *  2. A section headed 「動作に必要な本体作品」 or 「対応作品」 - the first product
 *     link inside it (other than this product) is the parent.
 */
const DLC_HEADERS = ['動作に必要な本体作品', '対応作品'];

function codeFromHref(href) {
  const m = /product_id\/([A-Za-z]{2}\d+)/.exec(href || '');
  return m ? m[1].toUpperCase() : null;
}

function extractDlcParent($, productCode) {
  const self = String(productCode).toUpperCase();

  // 1. Edition list
  const current = $('.work_edition_linklist_item.current').first();
  if (current.length && /^\s*DLC/i.test(current.find('dt').first().text())) {
    let parent;
    $('.work_edition_linklist_item').not('.current').each((i, el) => {
      const code = codeFromHref($(el).attr('href'));
      const label = $(el).find('dt').first().text();
      if (code && code !== self && !/^\s*DLC/i.test(label)) {
        parent = code;
        return false;
      }
    });
    if (parent) return parent;
  }

  // 2. Explicit "base work required" / "compatible works" section
  let parent;
  $('th, dt, h1, h2, h3, h4, h5, p, .work_label').each((i, el) => {
    const text = $(el).text().replace(/[\s\u3000:：「」]/g, '');
    if (!DLC_HEADERS.includes(text)) return;

    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    let scope = $(el).next();
    if (tag === 'th') scope = $(el).next('td');
    else if (tag === 'dt') scope = $(el).next('dd');
    if (!scope.length || !scope.find('a[href*="product_id"]').length) scope = $(el).parent();

    scope.find('a[href*="product_id"]').each((j, a) => {
      const code = codeFromHref($(a).attr('href'));
      if (code && code !== self) {
        parent = code;
        return false;
      }
    });
    if (parent) return false;
  });
  return parent;
}

function normalizeImageUrl(url) {
  if (!url) return null;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('http')) return url;
  return 'https://www.dlsite.com/' + url.replace(/^\/+/, '');
}

module.exports = { fetchGameInfo, ALL_FIELDS };
