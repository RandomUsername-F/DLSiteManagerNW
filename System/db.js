// System/db.js
// CommonJS module — loaded via require(), NOT a <script src="..."> tag, so
// __dirname below is reliably this file's own folder (System/) regardless
// of how the app was launched.
//
// Wraps the Dexie (IndexedDB) database that stores the live game library,
// plus a small key/value "settings" table used for UI state (window
// bounds, column layout, sort order, panel split position). Both live in
// Database\Settings\ per package.json's chromium-args, alongside
// Database\Games\ (the JSON/image backups) - see the project's Database/
// layout notes.

const Dexie = require('dexie');

const db = new Dexie('DLSiteManager');

db.version(1).stores({
  // productCode (e.g. "RJ012345") is the primary key, matching the folder
  // name under Database/Games/DLsite/<productCode>/ used for JSON backups.
  games: 'productCode, title, circle, category, language, rating, dlsiteRating, sizeBytes, lastPlayedDate, addedDate',
  // Generic key/value store for app + UI settings.
  settings: 'key'
});

/** Returns every game in the library, unsorted (the table sorts as needed). */
async function getAllGames() {
  return db.games.toArray();
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
 * DEV/TESTING HELPER — not called automatically anywhere. The app's
 * eventual "Database/Games exists but no database yet" rebuild prompt
 * will do something similar, but ask the user first; this is just a way
 * to get the dummy fixture games into IndexedDB to test the list panel
 * without building that flow yet.
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

module.exports = { db, getAllGames, getSetting, setSetting, seedFromBackups };
