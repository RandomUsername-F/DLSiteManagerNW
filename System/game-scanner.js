// system/game-scanner.js
// Pure filesystem logic for locating game folders, product codes, and
// (now) a specific primary executable within them - no DOM, no database
// access. system/library-import.js is the orchestration layer that wires
// this up to prompts and the database.

const fs = require('fs');
const path = require('path');

// DLsite product codes: two letters (RJ/VJ/BJ/RE/VE/... depending on
// platform/category) followed by 6-8 digits. Matched case-insensitively
// and normalized to uppercase.
const PRODUCT_CODE_PATTERN = /\b([A-Za-z]{2}\d{6,8})\b/;

function extractProductCode(name) {
  if (!name) return null;
  const match = PRODUCT_CODE_PATTERN.exec(name);
  return match ? match[1].toUpperCase() : null;
}

/** Case-insensitive substring match against each pipe-separated entry (same format as the old app's exclusion list). */
function isExcludedName(name, exclusionListString) {
  if (!name || !exclusionListString) return false;
  const lowerName = name.toLowerCase();
  return exclusionListString
    .split('|')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .some(pattern => lowerName.includes(pattern));
}

function findExecutablesInDir(dirPath, exclusionListString) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (e) {
    return [];
  }

  return entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
    .map(entry => entry.name)
    .filter(name => !isExcludedName(name, exclusionListString));
}

function listSubdirectories(dirPath) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
}

/**
 * When a folder has more than one candidate executable, picks the one
 * that's most likely the actual game: prefers a filename closely matching
 * the folder's own name, then falls back to the largest file (helper/
 * launcher/uninstaller tools are typically much smaller than the game
 * itself).
 */
function pickPrimaryExecutable(dirPath, exeFilenames) {
  if (exeFilenames.length === 1) return exeFilenames[0];

  const folderName = path.basename(dirPath).toLowerCase();
  const byNameMatch = exeFilenames.find(name => {
    const base = name.replace(/\.exe$/i, '').toLowerCase();
    return folderName.includes(base) || base.includes(folderName);
  });
  if (byNameMatch) return byNameMatch;

  let largest = exeFilenames[0];
  let largestSize = -1;
  for (const name of exeFilenames) {
    try {
      const size = fs.statSync(path.join(dirPath, name)).size;
      if (size > largestSize) {
        largestSize = size;
        largest = name;
      }
    } catch (e) { /* unreadable - skip, keep current best guess */ }
  }
  return largest;
}

/**
 * Given a folder the user dropped/picked via "Add directory":
 * - if it directly contains a (non-excluded) executable, treat it as a
 *   single game folder and pull the product code from ITS OWN name.
 * - otherwise, assume it's a parent folder of multiple games: scan one
 *   level of subfolders, and for each one that itself contains an
 *   executable, pull the product code from THAT subfolder's name. Sub-
 *   folders without an executable are skipped (no deeper recursion).
 *
 * Returns { exePath, productCode: string|null }[] - exePath is the full
 * path to the picked primary executable (see pickPrimaryExecutable),
 * since a game record's `path` now points directly at the exe, not just
 * its containing folder.
 */
function resolveGameFoldersFromDirectory(dirPath, exclusionListString) {
  const ownExecutables = findExecutablesInDir(dirPath, exclusionListString);

  if (ownExecutables.length > 0) {
    return [{
      exePath: path.join(dirPath, pickPrimaryExecutable(dirPath, ownExecutables)),
      productCode: extractProductCode(path.basename(dirPath))
    }];
  }

  const results = [];
  for (const subName of listSubdirectories(dirPath)) {
    const subPath = path.join(dirPath, subName);
    const subExecutables = findExecutablesInDir(subPath, exclusionListString);
    if (subExecutables.length === 0) continue; // not a game folder - skip, no deeper recursion

    results.push({
      exePath: path.join(subPath, pickPrimaryExecutable(subPath, subExecutables)),
      productCode: extractProductCode(subName)
    });
  }
  return results;
}

/**
 * Given an .exe path the user picked/dropped directly, that IS the game's
 * exe - the product code comes from its containing folder's name (the
 * old app's folder-per-game convention).
 */
function resolveGameFromExecutable(exePath) {
  return {
    exePath,
    productCode: extractProductCode(path.basename(path.dirname(exePath)))
  };
}

// ---------------------------------------------------------------
// Engine detection - heuristic, based on telltale files/folders each
// engine's runtime leaves behind next to the exe. Best-effort: returns a
// human-readable engine name, or null if nothing matched.
// ---------------------------------------------------------------
function detectEngine(exePath) {
  const dirPath = path.dirname(exePath);
  let entries;
  try {
    entries = fs.readdirSync(dirPath);
  } catch (e) {
    return null;
  }
  const lower = entries.map(e => e.toLowerCase());
  const has = (name) => lower.includes(name.toLowerCase());
  const hasAny = (names) => names.some(has);
  const hasSuffix = (suffix) => lower.some(e => e.endsWith(suffix.toLowerCase()));

  if (hasAny(['www', 'js']) && (has('package.json') || hasSuffix('.rpgproject'))) {
    return 'RPG Maker MV/MZ';
  }
  if (hasSuffix('.rgss3a') || has('game.rgss3a')) return 'RPG Maker VX Ace';
  if (hasSuffix('.rgss2a')) return 'RPG Maker VX';
  if (hasSuffix('.rgssad')) return 'RPG Maker XP';
  if (has('data.wolf') || (has('data') && hasSuffix('.wolf'))) return 'Wolf RPG Editor';
  if (hasSuffix('.xp3') || has('krkrz.exe') || has('reallive.exe')) return 'KiriKiri';
  if (has('renpy') || hasSuffix('.rpa') || hasSuffix('.rpyc')) return "Ren'Py";
  if (has('nscript.dat') || hasSuffix('.nsa')) return 'NScripter';
  if (lower.some(e => e.endsWith('_data')) && has('unityplayer.dll')) return 'Unity';
  if (has('data.win') || has('audiogroup1.dat')) return 'GameMaker';
  if (has('ags32.dll') || hasSuffix('.ags')) return 'Adventure Game Studio';

  return null;
}

module.exports = {
  PRODUCT_CODE_PATTERN,
  extractProductCode,
  isExcludedName,
  findExecutablesInDir,
  listSubdirectories,
  pickPrimaryExecutable,
  resolveGameFoldersFromDirectory,
  resolveGameFromExecutable,
  detectEngine
};
