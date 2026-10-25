// system/game-scanner.js
// Pure filesystem logic for locating game folders, product codes, and a
// game's primary executable, plus engine detection - no DOM, no database
// access. system/library-import.js is the orchestration layer that wires
// this up to prompts and the database.

const fs = require('fs');
const path = require('path');
const { getFileDescription } = require('./pe-version.js');

// DLsite product codes: two letters (RJ/VJ/BJ/RE/VE/... depending on
// platform/category) followed by 6-8 digits. Matched case-insensitively
// and normalized to uppercase.
const PRODUCT_CODE_PATTERN = /\b([A-Za-z]{2}\d{6,8})\b/;

// FANZA (DMM) codes: lowercase "d_" followed by 4-8 digits, e.g. d_457096.
// Kept lowercase as-is. DMM blocks foreign IPs, so these are never parsed
// (see library-import.js's runParseWithGuards) - the code is just recorded.
const FANZA_CODE_PATTERN = /(?<![A-Za-z0-9])(d_\d{4,8})(?!\d)/;

function isFanzaCode(code) {
  return /^d_\d{4,8}(-DUP\w*)?$/.test(String(code || ''));
}

function extractProductCode(name) {
  if (!name) return null;
  const match = PRODUCT_CODE_PATTERN.exec(name);
  if (match) return match[1].toUpperCase();
  const fanza = FANZA_CODE_PATTERN.exec(name);
  return fanza ? fanza[1] : null;
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
// Engine detection - heuristic: telltale files/folders each engine's
// runtime leaves behind next to the exe, then (as a last resort) the
// exe's own File description. Best-effort: returns a human-readable
// engine name, or null if nothing matched.
// ---------------------------------------------------------------
/**
 * Wolf RPG Editor, unpacked layout: Data/BasicData (with Game.dat or
 * SysDatabase.*) AND Data/MapData, next to the exe. Also covers partially
 * packed games where Data/ holds .wolf archives (e.g. BasicData.wolf).
 * Filesystem lookups are case-insensitive on Windows, so plain paths are fine.
 */
function isWolfRpgLayout(dirPath, has) {
  if (!has('data')) return false;
  const dataDir = path.join(dirPath, 'Data');

  let dataEntries;
  try {
    dataEntries = fs.readdirSync(dataDir).map(e => e.toLowerCase());
  } catch (e) {
    return false;
  }
  if (dataEntries.some(e => e.endsWith('.wolf'))) return true;

  if (!dataEntries.includes('basicdata') || !dataEntries.includes('mapdata')) return false;
  try {
    const basic = fs.readdirSync(path.join(dataDir, 'BasicData')).map(e => e.toLowerCase());
    return basic.includes('game.dat') || basic.some(e => e.startsWith('sysdatabase.'));
  } catch (e) {
    return false;
  }
}

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

  // RPG Maker MV deploys with a www/ sub-directory; MZ puts js/ (and data/) straight in the game root.
  if (has('www') && (has('package.json') || hasSuffix('.rpgproject'))) return 'RPG Maker MV';
  if (has('js') && (has('package.json') || hasSuffix('.rpgproject'))) return 'RPG Maker MZ';
  if (hasSuffix('.rgss3a') || has('game.rgss3a')) return 'RPG Maker VX Ace';
  if (hasSuffix('.rgss2a')) return 'RPG Maker VX';
  if (hasSuffix('.rgssad')) return 'RPG Maker XP';
  if (has('data.wolf') || (has('data') && hasSuffix('.wolf')) || isWolfRpgLayout(dirPath, has)) return 'Wolf RPG';
  if (hasSuffix('.xp3') || has('krkrz.exe') || has('reallive.exe')) return 'KiriKiri';
  if (has('renpy') || hasSuffix('.rpa') || hasSuffix('.rpyc')) return "Ren'Py";
  if (has('nscript.dat') || hasSuffix('.nsa')) return 'NScripter';
  if (lower.some(e => e.endsWith('_data')) && has('unityplayer.dll')) return 'Unity';
  if (has('data.win') || has('audiogroup1.dat')) return 'GameMaker';
  if (has('ags32.dll') || hasSuffix('.ags')) return 'Adventure Game Studio';

  // Last resort: the exe's own metadata (Properties > Details > File description).
  return detectEngineFromExeMetadata(exePath);
}

// Ordered: first match wins, so more specific patterns come before generic ones.
// These are best-effort guesses at what engines' runtimes write into FileDescription.
const DESCRIPTION_ENGINE_PATTERNS = [
  [/wolf\s*rpg|woditor|ウディタ/i, 'Wolf RPG'],
  [/pixel\s*game\s*maker\s*mv|pgmmv/i, 'Pixel Game Maker MV'],
  [/vx\s*ace|rgss3/i, 'RPG Maker VX Ace'],
  [/rpg\s*maker\s*vx|rgss2/i, 'RPG Maker VX'],
  [/rpg\s*maker\s*xp|rgss1/i, 'RPG Maker XP'],
  [/rpg\s*maker\s*mv/i, 'RPG Maker MV'],
  [/rpg\s*maker\s*mz/i, 'RPG Maker MZ'],
  [/rpg\s*maker\s*(2000|2003)|rpg_rt/i, 'RPG Maker 2000/2003'],
  [/rpg\s*maker|rpg\s*tkool|rgss|ツクール/i, 'RPG Maker'],
  [/tyrano/i, 'TyranoScript'],
  [/nw\.?js|node-webkit/i, 'NW.js'],
  [/electron/i, 'Electron'],
  [/kirikiri|tvp\s*\(/i, 'KiriKiri'],
  [/ren'?py/i, "Ren'Py"],
  [/onscripter|nscripter/i, 'NScripter'],
  [/godot/i, 'Godot'],
  [/unreal/i, 'Unreal Engine'],
  [/unity/i, 'Unity'],
  [/adventure game studio|\bags\b/i, 'Adventure Game Studio'],
  [/construct\s*[23]?\b/i, 'Construct'],
  [/\blöve\b|\blove2d\b/i, 'LÖVE'],
  [/siglus/i, 'SiglusEngine'],
  [/defold/i, 'Defold'],
  [/appgamekit|\bagk\b/i, 'AppGameKit'],
  [/yu-?ris/i, 'YU-RIS'],
  [/catsystem/i, 'CatSystem2'],
  [/artemis/i, 'Artemis']
];

function detectEngineFromExeMetadata(exePath) {
  const description = getFileDescription(exePath);
  if (!description) return null;
  for (const [pattern, engine] of DESCRIPTION_ENGINE_PATTERNS) {
    if (pattern.test(description)) return engine;
  }
  return null;
}

module.exports = {
  PRODUCT_CODE_PATTERN,
  FANZA_CODE_PATTERN,
  isFanzaCode,
  extractProductCode,
  isExcludedName,
  findExecutablesInDir,
  listSubdirectories,
  pickPrimaryExecutable,
  resolveGameFoldersFromDirectory,
  resolveGameFromExecutable,
  detectEngine
};
