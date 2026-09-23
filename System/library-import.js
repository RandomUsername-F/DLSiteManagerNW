// system/library-import.js
// Orchestrates adding games to the library: resolving folders/product
// codes from what the user picked or dropped (system/game-scanner.js),
// prompting on ambiguous cases (no code found / code already exists),
// creating the stub database record, and handing off to
// system/dlsite_parser.js to fill it in. This is the only place that
// ties the scanner, confirmDialog, and the database together;
// system/app.js just calls the functions exported here.

const fs = require('fs');
const path = require('path');

const scanner = require('./game-scanner.js');
const { confirmDialog } = require('./confirm-dialog.js');
const { showReport } = require('./report-modal.js');
const { fetchGameInfo } = require('./dlsite_parser.js');
const db = require('./db.js');

const DEFAULT_EXCLUSION_LIST =
  'config|unins|cliploger|EnigmaVBUnpacker|RPGMakerMVGame Hook patcher|agth|RPGMakerTrans|decrypter|MVPluginPatcher|setup|notification_helper|UnityCrashHandler64|UnityCrashHandler';

async function getExclusionList() {
  const settings = await db.getSetting('app', null);
  const configured = settings && settings.general && settings.general.exclusionList;
  return configured || DEFAULT_EXCLUSION_LIST;
}

/**
 * Processes a list of .exe paths (from "Add executable" or a file drop)
 * one at a time, in order - sequential on purpose, so a prompt for one
 * item is always resolved before the next one's is shown.
 */
async function addFromExecutablePaths(exePaths, options) {
  for (const exePath of exePaths) {
    await processCandidate(scanner.resolveGameFromExecutable(exePath), options);
  }
}

/**
 * Processes a list of directory paths (from "Add directory" or a folder
 * drop). Each directory may resolve to one game (if it directly contains
 * an executable) or several (if it's a parent folder of multiple game
 * subfolders) - see game-scanner.js for the exact rule. All candidates
 * from all directories are processed sequentially, one prompt at a time.
 */
async function addFromDirectoryPaths(dirPaths, options) {
  const exclusionList = await getExclusionList();
  for (const dirPath of dirPaths) {
    const candidates = scanner.resolveGameFoldersFromDirectory(dirPath, exclusionList);
    for (const candidate of candidates) {
      await processCandidate(candidate, options);
    }
  }
}

/**
 * Routes a mixed list of dropped paths (files and/or directories) through
 * the same logic as the two functions above - "automatically determine
 * action", per spec. Anything that's neither a .exe nor a directory is
 * silently ignored, also per spec.
 */
async function addFromDroppedPaths(paths, options) {
  const exclusionList = await getExclusionList();

  for (const p of paths) {
    let stat;
    try {
      stat = fs.statSync(p);
    } catch (e) {
      continue; // no longer exists / inaccessible - skip
    }

    if (stat.isDirectory()) {
      const candidates = scanner.resolveGameFoldersFromDirectory(p, exclusionList);
      for (const candidate of candidates) {
        await processCandidate(candidate, options);
      }
    } else if (stat.isFile() && p.toLowerCase().endsWith('.exe')) {
      await processCandidate(scanner.resolveGameFromExecutable(p), options);
    }
    // else: neither an exe nor a directory - ignore
  }
}

/**
 * The shared per-candidate flow: no-code / already-exists prompts, then
 * the stub database record, then a (currently no-op) parser call.
 * options.onGameAdded(record), if given, runs after each successful add -
 * system/app.js uses it to refresh the table without re-fetching after
 * every single item in a batch.
 */
async function processCandidate({ folderPath, productCode }, options) {
  options = options || {};
  const folderName = path.basename(folderPath);

  if (!productCode) {
    const confirmed = await confirmDialog(
      `No product code found in "${folderName}".`,
      { okLabel: 'Add anyway', cancelLabel: 'Skip' }
    );
    if (!confirmed) return;

    const record = await db.addGame({ productCode: generateLocalId(), path: folderPath });
    if (options.onGameAdded) options.onGameAdded(record);
    return;
  }

  if (await db.gameExists(productCode)) {
    const confirmed = await confirmDialog(
      `A game with code "${productCode}" already exists in the library.`,
      { okLabel: 'Add anyway', cancelLabel: 'Skip' }
    );
    if (!confirmed) return;

    // productCode is the database's primary key, so a true duplicate
    // can't coexist as-is - disambiguate rather than silently overwrite
    // the existing entry's data.
    const record = await db.addGame({ productCode: disambiguateCode(productCode), path: folderPath });
    if (options.onGameAdded) options.onGameAdded(record);
    return;
  }

  // New, unambiguous product code.
  const record = await db.addGame({ productCode, path: folderPath });

  try {
    const info = await fetchGameInfo(productCode);
    if (info) {
      await applyParsedInfo(productCode, info);
    }
  } catch (e) {
    console.error('fetchGameInfo failed for', productCode, e);
    // A failed/thrown parse must never take down the add flow - the stub
    // record still exists and can be filled in later via Download info.
  }

  if (options.onGameAdded) options.onGameAdded(record);
}

/**
 * Writes parsed data into `original` (never `override`, which is
 * exclusively the user's own edits) and resolves/creates the circle by
 * name+rgCode the same way db.seedFromBackups() does for JSON backups.
 *
 * NOTE: info.images (see dlsite_parser.js) is remote URLs, not local
 * files - actually downloading and saving them under
 * Database/Games/DLsite/<code>/images/ isn't implemented yet, so that
 * part of the parse result is intentionally not persisted here. Logged
 * rather than silently dropped.
 */
async function applyParsedInfo(productCode, info) {
  const record = await db.getGameRecord(productCode);
  if (!record) return;

  const original = Object.assign({}, record.original);

  for (const field of db.OVERRIDABLE_FIELDS) {
    if (field === 'circleId') continue; // handled separately below
    if (info[field] !== undefined) original[field] = info[field];
  }

  if (info.circle && info.circle.name) {
    let existing = null;
    if (info.circle.rgCode) {
      existing = await db.db.circles.where('rgCode').equals(info.circle.rgCode).first();
    }
    if (!existing) {
      existing = await db.db.circles.where('name').equals(info.circle.name).first();
    }
    original.circleId = existing ? existing.circleId : await db.saveCircle(info.circle);
  }

  await db.db.games.update(productCode, { original });

  if (info.images && (info.images.thumbUrl || (info.images.galleryUrls || []).length)) {
    console.warn('applyParsedInfo:', productCode, 'has image URLs from the parser, but downloading/saving images to disk is not implemented yet - skipped.');
  }
}

/**
 * Scans a folder tree (same rule as "Add directory") without adding
 * anything, and reports which found product codes are already present in
 * the library - i.e. games that may have been added more than once from
 * different folders. Shows the results in a dismissible report modal.
 */
async function findDuplicates(rootPath) {
  const exclusionList = await getExclusionList();
  const candidates = scanner.resolveGameFoldersFromDirectory(rootPath, exclusionList);

  const duplicates = [];
  for (const candidate of candidates) {
    if (!candidate.productCode) continue;
    const existing = await db.getGameRecord(candidate.productCode);
    if (existing) {
      duplicates.push({
        productCode: candidate.productCode,
        scannedPath: candidate.folderPath,
        existingPath: existing.path
      });
    }
  }

  await showReport(
    'Find duplicates',
    duplicates.map(d => ({
      primary: `${d.productCode} - already in the library`,
      secondary: `Scanned: ${d.scannedPath}  |  Existing: ${d.existingPath}`
    }))
  );

  return duplicates;
}

/** Reloads every game from its JSON backup under Database/Games - see db.seedFromBackups(). */
async function rebuildIndex() {
  return db.seedFromBackups();
}

function generateLocalId() {
  return 'LOCAL-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function disambiguateCode(baseCode) {
  return baseCode + '-DUP' + Date.now().toString(36).toUpperCase();
}

module.exports = {
  addFromExecutablePaths,
  addFromDirectoryPaths,
  addFromDroppedPaths,
  findDuplicates,
  rebuildIndex,
  DEFAULT_EXCLUSION_LIST
};
