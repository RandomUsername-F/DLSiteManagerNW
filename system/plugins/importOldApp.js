// system/plugins/importOldApp.js
// One-time migration tool: imports and converts the old WinForms
// GameManager app's SQLite database (Games.db) into this app's library.
// Kept separate from system/library-import.js since this is a distinct,
// one-off "convert someone else's data" job, not part of the normal
// add-game flow.
//
// Verified against a real old-app Games.db (SQLite, tables game/circle/
// image) rather than guessed:
// - game.Size is KILOBYTES (old app's own UI mislabels it "MB") ->
//   sizeBytes = Size * 1024.
// - game.FolderPath, despite the name, is observed pointing directly at
//   the exe (e.g. "...\Game.exe") in current-format databases - used
//   as-is when it looks like one; falls back to scanning it as a folder
//   (via system/game-scanner.js) for older databases where it might
//   genuinely just be a folder.
// - image.ImagePath is relative to the OLD app's own install folder
//   (e.g. "Images\RJ012345\1.jpg"), not absolute.
// - image.IsListImage (not IsCoverImage - they can differ, and did in
//   the sample database used to build this) marks the image that
//   becomes the new thumb.jpg; every other image, in original ImageID
//   order, is renumbered 001.jpg, 002.jpg, ...
// - Tags/HVDBTags/CVs are comma-separated strings (may be '' or NULL).
// - RunWithAgth/AgthParameters/RunWithChiiTrans, DLSiteFlags,
//   IsRpgMakerGame/WolfRpgMakerVersion, UseCustomResolution+dimensions
//   are intentionally NOT imported - no equivalent field, or superseded
//   by this app's own engine-detection. AddedDate IS imported (unlike
//   the others) per instruction.
// - Category is sanitized: a real old database was found with several KB
//   of raw scraped HTML sitting in this column (evidently a past parser
//   bug in the old app) - anything implausibly long or HTML-shaped is
//   skipped rather than imported verbatim.
//
// Uses sql.js (pure WASM, no native binary) to read the old database,
// since this project has no other SQLite reader. The old Games.db is only
// ever read (loaded into memory, never written back); the optional "Move"
// mode applies to image files inside the old app's folder only - the old
// app's database and the game files themselves are never modified.

const fs = require('fs');
const path = require('path');

const document = require('../dom-bridge.js').getDocument();
const { confirmDialog } = require('../confirm-dialog.js');
const scanner = require('../game-scanner.js');
const db = require('../db.js');

let SQL = null;
async function getSqlJs() {
  if (!SQL) {
    const initSqlJs = require('sql.js');
    SQL = await initSqlJs({
      locateFile: (file) => path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', file)
    });
  }
  return SQL;
}

// ---------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------

/** Full flow: verify -> ask image mode -> log window -> import. Call after the user has already confirmed the intro dialog and picked the old exe. */
async function run(oldExePath) {
  const verification = await verifyOldApp(oldExePath);
  if (!verification.ok) {
    await confirmDialog('Could not import: ' + verification.reason, { okLabel: 'OK', cancelLabel: 'OK' });
    return;
  }

  // The old database is only ever READ (it's loaded into memory; nothing is
  // ever written back to Games.db) - closed here so the in-memory copy is freed.
  try {
    const imageMode = await showImageModeDialog();
    if (!imageMode) return; // cancelled

    const logWindow = showLogWindow();
    try {
      await importAll(oldExePath, verification, imageMode, logWindow.log);
      logWindow.finish('Import complete.');
    } catch (e) {
      console.error('Import failed:', e);
      logWindow.log('FATAL ERROR: ' + e.message);
      logWindow.finish('Import stopped due to an error.');
    }
  } finally {
    try { verification.sqlDb.close(); } catch (e) { /* already closed */ }
  }
}

// ---------------------------------------------------------------
// Verification
// ---------------------------------------------------------------

async function verifyOldApp(oldExePath) {
  const dbPath = path.join(path.dirname(oldExePath), 'Games.db');
  if (!fs.existsSync(dbPath)) {
    return { ok: false, reason: `No Games.db found next to "${path.basename(oldExePath)}". Select the old GameManager.exe, not a different program.` };
  }

  let sqlDb;
  try {
    const SQLjs = await getSqlJs();
    sqlDb = new SQLjs.Database(fs.readFileSync(dbPath));
  } catch (e) {
    return { ok: false, reason: 'Games.db is not a valid SQLite database (' + e.message + ').' };
  }

  let keepOpen = false;
  try {
    const tableInfo = sqlDb.exec("SELECT name FROM sqlite_master WHERE type='table'");
    const tableNames = tableInfo.length ? tableInfo[0].values.map(r => r[0]) : [];
    if (!tableNames.includes('game') || !tableNames.includes('circle') || !tableNames.includes('image')) {
      return { ok: false, reason: "Games.db doesn't look like the expected application's database (missing expected tables)." };
    }

    const columns = sqlDb.exec("PRAGMA table_info(game)")[0].values.map(r => r[1]);
    if (!columns.includes('RJCode')) {
      return { ok: false, reason: "Games.db doesn't look like the expected application's database (missing expected columns)." };
    }

    const countResult = sqlDb.exec('SELECT COUNT(*) FROM game');
    const count = countResult.length ? countResult[0].values[0][0] : 0;
    if (!count) {
      return { ok: false, reason: 'Games.db has no games in it - nothing to import.' };
    }

    keepOpen = true; // caller (run) closes it
    return { ok: true, dbPath, oldAppDir: path.dirname(oldExePath), sqlDb, gameCount: count };
  } catch (e) {
    return { ok: false, reason: 'Failed to read Games.db (' + e.message + ').' };
  } finally {
    if (!keepOpen) {
      try { sqlDb.close(); } catch (e) { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------
// Image-mode dialog (Copy / Move / Skip)
// ---------------------------------------------------------------

function showImageModeDialog() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    const box = document.createElement('div');
    box.className = 'confirm-box';

    const message = document.createElement('p');
    message.className = 'confirm-message';
    message.textContent =
      'How should the old app\'s images be brought in?\n\n' +
      'Copy leaves the old app untouched. Move transfers the image files out of the old app\'s folder ' +
      '(images only). Games.db, the old app and your game files are never modified, moved or deleted.';
    message.style.whiteSpace = 'pre-line';
    box.appendChild(message);

    const buttons = document.createElement('div');
    buttons.className = 'confirm-buttons';

    function close(result) {
      overlay.remove();
      resolve(result);
    }

    [['Skip', 'skip'], ['Copy', 'copy'], ['Move', 'move']].forEach(([label, value]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn' + (value === 'copy' ? ' btn--primary' : '');
      btn.textContent = label;
      btn.addEventListener('click', () => close(value));
      buttons.appendChild(btn);
    });

    box.appendChild(buttons);
    overlay.appendChild(box);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close(null);
    });

    document.body.appendChild(overlay);
  });
}

// ---------------------------------------------------------------
// Log window
// ---------------------------------------------------------------

function showLogWindow() {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';

  const box = document.createElement('div');
  box.className = 'report-box';

  const title = document.createElement('h2');
  title.className = 'report-title';
  title.textContent = 'Importing from old app\u2026';
  box.appendChild(title);

  const logEl = document.createElement('pre');
  logEl.className = 'import-log';
  box.appendChild(logEl);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn--primary';
  closeBtn.textContent = 'Importing\u2026';
  closeBtn.disabled = true;
  closeBtn.addEventListener('click', () => overlay.remove());
  box.appendChild(closeBtn);

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  function log(line) {
    logEl.textContent += line + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }

  function finish(summary) {
    log('');
    log(summary);
    closeBtn.disabled = false;
    closeBtn.textContent = 'Close';
  }

  return { log, finish };
}

// ---------------------------------------------------------------
// Import
// ---------------------------------------------------------------

async function importAll(oldExePath, verification, imageMode, log) {
  const { sqlDb, oldAppDir } = verification;
  const exclusionList = await getExclusionList();

  const rows = queryAll(sqlDb,
    `SELECT g.*, c.Name AS CircleName, c.RGCode AS CircleRGCode
     FROM game g LEFT JOIN circle c ON g.CircleID = c.CircleID`);

  const imagesByGameId = {};
  for (const img of queryAll(sqlDb, 'SELECT * FROM image')) {
    (imagesByGameId[img.GameID] = imagesByGameId[img.GameID] || []).push(img);
  }

  const circleCache = new Map(); // "name|rgCode" -> circleId, avoids re-querying per row
  let imported = 0, skipped = 0, failed = 0;

  log(`Found ${rows.length} game(s) in the old database.`);

  for (const row of rows) {
    const code = (row.RJCode || '').trim();
    if (!code) {
      log(`Skipped GameID ${row.GameID}: no RJCode.`);
      skipped++;
      continue;
    }

    try {
      if (await db.gameExists(code) || fs.existsSync(path.join(db.GAMES_ROOT, code))) {
        log(`Skipped ${code}: already in the library.`);
        skipped++;
        continue;
      }

      const gamePath = resolveOldGamePath(row.FolderPath, exclusionList);
      const circleId = await resolveCircleId(row.CircleName, row.CircleRGCode, circleCache);
      const record = mapRow(row, code, gamePath, circleId);

      await db.db.games.add(record);

      const imageResult = await importImages(oldAppDir, code, imagesByGameId[row.GameID] || [], imageMode);
      if (imageResult.thumb || imageResult.gallery.length) {
        await db.db.games.update(code, { images: imageResult });
      }

      await db.saveGameBackup(code);

      log(`Imported ${code} - ${row.Title || '(untitled)'}`);
      imported++;
    } catch (e) {
      console.error('Failed to import', code, e);
      log(`FAILED ${code}: ${e.message}`);
      failed++;
    }
  }

  await db.saveCirclesBackup();

  log('');
  log(`${imported} imported, ${skipped} skipped, ${failed} failed.`);
}

function queryAll(sqlDb, sql) {
  const result = sqlDb.exec(sql);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => Object.fromEntries(columns.map((col, i) => [col, row[i]])));
}

/** Old FolderPath sometimes already points at the exe directly; otherwise scans it as a folder (old-database fallback). */
function resolveOldGamePath(folderPath, exclusionList) {
  if (!folderPath) return folderPath;
  if (folderPath.toLowerCase().endsWith('.exe') && fs.existsSync(folderPath)) {
    return folderPath;
  }
  if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
    const exes = scanner.findExecutablesInDir(folderPath, exclusionList);
    if (exes.length) {
      return path.join(folderPath, scanner.pickPrimaryExecutable(folderPath, exes));
    }
  }
  return folderPath; // couldn't resolve an exe - stored as-is, same limitation as any other unresolved path
}

async function resolveCircleId(name, rgCode, cache) {
  if (!name) return null;
  const key = (rgCode || '') + '|' + name;
  if (cache.has(key)) return cache.get(key);

  let existing = null;
  if (rgCode) existing = await db.db.circles.where('rgCode').equals(rgCode).first();
  if (!existing) existing = await db.db.circles.where('name').equals(name).first();

  const id = existing ? existing.circleId : await db.saveCircle({ name, rgCode });
  cache.set(key, id);
  return id;
}

function mapRow(row, code, gamePath, circleId) {
  return {
    productCode: code,
    dlcCode: null,
    path: gamePath,
    addedDate: sqliteDateToIso(row.AddedDate) || new Date().toISOString(),
    images: { thumb: null, gallery: [] },
    launcher: { enabled: false, value: '' },
    launchParameters: { enabled: false, value: '' },
    original: {
      title: row.Title || undefined,
      circleId: circleId || undefined,
      category: sanitizeCategory(row.Category),
      language: row.Language || undefined,
      sizeBytes: row.Size != null ? row.Size * 1024 : undefined,
      dlsiteRating: row.DLSRating != null ? row.DLSRating : undefined,
      releaseDate: sqliteDateOnly(row.ReleaseDate),
      tags: splitList(row.Tags),
      hvdbTags: splitList(row.HVDBTags),
      cvs: splitList(row.CVs)
    },
    override: {
      rating: row.Rating != null ? row.Rating : undefined,
      timesPlayed: row.TimesPlayed || undefined,
      secondsPlayed: row.SecondsPlayed || undefined,
      lastPlayedDate: sqliteDateOnly(row.LastPlayedDate),
      comments: row.Comments || undefined
    }
  };
}

/** A real old database was found with raw scraped HTML sitting in this column - anything implausibly long or HTML-shaped is skipped rather than imported verbatim. */
function sanitizeCategory(value) {
  if (!value) return undefined;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed.length > 60 || /<[a-z][\s\S]*>/i.test(trimmed)) return undefined;
  return trimmed;
}

function splitList(value) {
  if (!value) return undefined;
  const items = String(value).split(',').map(s => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

/** SQLite TEXT datetimes here are plain "YYYY-MM-DD HH:MM:SS[.ffffff]" - sliced directly rather than parsed as a Date, to avoid any timezone-shift surprises. */
function sqliteDateOnly(value) {
  if (!value || typeof value !== 'string' || value.length < 10) return undefined;
  return value.slice(0, 10);
}

function sqliteDateToIso(value) {
  const datePart = sqliteDateOnly(value);
  return datePart ? datePart + 'T00:00:00.000Z' : undefined;
}

async function importImages(oldAppDir, code, imageRows, mode) {
  const result = { thumb: null, gallery: [] };
  if (mode === 'skip' || !imageRows.length) return result;

  const destDir = path.join(db.GAMES_ROOT, code, 'images');
  fs.mkdirSync(destDir, { recursive: true });

  // source file -> where it ended up for this game, so an image referenced by
  // two rows (e.g. list image == cover) can still be placed twice after a move.
  const placed = new Map();

  const thumbRow = imageRows.find(r => r.IsListImage) || null;
  const galleryRows = imageRows.filter(r => r !== thumbRow).sort((a, b) => a.ImageID - b.ImageID);

  if (thumbRow) {
    const ok = transferOne(oldAppDir, thumbRow.ImagePath, path.join(destDir, 'thumb.jpg'), mode, placed);
    if (ok) result.thumb = 'images/thumb.jpg';
  }

  galleryRows.forEach((row, i) => {
    const filename = String(i + 1).padStart(3, '0') + '.jpg';
    const ok = transferOne(oldAppDir, row.ImagePath, path.join(destDir, filename), mode, placed);
    if (ok) result.gallery.push('images/' + filename);
  });

  return result;
}

function isInside(parentDir, target) {
  const rel = path.relative(parentDir, target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Copies or moves ONE image file. "Move" only ever applies to image files
 * that live inside the old app's own folder; anything outside it (e.g. an
 * absolute ImagePath pointing into a game folder) is copied instead, and
 * the source is only removed after a cross-drive copy has been verified.
 */
function transferOne(oldAppDir, relativeOrAbsolutePath, destPath, mode, placed) {
  if (!relativeOrAbsolutePath) return false;
  const sourcePath = path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.join(oldAppDir, relativeOrAbsolutePath);
  const key = sourcePath.toLowerCase();

  try {
    // Already moved for this game earlier: copy from where it landed.
    if (placed.has(key)) {
      fs.copyFileSync(placed.get(key), destPath);
      return true;
    }

    if (!fs.existsSync(sourcePath)) return false;

    if (mode === 'move' && isInside(oldAppDir, sourcePath)) {
      try {
        fs.renameSync(sourcePath, destPath);
      } catch (e) {
        if (e.code !== 'EXDEV') throw e; // different drive: copy, then remove the source only if the copy checks out
        fs.copyFileSync(sourcePath, destPath);
        if (fs.statSync(destPath).size === fs.statSync(sourcePath).size) {
          try { fs.unlinkSync(sourcePath); } catch (unlinkErr) { console.warn('Could not remove moved source image:', sourcePath, unlinkErr.message); }
        }
      }
    } else {
      fs.copyFileSync(sourcePath, destPath);
    }

    placed.set(key, destPath);
    return true;
  } catch (e) {
    console.error('Image transfer failed:', sourcePath, '->', destPath, e);
    return false;
  }
}

async function getExclusionList() {
  const { DEFAULT_EXCLUSION_LIST } = require('../library-import.js');
  const settings = await db.getSetting('app', null);
  return (settings && settings.general && settings.general.exclusionList) || DEFAULT_EXCLUSION_LIST;
}

module.exports = { run, verifyOldApp };
