// system/game-scanner.js
// Pure filesystem logic for locating game folders and DLsite product
// codes - no DOM, no database access, so it's easy to reason about and
// test in isolation. system/library-import.js is the orchestration layer
// that wires this up to prompts and the database.

const fs = require('fs');
const path = require('path');

// DLsite product codes: two letters (RJ/VJ/BJ/RE/VE/... depending on
// platform/category) followed by 6-8 digits. Matched case-insensitively
// and normalized to uppercase.
const PRODUCT_CODE_PATTERN = /\b([A-Za-z]{2}\d{6,8})\b/;

/** Finds a DLsite-style product code anywhere in a string, or null. */
function extractProductCode(name) {
  if (!name) return null;
  const match = PRODUCT_CODE_PATTERN.exec(name);
  return match ? match[1].toUpperCase() : null;
}

/**
 * True if `name` (a file or folder name) matches any entry in the
 * exclusion list - a case-insensitive substring match against each
 * pipe-separated entry, same format/semantics as the old app's list
 * (e.g. "config|unins|notification_helper|...").
 */
function isExcludedName(name, exclusionListString) {
  if (!name || !exclusionListString) return false;
  const lowerName = name.toLowerCase();
  return exclusionListString
    .split('|')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .some(pattern => lowerName.includes(pattern));
}

/**
 * Returns the non-excluded .exe filenames directly inside dirPath (not
 * recursive). Returns [] if dirPath doesn't exist or isn't a directory.
 */
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

/** Returns the immediate subdirectory names of dirPath (not recursive). */
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
 * Given a folder the user dropped/picked via "Add directory":
 * - if it directly contains a (non-excluded) executable, treat it as a
 *   single game folder and pull the product code from ITS OWN name.
 * - otherwise, assume it's a parent folder of multiple games: scan one
 *   level of subfolders, and for each one that itself contains an
 *   executable, pull the product code from THAT subfolder's name. Sub-
 *   folders without an executable are skipped (no deeper recursion).
 *
 * Returns Game[] where Game = { folderPath, productCode: string|null }
 */
function resolveGameFoldersFromDirectory(dirPath, exclusionListString) {
  const ownExecutables = findExecutablesInDir(dirPath, exclusionListString);

  if (ownExecutables.length > 0) {
    return [{
      folderPath: dirPath,
      productCode: extractProductCode(path.basename(dirPath))
    }];
  }

  const results = [];
  for (const subName of listSubdirectories(dirPath)) {
    const subPath = path.join(dirPath, subName);
    const subExecutables = findExecutablesInDir(subPath, exclusionListString);
    if (subExecutables.length === 0) continue; // not a game folder - skip, no deeper recursion

    results.push({
      folderPath: subPath,
      productCode: extractProductCode(subName)
    });
  }
  return results;
}

/**
 * Given an .exe path the user picked/dropped directly, the "game" is
 * its containing folder, and the product code comes from that folder's
 * name (matches the old app's convention of a folder-per-game).
 */
function resolveGameFromExecutable(exePath) {
  const folderPath = path.dirname(exePath);
  return {
    folderPath,
    productCode: extractProductCode(path.basename(folderPath))
  };
}

module.exports = {
  PRODUCT_CODE_PATTERN,
  extractProductCode,
  isExcludedName,
  findExecutablesInDir,
  listSubdirectories,
  resolveGameFoldersFromDirectory,
  resolveGameFromExecutable
};
