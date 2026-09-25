// system/translator.js
// Scans settings/translator/ for translator scripts and dispatches
// translation requests to whichever one is selected in Settings. Each
// script in that folder must export:
//   async function translate(text, fromLang, toLang) -> Promise<string>
// This is deliberately how a user can plug in their own script to connect
// a different translation engine without touching the app itself.

const fs = require('fs');
const path = require('path');

const TRANSLATOR_DIR = path.join(__dirname, '..', 'settings', 'translator');

/** Lists available translator engine names (script filenames without .js), for the settings dropdown. */
function listTranslatorEngines() {
  try {
    return fs.readdirSync(TRANSLATOR_DIR)
      .filter(name => name.toLowerCase().endsWith('.js'))
      .map(name => name.replace(/\.js$/i, ''));
  } catch (e) {
    return [];
  }
}

/**
 * Throws if the named engine script doesn't exist or doesn't export a
 * usable translate() function, rather than silently swallowing a
 * translation failure.
 */
async function translate(engineName, text, fromLang, toLang) {
  const scriptPath = path.join(TRANSLATOR_DIR, engineName + '.js');
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Translator engine "${engineName}" not found at ${scriptPath}`);
  }

  delete require.cache[require.resolve(scriptPath)]; // pick up edits to a user's script without an app restart
  const engine = require(scriptPath);
  if (typeof engine.translate !== 'function') {
    throw new Error(`Translator engine "${engineName}" does not export a translate() function`);
  }

  return engine.translate(text, fromLang, toLang);
}

module.exports = { listTranslatorEngines, translate, TRANSLATOR_DIR };
