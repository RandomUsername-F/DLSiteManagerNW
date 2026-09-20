// System/db.js
// CommonJS module - loaded via require(), NOT a <script src="..."> tag, so
// __dirname below is reliably this file's own folder (System/) regardless
// of how the app was launched.
//
// Wraps the Dexie (IndexedDB) database that stores the live game library,
// plus a small key/value "settings" table used for UI state (window
// bounds, column layout, sort order, panel split position). Both live in
// Database\Settings\ per package.json's chromium-args, alongside
// Database\Games\ (the JSON/image backups).
//
// GAME RECORD SHAPE
// Each game has two parallel field sets instead of one flat set:
//   original  - written when the app scrapes/saves data from DLsite.
//               Never edited by hand; read-only in the UI.
//   override  - the user's own edits. Any field left null/empty here
//               falls back to the matching field in `original` when
//               displayed (see resolveGame() below) - that's what lets
//               the "Game info" tab show inherited values without the
//               user having to fill in everything themselves.
// productCode, path, images, and addedDate sit outside that split since
// they aren't dual-sourced the same way.
//
// {
//   productCode: "RJ012345",
//   path: "D:\\Games\\...",
//   addedDate: "2026-06-01",
//   images: { thumb: "images/thumb.jpg", gallery: ["images/001.jpg", ...] },
//   original: { title, circle, category, language, sizeBytes, dlsiteRating,
//               releaseDate, tags, hvdbTags, cvs },
//   override: { title, circle, category, language, sizeBytes, rating,
//               dlsiteRating, timesPlayed, secondsPlayed, lastPlayedDate,
//               releaseDate, tags, hvdbTags, cvs, comments }
// }

const Dexie = require('dexie');

const db = new Dexie('DLSiteManager');

db.version(1).stores({
  // productCode (e.g. "RJ012345") is the primary key, matching the folder
  // name under Database/Games/DLsite/<productCode>/ used for JSON backups.
  // Dotted-path indexes reach into original/override for future
  // filtering/search; nothing queries them yet - list sorting currently
  // happens client-side in System/table.js against the resolved view.
  games: 'productCode, original.title, original.circle, override.rating, override.lastPlayedDate, addedDate',
  // Generic key/value store for app + UI settings.
  settings: 'key'
});

// Fields that exist in both original and override, in the order the edit
// panel displays them. Shared with System/edit-panel.js so the two tabs
// and the resolved/list view all agree on what a "field" is.
const OVERRIDABLE_FIELDS = [
  'title', 'circle', 'category', 'language', 'engine', 'version', 'sizeBytes',
  'rating', 'dlsiteRating', 'timesPlayed', 'secondsPlayed',
  'lastPlayedDate', 'releaseDate', 'tags', 'hvdbTags', 'cvs', 'description', 'comments'
];

/**
 * Flattens a raw record into the "effective" values actually shown in the
 * list and in the Game info tab: override value if it's set (not null,
 * undefined, '', or an empty array), else the original value.
 */
function resolveGame(record) {
  const resolved = {
    productCode: record.productCode,
    path: record.path,
    addedDate: record.addedDate,
    images: record.images
  };

  const original = record.original || {};
  const override = record.override || {};

  for (const field of OVERRIDABLE_FIELDS) {
    const overrideValue = override[field];
    const isEmpty = overrideValue == null || overrideValue === ''
      || (Array.isArray(overrideValue) && overrideValue.length === 0);
    resolved[field] = isEmpty ? original[field] : overrideValue;
  }

  return resolved;
}

/** Returns every game in the library as resolved (effective) flat objects. */
async function getAllGames() {
  const records = await db.games.toArray();
  return records.map(resolveGame);
}

/** Returns one game's full raw record (both original and override), for the edit panel. */
async function getGameRecord(productCode) {
  return db.games.get(productCode);
}

/** Merges the given fields into a game's override object and returns the updated record. */
async function updateGameOverride(productCode, overridePatch) {
  const record = await db.games.get(productCode);
  if (!record) throw new Error(`No game with productCode ${productCode}`);

  record.override = Object.assign({}, record.override, overridePatch);
  await db.games.put(record);
  return record;
}

/** Reads a settings value, or defaultValue if it isn't set yet. */
async function getSetting(key, defaultValue) {
  const row = await db.settings.get(key);
  return row ? row.value : defaultValue;
}

/** Writes a settings value. */
async function setSetting(key, value) {
  await db.settings.put({ key, value });
}

/**
 * DEV/TESTING HELPER - not called automatically anywhere. The app's
 * eventual "Database/Games exists but no database yet" rebuild prompt
 * will do something similar, but ask the user first; this is just a way
 * to get the dummy fixture games into IndexedDB to test the UI without
 * building that flow yet.
 *
 * Run from devtools console:
 *   require('./System/db.js').seedFromBackups().then(n => console.log(n, 'games loaded'))
 */
async function seedFromBackups() {
  const fs = require('fs');
  const path = require('path');

  const gamesRoot = path.join(__dirname, '..', 'Database', 'Games', 'DLsite');
  if (!fs.existsSync(gamesRoot)) {
    console.warn('No Database/Games/DLsite folder found at', gamesRoot);
    return 0;
  }

  const codes = fs.readdirSync(gamesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);

  const records = [];
  for (const code of codes) {
    const infoPath = path.join(gamesRoot, code, 'info.json');
    if (!fs.existsSync(infoPath)) continue;
    try {
      records.push(JSON.parse(fs.readFileSync(infoPath, 'utf8')));
    } catch (e) {
      console.error('Failed to parse', infoPath, e);
    }
  }

  if (records.length) {
    await db.games.bulkPut(records);
  }
  return records.length;
}

module.exports = {
  db,
  OVERRIDABLE_FIELDS,
  resolveGame,
  getAllGames,
  getGameRecord,
  updateGameOverride,
  getSetting,
  setSetting,
  seedFromBackups
};
