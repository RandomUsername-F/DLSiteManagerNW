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
// {
//   productCode: "RJ012345",
//   dlcCode: "RJ012346",           // optional - a separately DLsite-listed DLC for this game, if any
//   path: "D:\\Games\\...\\Game.exe", // points directly at the executable, not just its folder
//   addedDate: "2026-06-01",
//   images: { thumb: "images/thumb.jpg", gallery: ["images/001.jpg", ...] },
//   launcher: { enabled, value },        // optional custom launcher override
//   launchParameters: { enabled, value },
//   original: { title, circleId, category, language, engine, version,
//               latestVersion, sizeBytes, dlsiteRating, releaseDate, tags,
//               hvdbTags, cvs, description },
//   override: { ...same field set..., rating, timesPlayed, secondsPlayed,
//               lastPlayedDate, comments }
// }
// original/override never embed circle data directly - only a local
// circleId, resolved against the circles table (see CIRCLES below).
//
// CIRCLES
// Circles (developers) are their own entity, not a field on the game -
// their display Name can vary/be renamed independently of their DLsite
// maker code (RGCode - despite the name, DLsite actually uses RG/VG/BG
// prefixes depending on circle type), which is the real, stable
// identifier. Games reference a circle only by the local circleId
// (Dexie's key); nothing about a circle is duplicated onto a game record,
// and no game-facing UI edits circle data directly - only
// system/circle-editor.js does. Backed up as one file, Database/circles.json
// (not embedded per-game), so a circle rename doesn't require touching
// every game that references it.

const Dexie = require('dexie');
const fs = require('fs');
const path = require('path');

const db = new Dexie('DLSiteManager');

const GAMES_ROOT = path.join(__dirname, '..', 'Database', 'Games', 'DLsite');
const CIRCLES_BACKUP_PATH = path.join(__dirname, '..', 'Database', 'circles.json');

db.version(1).stores({
  games: 'productCode, dlcCode, original.title, override.rating, override.lastPlayedDate, addedDate',
  circles: '++circleId, rgCode, name',
  settings: 'key'
});

// Fields that exist in both original and override, in the order the edit
// panel displays them (see system/edit-panel.js's EDIT_FIELDS, which is
// the authoritative display order/pairing - this list just needs to
// contain every field name that participates in override-or-original
// resolution).
const OVERRIDABLE_FIELDS = [
  'title', 'circleId', 'category', 'language', 'engine', 'version', 'latestVersion',
  'sizeBytes', 'rating', 'dlsiteRating', 'timesPlayed', 'secondsPlayed',
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
    dlcCode: record.dlcCode,
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
 * with `circle` added as the looked-up circle name (System/table.js's
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
 * True if `code` matches an existing game's productCode OR its dlcCode -
 * used by the add-game duplicate check (system/library-import.js), since
 * a code that's already tracked as a DLC of some other game is just as
 * much a duplicate-add as a matching productCode.
 */
async function findGameByCodeOrDlc(code) {
  if (!code) return null;
  const byCode = await db.games.get(code);
  if (byCode) return byCode;
  return db.games.where('dlcCode').equals(code).first();
}

/**
 * Creates a minimal stub record for a newly added game - just enough to
 * show up in the list (productCode, path, addedDate). `original` starts
 * empty; system/dlsite_parser.js is what fills it in, either right after
 * adding or later via a context-menu action.
 */
async function addGame({ productCode, path: gamePath, dlcCode }) {
  const record = {
    productCode,
    dlcCode: dlcCode || null,
    path: gamePath,
    addedDate: new Date().toISOString(),
    images: { thumb: null, gallery: [] },
    launcher: { enabled: false, value: '' },
    launchParameters: { enabled: false, value: '' },
    original: {},
    override: {}
  };
  await db.games.add(record);
  await saveGameBackup(productCode);
  return record;
}

/**
 * Writes/updates the portable JSON backup for one game under
 * Database/Games/DLsite/<productCode>/info.json - see seedFromBackups()
 * for the reverse direction. Called after every mutation (add, override
 * edits, launcher settings, parsed data) so the backup stays a live
 * mirror of the database rather than just a one-time snapshot. Failures
 * are logged, not thrown - a backup write failing should never block the
 * actual database change that triggered it.
 */
async function saveGameBackup(productCode) {
  const record = await db.games.get(productCode);
  if (!record) return;

  try {
    const folder = path.join(GAMES_ROOT, productCode);
    fs.mkdirSync(path.join(folder, 'images'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'info.json'), JSON.stringify(record, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write backup JSON for', productCode, e);
  }
}

/** Merges the given fields into a game's override object and returns the updated record. */
async function updateGameOverride(productCode, overridePatch) {
  const record = await db.games.get(productCode);
  if (!record) throw new Error(`No game with productCode ${productCode}`);

  record.override = Object.assign({}, record.override, overridePatch);
  await db.games.put(record);
  await saveGameBackup(productCode);
  return record;
}

/**
 * Merges the given fields directly onto the top level of a game record -
 * for things like `launcher`/`launchParameters`/`dlcCode`/`path` that
 * are plain per-game settings, not part of the original/override system.
 */
async function updateGameFields(productCode, patch) {
  await db.games.update(productCode, patch);
  await saveGameBackup(productCode);
}

/** Removes a game and its on-disk backup folder entirely. Never touches the actual game files themselves. */
async function removeGame(productCode) {
  await db.games.delete(productCode);
  try {
    fs.rmSync(path.join(GAMES_ROOT, productCode), { recursive: true, force: true });
  } catch (e) {
    console.error('Failed to remove backup folder for', productCode, e);
  }
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

  let id;
  if (circle.circleId != null) {
    await db.circles.update(circle.circleId, record);
    id = circle.circleId;
  } else {
    id = await db.circles.add(record);
  }
  await saveCirclesBackup();
  return id;
}

async function deleteCircle(circleId) {
  await db.circles.delete(circleId);
  await saveCirclesBackup();
}

/** Writes every circle to Database/circles.json - the single source of truth backup for circle data (see the CIRCLES header comment above). */
async function saveCirclesBackup() {
  try {
    const circles = await db.circles.toArray();
    fs.mkdirSync(path.dirname(CIRCLES_BACKUP_PATH), { recursive: true });
    fs.writeFileSync(CIRCLES_BACKUP_PATH, JSON.stringify(circles, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write Database/circles.json', e);
  }
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
 * Rebuilds the database from the on-disk backups: Database/circles.json
 * first (so circleId references in each game backup resolve correctly -
 * bulkPut with an explicit key reuses that exact id rather than
 * generating a new one), then every Database/Games/DLsite/<code>/info.json.
 *
 * Not called automatically - triggered by the "Rebuild index" action, or
 * usable directly from devtools:
 *   require('./system/db.js').seedFromBackups().then(n => console.log(n, 'games loaded'))
 */
async function seedFromBackups() {
  if (fs.existsSync(CIRCLES_BACKUP_PATH)) {
    try {
      const circles = JSON.parse(fs.readFileSync(CIRCLES_BACKUP_PATH, 'utf8'));
      if (Array.isArray(circles) && circles.length) {
        await db.circles.bulkPut(circles);
      }
    } catch (e) {
      console.error('Failed to load Database/circles.json', e);
    }
  }

  if (!fs.existsSync(GAMES_ROOT)) {
    console.warn('No Database/Games/DLsite folder found at', GAMES_ROOT);
    return 0;
  }

  const codes = fs.readdirSync(GAMES_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);

  const records = [];
  for (const code of codes) {
    const infoPath = path.join(GAMES_ROOT, code, 'info.json');
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
  GAMES_ROOT,
  OVERRIDABLE_FIELDS,
  resolveGame,
  getAllGames,
  getGameRecord,
  gameExists,
  findGameByCodeOrDlc,
  addGame,
  removeGame,
  saveGameBackup,
  updateGameOverride,
  updateGameFields,
  getAllCircles,
  saveCircle,
  deleteCircle,
  saveCirclesBackup,
  isValidRgCode,
  displayRgCode,
  getSetting,
  setSetting,
  seedFromBackups
};
