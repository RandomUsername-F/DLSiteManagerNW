// system/game-launcher.js
// Resolves what actually gets launched for a game and launches it,
// applying the launcher/launch-parameters override rules:
// - launcher.enabled && launcher.value is non-empty -> launch that instead
//   of the game's own exe (record.path). The value may be absolute or
//   relative ("./Launcher.exe", "tools\\run.exe" - resolved against the
//   folder containing the game's exe, not the app's working directory),
//   may be wrapped in quotes (as pasted by Explorer's "Copy as path"), and
//   may contain %ENVIRONMENT% variables. If it's enabled but the file
//   doesn't exist, launching FAILS with an error naming the resolved path
//   instead of quietly starting the game's own exe.
// - launchParameters.enabled && value is non-empty -> passed as args to
//   whichever of the above actually gets launched.
// Pure Node (fs/path/child_process) - no DOM, so no dom-bridge needed.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/** Trims, strips wrapping quotes and expands %VAR% - for user-typed/pasted paths. */
function normalizePathInput(value) {
  let p = String(value == null ? '' : value).trim();
  p = p.replace(/^["']+|["']+$/g, '').trim();
  p = p.replace(/%([^%]+)%/g, (match, name) => (process.env[name] !== undefined ? process.env[name] : match));
  return p;
}

function resolveLaunchTarget(record) {
  const launcher = record.launcher || {};
  const wanted = launcher.enabled ? normalizePathInput(launcher.value) : '';

  let exePath = record.path;
  if (wanted) {
    const gameDir = path.dirname(record.path || '');
    let resolved;
    if (/^[\\/](?![\\/])/.test(wanted)) {
      // "\Game\Binaries\x.exe": a leading slash with no drive means "inside the
      // game's folder" here (Windows itself would read it as the root of the
      // current drive, which is never what's meant).
      resolved = path.join(gameDir, wanted.replace(/^[\\/]+/, ''));
    } else if (path.isAbsolute(wanted)) {
      resolved = wanted;
    } else {
      resolved = path.resolve(gameDir, wanted);
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(`Launcher not found: ${resolved}`);
    }
    exePath = resolved;
  }

  let args = [];
  const params = record.launchParameters || {};
  if (params.enabled && params.value && params.value.trim()) {
    args = tokenizeArgs(params.value.trim());
  }

  // .bat/.cmd can't be spawned directly on Windows - they need a shell.
  const needsShell = !!exePath && /\.(bat|cmd)$/i.test(exePath);

  return { exePath, args, cwd: exePath ? path.dirname(exePath) : undefined, needsShell };
}

/** Splits a command-line-style string into argv tokens, respecting "quoted substrings". */
function tokenizeArgs(str) {
  const matches = str.match(/[^\s"]+|"([^"]*)"/g) || [];
  return matches.map(m => m.replace(/^"|"$/g, ''));
}

/**
 * Launches a game record. Resolves once the process has actually started;
 * rejects (or throws, for a missing file) with a descriptive error - e.g. a
 * missing launcher/exe, or a program that can't be started from here (such
 * as one that requires administrator elevation).
 */
function launchGame(record) {
  let target;
  try {
    target = resolveLaunchTarget(record);
  } catch (e) {
    return Promise.reject(e);
  }

  const { exePath, args, cwd, needsShell } = target;
  if (!exePath || !fs.existsSync(exePath)) {
    return Promise.reject(new Error(`Executable not found: ${exePath}`));
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      console.log('Launching:', exePath, args, 'cwd:', cwd);
      child = needsShell
        ? spawn(`"${exePath}"`, args.map(a => `"${a}"`), { cwd, detached: true, stdio: 'ignore', shell: true })
        : spawn(exePath, args, { cwd, detached: true, stdio: 'ignore' });
    } catch (e) {
      reject(e);
      return;
    }
    child.once('error', reject);
    // A started process has a pid straight away; if the OS refused to start
    // it there is none and an 'error' event follows instead.
    if (child.pid) {
      child.unref();
      resolve();
    }
  });
}

module.exports = { resolveLaunchTarget, launchGame, tokenizeArgs };
