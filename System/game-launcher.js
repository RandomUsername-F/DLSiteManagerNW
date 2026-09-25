// system/game-launcher.js
// Resolves what actually gets launched for a game and launches it,
// applying the launcher/launch-parameters override rules:
// - launcher.enabled && launcher.value is non-empty && points to a real
//   file -> launch that instead of the game's own exe (record.path).
// - launchParameters.enabled && value is non-empty -> passed as args to
//   whichever of the above actually gets launched.
// Pure Node (fs/path/child_process) - no DOM, so no dom-bridge needed.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function resolveLaunchTarget(record) {
  const launcher = record.launcher || {};
  const launcherPath = (launcher.value || '').trim();
  const useLauncher = !!(launcher.enabled && launcherPath && fs.existsSync(launcherPath));

  const exePath = useLauncher ? launcherPath : record.path;

  let args = [];
  const params = record.launchParameters || {};
  if (params.enabled && params.value && params.value.trim()) {
    args = tokenizeArgs(params.value.trim());
  }

  return { exePath, args, cwd: exePath ? path.dirname(exePath) : undefined };
}

/** Splits a command-line-style string into argv tokens, respecting "quoted substrings". */
function tokenizeArgs(str) {
  const matches = str.match(/[^\s"]+|"([^"]*)"/g) || [];
  return matches.map(m => m.replace(/^"|"$/g, ''));
}

/** Launches a game record. Throws if the resolved executable doesn't exist, rather than failing silently. */
function launchGame(record) {
  const { exePath, args, cwd } = resolveLaunchTarget(record);
  if (!exePath || !fs.existsSync(exePath)) {
    throw new Error(`Executable not found: ${exePath}`);
  }
  spawn(exePath, args, { cwd, detached: true, stdio: 'ignore' }).unref();
}

module.exports = { resolveLaunchTarget, launchGame, tokenizeArgs };
