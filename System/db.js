// system/db.js
// CommonJS module - loaded via require(), NOT a <script src="..."> tag, so
// __dirname below is reliably this file's own folder (system/) regardless
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
//   original: { title, circleId, category, language, engine, version,
//               sizeBytes, dlsiteRating, releaseDate, tags, hvdbTags, cvs,
//               description },
//   override: { title, circleId, category, language, engine, version,
//               sizeBytes, rating, dlsiteRating, timesPlayed,
//               secondsPlayed, lastPlayedDate, releaseDate, tags,
//               hvdbTags, cvs, description, comments }
// }
//
// CIRCLES
// Circles (developers) are their own entity, not a free-text field on the
// game, matching the old WinForms app's Circle/CircleEditor: a circle's
// display Name can vary or be renamed, but its DLsite maker code (RGCode -
// despite the name, DLsite actually uses RG/VG/BG prefixes depending on
// the circle type) is the real, stable identifier. Games reference a
// circle by the local circleId (Dexie's auto-increment key), same as the
// old app's Game.CircleID foreign key - never by name or RGCode directly,
// since either of those can be missing or change.
//
//   circles: { circleId: 1, name: "Falcom", rgCode: "VG01562" }

const Dexie = require('dexie');

const db = new Dexie('DLSiteManager');

db.version(1).stores({
  // productCode (e.g. "RJ012345") is the primary key, matching the folder
  // name under Database/Games/DLsite/<productCode>/ used for JSON backups.
  // Dotted-path indexes reach into original/override for future
  // filtering/search; nothing queries them yet - list sorting currently
  // happens client-side in system/table.js against the resolved view.
  games: 'productCode, original.title, override.rating, override.lastPlayedDate, addedDate',
  circles: '++circleId, rgCode, name',
  // Generic key/value store for app + UI settings.
  settings: 'key'
});

// Fields that exist in both original and override, in the order the edit
// panel displays them. Shared with system/edit-panel.js so the two tabs
// and the resolved/list view all agree on what a "field" is. circleId
// resolves the same override-or-original way as everything else here;
// system/edit-panel.js just renders it with a custom widget (name lookup
// + "Edit" button opening the circle manager) instead of a text input.
const OVERRIDABLE_FIELDS = [
  'title', 'circleId', 'category', 'language', 'engine', 'version', 'sizeBytes',
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

/**
 * Returns every game in the library as resolved (effective) flat objects,
 * with `circle` added as the looked-up circle name (system/table.js's
 * circle column just reads this like any other plain field - it doesn't
 * know circles are a separate table).
 */
async function getAllGames() {
  const [records, circles] = await Promise.all([db.games.toArray(), db.circles.toArray()]);
  const circleById = new Map(circles.map(c => [c.circleId, c]));

  return records.map(record => {
    const resolved = resolveGame(record);
    const circle = resolved.circleId != null ? circleById.get(resolved.circleId) : null;
    resolved.circle = circle ? circle.name : '';
    return resolved;
  });
}

/** Returns one game's full raw record (both original and override), for the edit panel. */
async function getGameRecord(productCode) {
  return db.games.get(productCode);
}

/** True if a game with this exact productCode is already in the library. */
async function gameExists(productCode) {
  const record = await db.games.get(productCode);
  return !!record;
}

/**
 * Creates a minimal stub record for a newly added game - just enough to
 * show up in the list (productCode, path, addedDate). `original` starts
 * empty; system/parser.js (once implemented) is what fills it in, either
 * right after adding or later via the "Download info" button.
 */
async function addGame({ productCode, path }) {
  const record = {
    productCode,
    path,
    addedDate: new Date().toISOString(),
    images: { thumb: null, gallery: [] },
    original: {},
    override: {}
  };
  await db.games.add(record);
  return record;
}

/** Merges the given fields into a game's override object and returns the updated record. */
async function updateGameOverride(productCode, overridePatch) {
  const record = await db.games.get(productCode);
  if (!record) throw new Error(`No game with productCode ${productCode}`);

  record.override = Object.assign({}, record.override, overridePatch);
  await db.games.put(record);
  return record;
}

/**
 * Merges the given fields directly onto the top level of a game record -
 * for things like `launcher`/`launchParameters` that are plain per-game
 * settings, not part of the original/override system (there's no
 * "original" launcher scraped from a website).
 */
async function updateGameFields(productCode, patch) {
  await db.games.update(productCode, patch);
}

// ---------------------------------------------------------------
// Circles
// ---------------------------------------------------------------

/** Returns every circle in the library. */
async function getAllCircles() {
  return db.circles.toArray();
}

/**
 * Adds a new circle (circle.circleId is undefined/null) or updates an
 * existing one. Returns the circle's id either way.
 */
async function saveCircle(circle) {
  const record = {
    name: (circle.name || '').trim(),
    rgCode: normalizeRgCodeForStorage(circle.rgCode)
  };

  if (circle.circleId != null) {
    await db.circles.update(circle.circleId, record);
    return circle.circleId;
  }
  return db.circles.add(record);
}

async function deleteCircle(circleId) {
  await db.circles.delete(circleId);
}

function normalizeRgCodeForStorage(raw) {
  const trimmed = (raw == null ? '' : String(raw)).trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Mirrors the old app's CircleEditor.IsValidRgCode: valid if it's an
 * rg/vg/bg prefix followed by digits, or plain digits on their own (at
 * least 3 characters either way). An empty/missing code is also valid -
 * not every circle has a known one yet.
 */
function isValidRgCode(raw) {
  if (raw == null || String(raw).trim() === '') return true;
  const trimmed = String(raw).trim();
  if (trimmed.length < 3) return false;

  const prefix = trimmed.slice(0, 2);
  if (/^(vg|bg|rg)$/i.test(prefix)) {
    return /^\d+$/.test(trimmed.slice(2));
  }
  return /^\d+$/.test(trimmed);
}

/**
 * Mirrors the old app's Circle.RGCode getter: a stored code that's just
 * digits (no letter prefix) displays with an assumed "RG" prefix; codes
 * that already have a letter prefix (RG/VG/BG, as entered) display as-is.
 */
function displayRgCode(raw) {
  if (!raw) return '';
  return /^\d/.test(String(raw)) ? 'RG' + raw : String(raw);
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
 * JSON backups store each game's circle as a portable, self-contained
 * { name, rgCode } object (not a local circleId, which wouldn't mean
 * anything on a different install) - this finds-or-creates the matching
 * circle row (de-duplicated by rgCode, falling back to name) and swaps it
 * for a circleId before the game record is saved.
 *
 * Run from devtools console:
 *   require('./system/db.js').seedFromBackups().then(n => console.log(n, 'games loaded'))
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

  const circleCache = new Map(); // rgCode-or-name key -> circleId, so repeat circles across games only get one row

  async function resolveCircleId(circleInfo) {
    if (!circleInfo || !circleInfo.name) return null;

    const cacheKey = circleInfo.rgCode || ('name:' + circleInfo.name);
    if (circleCache.has(cacheKey)) return circleCache.get(cacheKey);

    let existing = null;
    if (circleInfo.rgCode) {
      existing = await db.circles.where('rgCode').equals(circleInfo.rgCode).first();
    }
    if (!existing) {
      existing = await db.circles.where('name').equals(circleInfo.name).first();
    }

    const id = existing ? existing.circleId : await saveCircle(circleInfo);
    circleCache.set(cacheKey, id);
    return id;
  }

  for (const record of records) {
    if (record.original && record.original.circle) {
      record.original.circleId = await resolveCircleId(record.original.circle);
      delete record.original.circle;
    }
    if (record.override) {
      if (record.override.circle) {
        record.override.circleId = await resolveCircleId(record.override.circle);
      } else {
        record.override.circleId = null;
      }
      delete record.override.circle;
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
  gameExists,
  addGame,
  updateGameOverride,
  updateGameFields,
  getAllCircles,
  saveCircle,
  deleteCircle,
  isValidRgCode,
  displayRgCode,
  getSetting,
  setSetting,
  seedFromBackups
};
