// system/library-import.js
// Orchestrates adding games to the library: resolving folders/product
// codes/primary executables from what the user picked or dropped
// (system/game-scanner.js), prompting on ambiguous cases, creating the
// stub database record, and handing off to system/dlsite_parser.js +
// system/image-downloader.js to fill it in. Also home to the other
// per-game actions that share this same "fetch/scan + guard + write"
// shape: check-for-updates, rename/organize, remove.

const fs = require('fs');
const path = require('path');
const dns = require('dns');

const scanner = require('./game-scanner.js');
const { confirmDialog } = require('./confirm-dialog.js');
const { showReport } = require('./report-modal.js');
const { fetchGameInfo } = require('./dlsite_parser.js');
const { downloadGameImages } = require('./image-downloader.js');
const db = require('./db.js');

const DEFAULT_EXCLUSION_LIST =
  'config|unins|cliploger|EnigmaVBUnpacker|RPGMakerMVGame Hook patcher|agth|RPGMakerTrans|decrypter|MVPluginPatcher|setup|notification_helper|UnityCrashHandler64|UnityCrashHandler';

async function getExclusionList() {
  const settings = await db.getSetting('app', null);
  const configured = settings && settings.general && settings.general.exclusionList;
  return configured || DEFAULT_EXCLUSION_LIST;
}

/** Quick DNS-based reachability check - much cheaper than a full page fetch, used to warn before spending time on a parse that's likely to fail anyway. */
function checkConnectivity() {
  return new Promise((resolve) => {
    dns.lookup('www.dlsite.com', (err) => resolve(!err));
  });
}

// ---------------------------------------------------------------
// Adding games
// ---------------------------------------------------------------

async function addFromExecutablePaths(exePaths, options) {
  for (const exePath of exePaths) {
    await processCandidate(scanner.resolveGameFromExecutable(exePath), options);
  }
}

async function addFromDirectoryPaths(dirPaths, options) {
  const exclusionList = await getExclusionList();
  for (const dirPath of dirPaths) {
    const candidates = scanner.resolveGameFoldersFromDirectory(dirPath, exclusionList);
    for (const candidate of candidates) {
      await processCandidate(candidate, options);
    }
  }
}

async function addFromDroppedPaths(paths, options) {
  const exclusionList = await getExclusionList();

  for (const p of paths) {
    let stat;
    try {
      stat = fs.statSync(p);
    } catch (e) {
      continue;
    }

    if (stat.isDirectory()) {
      const candidates = scanner.resolveGameFoldersFromDirectory(p, exclusionList);
      for (const candidate of candidates) {
        await processCandidate(candidate, options);
      }
    } else if (stat.isFile() && p.toLowerCase().endsWith('.exe')) {
      await processCandidate(scanner.resolveGameFromExecutable(p), options);
    }
  }
}

/**
 * The shared per-candidate flow: no-code / already-exists (by productCode
 * OR dlcCode) prompts, then a connectivity check, then the stub database
 * record + parser call. options.onGameAdded(record) and
 * options.onStatus(text|null) are both optional progress hooks.
 */
async function processCandidate({ exePath, productCode }, options) {
  options = options || {};
  const folderName = path.basename(path.dirname(exePath));

  if (!productCode) {
    const confirmed = await confirmDialog(
      `No product code found in "${folderName}".`,
      { okLabel: 'Add anyway', cancelLabel: 'Skip' }
    );
    if (!confirmed) return;

    const record = await db.addGame({ productCode: generateLocalId(), path: exePath });
    await finishAdding(record, null, options);
    return;
  }

  const existing = await db.findGameByCodeOrDlc(productCode);
  if (existing) {
    const matchKind = existing.productCode === productCode ? 'product code' : 'DLC code';
    const confirmed = await confirmDialog(
      `A game with ${matchKind} "${productCode}" already exists in the library.`,
      { okLabel: 'Add anyway', cancelLabel: 'Skip' }
    );
    if (!confirmed) return;

    // productCode is the database's primary key, so a true duplicate
    // can't coexist as-is - disambiguate rather than silently overwrite.
    const record = await db.addGame({ productCode: disambiguateCode(productCode), path: exePath });
    await finishAdding(record, productCode, options);
    return;
  }

  const record = await db.addGame({ productCode, path: exePath });
  await finishAdding(record, productCode, options);
}

async function finishAdding(record, parseCode, options) {
  const engine = scanner.detectEngine(record.path);
  if (engine) {
    await db.updateGameFields(record.productCode, { original: Object.assign({}, record.original, { engine }) });
  }

  if (parseCode) {
    await runParseWithGuards(record.productCode, parseCode, { fields: undefined }, options);
  }

  if (options.onGameAdded) options.onGameAdded(record);
}

/**
 * Wraps a parser call with the connectivity check + status indicator +
 * error handling every parse-triggering action shares (add, Download
 * info, Update info, Check for updates).
 */
async function runParseWithGuards(productCode, fetchCode, fetchOptions, options) {
  options = options || {};

  const online = await checkConnectivity();
  if (!online) {
    const proceed = await confirmDialog(
      "Couldn't reach DLsite (no internet connection?).",
      { okLabel: 'Add anyway', cancelLabel: 'Cancel' }
    );
    if (!proceed) return null;
  }

  if (options.onStatus) options.onStatus(`Fetching ${fetchCode}\u2026`);

  let info = null;
  try {
    info = await fetchGameInfo(fetchCode, fetchOptions);
  } catch (e) {
    console.error('fetchGameInfo failed for', fetchCode, e);
  } finally {
    if (options.onStatus) options.onStatus(null);
  }

  return info;
}

/**
 * Writes parsed data into `original` (never `override`, which is
 * exclusively the user's own edits). Also downloads any image URLs the
 * parser found - a fully failed download batch leaves existing local
 * images untouched, same "never overwrite good data with bad" rule
 * dlsite_parser.js follows for every other field.
 *
 * mode: 'download' (default) overwrites every field the parser returned;
 * 'update' only fills fields that are currently empty in `original` -
 * see the Download info / Update info context-menu actions.
 */
async function applyParsedInfo(productCode, info, mode) {
  const record = await db.getGameRecord(productCode);
  if (!record) return;

  const original = Object.assign({}, record.original);

  for (const field of db.OVERRIDABLE_FIELDS) {
    if (field === 'circleId') continue;
    if (info[field] === undefined) continue;
    const currentlyEmpty = original[field] == null || original[field] === ''
      || (Array.isArray(original[field]) && original[field].length === 0);
    if (mode === 'update' && !currentlyEmpty) continue;
    original[field] = info[field];
  }

  if (info.circle && info.circle.name && (mode !== 'update' || original.circleId == null)) {
    let existing = null;
    if (info.circle.rgCode) {
      existing = await db.db.circles.where('rgCode').equals(info.circle.rgCode).first();
    }
    if (!existing) {
      existing = await db.db.circles.where('name').equals(info.circle.name).first();
    }
    original.circleId = existing ? existing.circleId : await db.saveCircle(info.circle);
  }

  const patch = { original };

  if (info.images && (mode !== 'update' || !record.images || (!record.images.thumb && !(record.images.gallery || []).length))) {
    try {
      const newImages = await downloadGameImages(productCode, info.images, record.images);
      if (newImages) patch.images = newImages;
    } catch (e) {
      console.error('Image download failed for', productCode, e);
    }
  }

  await db.db.games.update(productCode, patch);
  await db.saveGameBackup(productCode);
}

/** Full re-scrape, overwriting every field the parser finds. */
async function downloadInfo(productCode, options) {
  const info = await runParseWithGuards(productCode, productCode, { fields: undefined }, options);
  if (info) await applyParsedInfo(productCode, info, 'download');
  return !!info;
}

/** Only fills fields currently empty in `original` - never touches anything already set. */
async function updateInfo(productCode, options) {
  const info = await runParseWithGuards(productCode, productCode, { fields: undefined }, options);
  if (info) await applyParsedInfo(productCode, info, 'update');
  return !!info;
}

/** Re-checks just the version field on the site and stores it as original.latestVersion, leaving the locally-tracked `version` untouched. */
async function checkForUpdates(productCode, options) {
  const info = await runParseWithGuards(productCode, productCode, { fields: ['version'] }, options);
  if (!info || info.version === undefined) return null;

  const record = await db.getGameRecord(productCode);
  if (!record) return null;

  const original = Object.assign({}, record.original, { latestVersion: info.version });
  await db.db.games.update(productCode, { original });
  await db.saveGameBackup(productCode);
  return info.version;
}

// ---------------------------------------------------------------
// Find duplicates / rebuild index
// ---------------------------------------------------------------

async function findDuplicates(rootPath) {
  const exclusionList = await getExclusionList();
  const candidates = scanner.resolveGameFoldersFromDirectory(rootPath, exclusionList);

  const duplicates = [];
  for (const candidate of candidates) {
    if (!candidate.productCode) continue;
    const existing = await db.findGameByCodeOrDlc(candidate.productCode);
    if (existing) {
      duplicates.push({
        productCode: candidate.productCode,
        scannedPath: candidate.exePath,
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

async function rebuildIndex() {
  return db.seedFromBackups();
}

// ---------------------------------------------------------------
// Remove / rename / organize
// ---------------------------------------------------------------

/** Removes a game from the database (and its backup folder). Never touches the actual game files. */
async function removeFromList(productCode) {
  const confirmed = await confirmDialog(
    `Remove ${productCode} from your library? This does not delete the actual game files - only DLSiteManager's saved info about it.`,
    { okLabel: 'Remove', cancelLabel: 'Cancel' }
  );
  if (!confirmed) return false;

  await db.removeGame(productCode);
  return true;
}

/**
 * Renames a game's folder in place (does not move it), or renames AND
 * moves it into the configured main folder, per `organize`. Both check
 * for an existing folder at the destination first - the check only
 * applies to the resolved game folder name itself; a template segment
 * like "[{circle}]" that happens to collide with another existing
 * top-level folder (not itself a specific game's folder) is not treated
 * as a conflict.
 */
async function renameGame(productCode, template, organize, mainFolder) {
  const record = await db.getGameRecord(productCode);
  if (!record) throw new Error('No such game: ' + productCode);

  const resolved = await db.resolveGame(record);
  const circle = resolved.circleId != null
    ? (await db.getAllCircles()).find(c => c.circleId === resolved.circleId)
    : null;

  const newName = applyRenameTemplate(template, {
    rjcode: resolved.productCode,
    circle: circle ? circle.name : '',
    cvs: (resolved.cvs || []).join(', '),
    title: resolved.title || '',
    category: resolved.category || '',
    foldername: path.basename(path.dirname(record.path))
  });

  const currentDir = path.dirname(record.path);
  const exeName = path.basename(record.path);

  const destDir = organize
    ? path.join(mainFolder, newName)
    : path.join(path.dirname(currentDir), newName);

  if (destDir !== currentDir && fs.existsSync(destDir)) {
    throw new Error(`A folder already exists at "${destDir}".`);
  }

  fs.renameSync(currentDir, destDir);

  const newPath = path.join(destDir, exeName);
  await db.updateGameFields(productCode, { path: newPath });
  return newPath;
}

function applyRenameTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const value = values[key];
    return value != null && value !== '' ? sanitizeForPath(String(value)) : '';
  }).trim();
}

function sanitizeForPath(str) {
  return str.replace(/[<>:"/\\|?*]/g, '').trim();
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
  downloadInfo,
  updateInfo,
  checkForUpdates,
  findDuplicates,
  rebuildIndex,
  removeFromList,
  renameGame,
  checkConnectivity,
  DEFAULT_EXCLUSION_LIST
};
