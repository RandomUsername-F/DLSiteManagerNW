// system/parser.js
// DLsite page scraper - NOT IMPLEMENTED YET, per instruction to leave this
// for later. This file exists now so system/library-import.js has a real,
// stable function to call; filling in the actual scraping logic later is
// then a self-contained change to just this file.
//
// When implemented, this needs to guard against several specific things
// (noted here so they aren't forgotten):
// - Never eval()/execute anything from the fetched page - parse the HTML
//   as inert text/DOM only (e.g. via cheerio, already a dependency), never
//   run its <script> content or treat any part of it as code.
// - DLsite redirects or serves a "removed/not available in your region"
//   page for delisted or geo-locked products - detect that condition
//   explicitly (e.g. checking the response URL after redirects, and/or a
//   known marker in the error page's content) and treat it as "no data
//   found", not as a successful parse of empty/wrong fields.
// - When called to refresh an EXISTING game (the "Download info" button,
//   not a first-time add), a failed or wrong-page parse must never
//   overwrite the existing `original` data with blanks/garbage. Only
//   commit a parse result that's actually confirmed valid (e.g. the
//   expected product code appears on the page, title is non-empty, etc.);
//   otherwise leave the existing record untouched and report failure to
//   the caller.
//
// fetchGameInfo(productCode) -> Promise<ParsedGameInfo | null>
//   Returns null (not a rejected promise) when nothing could be safely
//   parsed - see guards above - so callers can treat "no data" as a
//   normal, expected outcome rather than an error.
//
// ParsedGameInfo shape (matches the `original` half of a game record -
// see system/db.js's header comment): { title, circle: {name, rgCode},
// category, language, engine, version, sizeBytes, dlsiteRating,
// releaseDate, tags, hvdbTags, cvs, description, images }

async function fetchGameInfo(productCode) {
  // TODO: implement. Left as a stub so the add-game flow (which calls
  // this once a product code is confirmed) has something real to call
  // without yet doing any actual scraping.
  return null;
}

module.exports = { fetchGameInfo };
