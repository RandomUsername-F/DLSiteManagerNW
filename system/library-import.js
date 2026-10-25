// system/library-import.js
// Orchestrates adding games to the library: resolving folders/product
// codes/primary executables from what the user picked or dropped
// (system/game-scanner.js), queueing them and prompting on ambiguous cases,
// creating the database record, and handing off to system/dlsite_parser.js +
// system/image-downloader.js to fill it in. Also home to the other
// per-game actions that share this same "fetch/scan + guard + write"
// shape: download/update info, check-for-updates, rename/organize, remove.

const fs = require('fs');
const path = require('path');
const dns = require('dns');

const scanner = require('./game-scanner.js');
const { confirmDialog, confirmDialogEx } = require('./confirm-dialog.js');
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
//
// Everything added goes through ONE shared queue, processed strictly one
// candidate at a time. Adding more files while a batch is still running
// appends them to the end of that batch (and the counter grows). Every
// add call resolves when the whole batch has finished.
// ---------------------------------------------------------------

const queue = [];
let batchPromise = null;
let batchActive = false;
let batchTotal = 0;
let batchDone = 0;
let batchAnswers = {};   // remembered "Do this for all" answers, per prompt kind
let batchOptions = {};

function enqueue(candidates, options) {
  if (options) batchOptions = options;
  if (!candidates.length) return batchPromise || Promise.resolve();

  if (!batchPromise) {
    batchTotal = 0;
    batchDone = 0;
    batchAnswers = {};
    batchActive = true; // set before runQueue() starts: it runs synchronously up to its first await
  }
  for (const c of candidates) {
    queue.push(c);
    batchTotal++;
  }
  if (!batchPromise) batchPromise = runQueue();
  return batchPromise;
}

/** Status-bar text with a batch counter, e.g. "Fetching RJ012345… (3/10)". Without text it shows the plain batch progress. */
function batchStatus(text) {
  const raw = batchOptions && batchOptions.onStatus;
  if (!raw) return;
  if (batchTotal > 1 && batchActive) {
    const counter = `(${Math.min(batchDone + 1, batchTotal)}/${batchTotal})`;
    raw(text ? `${text} ${counter}` : `Adding games ${counter}`);
  } else {
    raw(text || null);
  }
}

async function runQueue() {
  while (queue.length) {
    const candidate = queue.shift();
    const itemOptions = Object.assign({}, batchOptions, { onStatus: batchStatus });
    batchStatus(null);
    try {
      await processCandidate(candidate, itemOptions);
    } catch (e) {
      console.error('Adding failed for', candidate && candidate.exePath, e);
    }
    batchDone++;
  }
  // Synchronous with the queue-empty check above, so a call arriving right
  // after this starts a fresh batch instead of being lost.
  batchPromise = null;
  batchActive = false;
  batchTotal = 0;
  batchDone = 0;
  batchAnswers = {};
  if (batchOptions && batchOptions.onStatus) batchOptions.onStatus(null);
}

/**
 * An "Add anyway / Skip" style prompt. Inside a multi-item batch it offers
 * "Do this for all"; once ticked, the chosen answer is reused silently for
 * every later prompt of the same kind in the current batch.
 */
async function askAddAnyway(kind, message, okLabel, cancelLabel) {
  if (batchAnswers[kind] !== undefined) return batchAnswers[kind];

  const moreItemsFollow = batchActive && (batchTotal - batchDone) > 1;
  const { confirmed, checked } = await confirmDialogEx(message, {
    okLabel: okLabel || 'Add anyway',
    cancelLabel: cancelLabel || 'Skip',
    checkbox: moreItemsFollow ? 'Do this for all' : null
  });
  if (checked) batchAnswers[kind] = confirmed;
  return confirmed;
}

async function addFromExecutablePaths(exePaths, options) {
  return enqueue(exePaths.map(p => scanner.resolveGameFromExecutable(p)), options);
}

async function addFromDirectoryPaths(dirPaths, options) {
  const exclusionList = await getExclusionList();
  const candidates = [];
  for (const dirPath of dirPaths) {
    candidates.push(...scanner.resolveGameFoldersFromDirectory(dirPath, exclusionList));
  }
  return enqueue(candidates, options);
}

async function addFromDroppedPaths(paths, options) {
  const exclusionList = await getExclusionList();
  const candidates = [];

  for (const p of paths) {
    let stat;
    try {
      stat = fs.statSync(p);
    } catch (e) {
      continue;
    }

    if (stat.isDirectory()) {
      candidates.push(...scanner.resolveGameFoldersFromDirectory(p, exclusionList));
    } else if (stat.isFile() && p.toLowerCase().endsWith('.exe')) {
      candidates.push(scanner.resolveGameFromExecutable(p));
    }
  }
  return enqueue(candidates, options);
}

/**
 * The shared per-candidate flow, run one candidate at a time from the queue:
 * no-code and already-exists (by productCode OR dlcCode) prompts; for a
 * brand-new code, the DLsite parse (with its connectivity check) happens
 * BEFORE the record is created so a DLC of a game already in the library
 * can be flagged; then the database record is created, the engine detected
 * and the parsed info applied. FANZA codes skip the parse entirely.
 * options.onGameAdded(record) and options.onStatus(text|null) are optional
 * progress hooks.
 */
async function processCandidate({ exePath, productCode }, options) {
  options = options || {};
  const folderName = path.basename(path.dirname(exePath));

  if (!productCode) {
    const confirmed = await askAddAnyway('noCode', `No product code found in "${folderName}".`);
    if (!confirmed) return;

    const record = await db.addGame({ productCode: generateLocalId(), path: exePath });
    await finishAdding(record, null, options);
    return;
  }

  const existing = await db.findGameByCodeOrDlc(productCode);
  if (existing) {
    const matchKind = existing.productCode === productCode ? 'product code' : 'DLC code';
    const confirmed = await askAddAnyway('exists', `A game with ${matchKind} "${productCode}" already exists in the library.`);
    if (!confirmed) return;

    // productCode is the database's primary key, so a true duplicate
    // can't coexist as-is - disambiguate rather than silently overwrite.
    const record = await db.addGame({ productCode: disambiguateCode(productCode), path: exePath });
    await finishAdding(record, productCode, options);
    return;
  }

  // Brand-new code: parse first, so a DLC whose parent is already in the library can be flagged before anything is added.
  const info = await runParseWithGuards(productCode, productCode, { fields: undefined }, options);
  if (info && info.dlcParent) {
    const parent = await db.db.games.where('productCode').startsWith(info.dlcParent).first();
    if (parent) {
      const parentTitle = db.resolveGame(parent).title;
      const confirmed = await askAddAnyway(
        'dlc',
        `${productCode} appears to be a DLC of ${info.dlcParent}${parentTitle ? ` (${parentTitle})` : ''}, which is already in the library.`
      );
      if (!confirmed) return;
    }
  }

  const record = await db.addGame({ productCode, path: exePath });
  await finishAdding(record, productCode, options, info);
}

async function finishAdding(record, parseCode, options, prefetchedInfo) {
  const engine = scanner.detectEngine(record.path);
  if (engine) {
    await db.updateGameFields(record.productCode, { original: Object.assign({}, record.original, { engine }) });
  }

  if (parseCode) {
    const info = prefetchedInfo !== undefined
      ? prefetchedInfo
      : await runParseWithGuards(record.productCode, parseCode, { fields: undefined }, options);
    if (info) await applyParsedInfo(record.productCode, info, 'download');
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

  // FANZA/DMM blocks foreign IPs and the parser is DLsite-only: never fetch, just keep the code.
  if (scanner.isFanzaCode(fetchCode)) return null;

  const online = options.skipConnectivityCheck ? true : await checkConnectivity();
  if (!online) {
    const proceed = await askAddAnyway('offline', "Couldn't reach DLsite (no internet connection?).", 'Add anyway', 'Cancel');
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
    if (field === 'circleId') continue; // handled separately below
    if (field === 'version') continue;  // the parser's "version" is the site's currently-listed version, i.e. latestVersion - see below. Nothing ever writes to original.version automatically; it stays purely user-entered (there's no way to know what's actually installed).
    if (field === 'latestVersion') continue; // set from info.version below, not info.latestVersion (the parser never returns that key)
    if (info[field] === undefined) continue;
    const currentlyEmpty = original[field] == null || original[field] === ''
      || (Array.isArray(original[field]) && original[field].length === 0);
    if (mode === 'update' && !currentlyEmpty) continue;
    original[field] = info[field];
  }

  if (info.version !== undefined) {
    const currentlyEmpty = original.latestVersion == null || original.latestVersion === '';
    if (mode !== 'update' || currentlyEmpty) {
      original.latestVersion = info.version;
    }
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

/** Only fills fields currently empty in `original` - never touches anything already set. Also detects the engine from the game's files if the Engine field is empty (works even when the DLsite fetch fails). */
async function updateInfo(productCode, options) {
  const info = await runParseWithGuards(productCode, productCode, { fields: undefined }, options);
  if (info) await applyParsedInfo(productCode, info, 'update');
  const engineDetected = await fillEngineIfEmpty(productCode);
  return !!info || engineDetected;
}

/** Runs engine detection only when neither the user's override nor the original data has an engine. Returns true if one was found and stored (in `original`, like when a game is first added). */
async function fillEngineIfEmpty(productCode) {
  const record = await db.getGameRecord(productCode);
  if (!record || !record.path) return false;
  if ((record.override && record.override.engine) || (record.original && record.original.engine)) return false;

  const engine = scanner.detectEngine(record.path);
  if (!engine) return false;

  await db.db.games.update(productCode, { original: Object.assign({}, record.original, { engine }) });
  await db.saveGameBackup(productCode);
  return true;
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
// (findDuplicates is no longer reachable from the UI - the Action menu
// entry was removed in favor of Filter > Filter on Duplicates.)
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
async function removeFromList(productCode, options) {
  const confirmed = (options && options.skipConfirm) || await confirmDialog(
    `Remove ${productCode} from your library? This does not delete the actual game files - only DLSiteManager's saved info about it.`,
    { okLabel: 'Remove', cancelLabel: 'Cancel' }
  );
  if (!confirmed) return false;

  await db.removeGame(productCode);
  return true;
}

/**
 * Renames a game's folder in place (does not move it; only the last
 * segment of the template is used), or renames AND moves it into the
 * configured main folder (a \ in the template makes sub-folders), per
 * `organize`. Both check for an existing folder at the destination first -
 * the check only applies to the resolved game folder name itself; a
 * template segment like "[{circle}]" that happens to collide with another
 * existing top-level folder (not itself a specific game's folder) is not
 * treated as a conflict. Paths stored for this game (and any other game
 * living inside the moved folder) are updated to match.
 */
async function renameGame(productCode, template, organize, mainFolder) {
  const record = await db.getGameRecord(productCode);
  if (!record) throw new Error('No such game: ' + productCode);
  if (!record.path || !fs.existsSync(record.path)) throw new Error(`Game path not found: ${record.path || '(empty)'}`);

  if (!/\{(rjcode|foldername)\}/i.test(template)) {
    throw new Error('Rename template must contain {rjcode} or {foldername}.');
  }

  const resolved = db.resolveGame(record);
  const circle = resolved.circleId != null
    ? (await db.getAllCircles()).find(c => c.circleId === resolved.circleId)
    : null;

  const rawName = applyRenameTemplate(template, {
    rjcode: resolved.productCode,
    circle: circle ? circle.name : '',
    cvs: Array.isArray(resolved.cvs) ? resolved.cvs.join(', ') : (resolved.cvs || ''),
    title: resolved.title || '',
    category: resolved.category || '',
    foldername: path.basename(path.dirname(record.path))
  });

  // Windows-safe segments: no empty parts, no trailing dots/spaces.
  const segments = rawName.split(/[\\/]+/)
    .map(s => s.trim().replace(/[. ]+$/, ''))
    .filter(Boolean);
  if (!segments.length) throw new Error('Rename template produced an empty folder name.');

  const currentDir = path.dirname(record.path);
  const exeName = path.basename(record.path);

  // Sub-folders (\) only apply when organizing under the Main folder; an in-place
  // rename keeps just the last segment (the folder name itself) and never moves anything.
  const destDir = organize
    ? path.join(mainFolder, ...segments)
    : path.join(path.dirname(currentDir), segments[segments.length - 1]);

  const curLower = currentDir.toLowerCase();
  const destLower = destDir.toLowerCase();

  if (destDir === currentDir) return record.path; // already named as the template says
  if (destLower !== curLower && fs.existsSync(destDir)) {
    throw new Error(`A folder already exists at "${destDir}".`);
  }
  if (destLower.startsWith(curLower + path.sep)) {
    throw new Error('Destination is inside the game\'s current folder.');
  }

  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  moveDirectory(currentDir, destDir);

  const newPath = path.join(destDir, exeName);

  // Paths pointing inside the folder that just moved - the game's exe and its
  // Launcher (if that file lives in the game folder) - follow it to the new location.
  const patch = { path: newPath };
  const movedLauncher = rebaseInto(record.launcher && record.launcher.value, currentDir, destDir);
  if (movedLauncher) patch.launcher = Object.assign({}, record.launcher, { value: movedLauncher });
  await db.updateGameFields(productCode, patch);

  // Same for any other game whose exe or launcher lives inside the moved folder.
  for (const g of await db.db.games.toArray()) {
    if (g.productCode === productCode) continue;
    const otherPatch = {};
    const otherPath = rebaseInto(g.path, currentDir, destDir);
    if (otherPath) otherPatch.path = otherPath;
    const otherLauncher = rebaseInto(g.launcher && g.launcher.value, currentDir, destDir);
    if (otherLauncher) otherPatch.launcher = Object.assign({}, g.launcher, { value: otherLauncher });
    if (Object.keys(otherPatch).length) await db.updateGameFields(g.productCode, otherPatch);
  }

  return newPath;
}

/** If `p` is a path inside oldDir, returns the same relative location under newDir; otherwise null. */
function rebaseInto(p, oldDir, newDir) {
  if (typeof p !== 'string' || !p) return null;
  if (!p.toLowerCase().startsWith(oldDir.toLowerCase() + path.sep)) return null;
  return path.join(newDir, p.slice(oldDir.length + 1));
}

/** rename, falling back to copy+delete when source/destination are on different drives (EXDEV). */
function moveDirectory(src, dest) {
  try {
    fs.renameSync(src, dest);
    return;
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
  }
  fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false });
  fs.rmSync(src, { recursive: true, force: true });
}

function applyRenameTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const value = values[key.toLowerCase()];
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
