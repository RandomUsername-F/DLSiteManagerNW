// system/settings-window.js
// Settings modal, opened from the "Settings" menu-bar button.
//
// The exclusion list is read by system/library-import.js when scanning
// for game folders/executables (Action menu, drag-drop); it has no
// effect anywhere else yet.
//
// openSettingsWindow({ getSettings, saveSettings, browseFolder, listTranslatorEngines,
//                       listUiStyles, getTagReplacements, saveTagReplacements })
//   getSettings()            -> Promise<Settings|undefined>
//   saveSettings(settings)   -> Promise
//   browseFolder()           -> Promise<string|null>  (native folder picker)
//   listTranslatorEngines()  -> string[] (script names found in system/translator/)
//   listUiStyles()           -> { value, label }[]  (.css files in system/styles/)
//   getTagReplacements()     -> { find, replace }[]  (Database/replacementTags.json)
//   saveTagReplacements(rows)
// Tabs: General / Translation / Custom. Resolves to { cancelled: true } or
// { cancelled: false, settings }.

// See system/dom-bridge.js: bare `document` isn't reliable inside a
// require()'d module on this NW.js build, so every DOM-touching file gets
// it explicitly instead. This `const` shadows the unreliable global for
// the rest of this file.
const document = require('./dom-bridge.js').getDocument();
const appWindow = require('./dom-bridge.js').getWindow();
const { DEFAULT_EXCLUSION_LIST } = require('./library-import.js');

const DEFAULT_SETTINGS = {
  general: {
    gameFolder: '',
    exclusionList: DEFAULT_EXCLUSION_LIST,
    renameTemplate: '{rjcode} [{circle}] {title}'
  },
  // No longer editable: the "UI Settings" tab was removed. Kept so existing
  // stored values (and defaults for anything that reads them) stay intact.
  ui: {
    doubleClickToRun: true,
    useCoverImageAsListImage: false,
    ratingAsImage: true,
    wordWrapRowText: false,
    rowHeight: 28,
    listImageWidth: 60,
    listImageHeight: 60,
    tileImageWidth: 160,
    tileImageHeight: 120,
    thumbnailWidth: 28,
    thumbnailHeight: 28,
    applyListFontToTiles: false,
    listFontFamily: 'Segoe UI',
    listFontSize: 12
  },
  translation: {
    parserLocale: 'en_US',        // sets process.env.DLSITE_LOCALE
    translateFrom: 'ja',
    translateTo: 'en',
    translatorEngine: 'googleTranslator'
  },
  custom: {
    theme: 'dark',                // 'dark' | file name in system/styles/ (e.g. 'lightTheme.css')
    tagReplacementAuto: false     // run tag replacement on every game save (rules: Database/replacementTags.json)
  }
};

const PARSER_LOCALE_PRESETS = [
  { value: 'en_US', label: 'English' },
  { value: 'ja_JP', label: 'Japanese' },
  { value: 'zh_CN', label: 'Chinese (Simplified)' },
  { value: 'ko_KR', label: 'Korean' }
];

const LANGUAGE_OPTIONS = [
  { value: 'ja', label: 'Japanese' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ko', label: 'Korean' }
];

function openSettingsWindow({ getSettings, saveSettings, browseFolder, listTranslatorEngines, listUiStyles, getTagReplacements, saveTagReplacements }) {
  return new Promise((resolve) => {
    build().catch((err) => {
      console.error('Failed to open settings window:', err);
      resolve({ cancelled: true, error: err });
    });

    async function build() {
      const current = mergeDefaults(await getSettings());
      const engines = listTranslatorEngines ? listTranslatorEngines() : [];
      const styles = listUiStyles ? listUiStyles() : [];
      const tagRules = getTagReplacements ? getTagReplacements() : [];

      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';

      const box = document.createElement('div');
      box.className = 'settings-box';
      box.innerHTML = buildMarkup(current, engines, styles, tagRules);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      // Anchor the box's top-left corner to a fixed point, computed once
      // from the current app window size, rather than letting the
      // overlay's flex-centering re-center it every time a tab switch
      // changes the box's height - position:fixed here takes it out of
      // that centering entirely, so only its height changes afterward,
      // never its top-left corner.
      const boxRect = box.getBoundingClientRect();
      const left = Math.max(8, Math.round((appWindow.innerWidth - boxRect.width) / 2));
      const top = Math.max(8, Math.round((appWindow.innerHeight - boxRect.height) / 2));
      box.style.position = 'fixed';
      box.style.left = left + 'px';
      box.style.top = top + 'px';
      box.style.margin = '0';

      const tabButtons = box.querySelectorAll('.settings-tab');
      const tabPanes = box.querySelectorAll('.settings-tab-pane');
      tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
          tabButtons.forEach(b => b.classList.toggle('is-active', b === btn));
          tabPanes.forEach(p => p.classList.toggle('is-active', p.dataset.tab === btn.dataset.tab));
        });
      });

      box.querySelector('#settings-browse-folder').addEventListener('click', async () => {
        const folder = browseFolder ? await browseFolder() : null;
        if (folder) box.querySelector('#settings-game-folder').value = folder;
      });

      // Language combos (parser language, translate from/to): picking a
      // preset fills the paired text input, which stays the actual saved
      // value - typing a custom value directly always works too.
      box.querySelector('#settings-locale-preset').addEventListener('change', (e) => {
        if (e.target.value) box.querySelector('#settings-locale-input').value = e.target.value;
      });
      box.querySelector('#settings-translate-from-preset').addEventListener('change', (e) => {
        if (e.target.value) box.querySelector('#settings-translate-from').value = e.target.value;
      });
      box.querySelector('#settings-translate-to-preset').addEventListener('change', (e) => {
        if (e.target.value) box.querySelector('#settings-translate-to').value = e.target.value;
      });

      // Tags replacement table: keep one blank row at the bottom.
      const tagBody = box.querySelector('#settings-tagrep-body');
      tagBody.addEventListener('input', () => {
        const rows = tagBody.querySelectorAll('tr');
        const lastFind = rows[rows.length - 1].querySelector('.tagrep-find').value.trim();
        if (lastFind !== '') tagBody.insertAdjacentHTML('beforeend', tagRuleRowMarkup('', ''));
      });

      function close(result) {
        overlay.remove();
        resolve(result);
      }

      box.querySelector('#settings-cancel-btn').addEventListener('click', () => close({ cancelled: true }));
      overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) close({ cancelled: true });
      });

      box.querySelector('#settings-ok-btn').addEventListener('click', async () => {
        const updated = readValues(box, current);
        if (saveTagReplacements) saveTagReplacements(readTagRules(box));
        await saveSettings(updated);
        close({ cancelled: false, settings: updated });
      });
    }
  });
}

function mergeDefaults(saved) {
  return {
    general: Object.assign({}, DEFAULT_SETTINGS.general, saved && saved.general),
    ui: Object.assign({}, DEFAULT_SETTINGS.ui, saved && saved.ui),
    translation: Object.assign({}, DEFAULT_SETTINGS.translation, saved && saved.translation),
    custom: Object.assign({}, DEFAULT_SETTINGS.custom, saved && saved.custom)
  };
}

function tagRuleRowMarkup(find, replace) {
  return `<tr><td><input type="text" class="tagrep-find" value="${escapeAttr(find)}"></td>` +
    `<td><input type="text" class="tagrep-replace" value="${escapeAttr(replace)}"></td></tr>`;
}

function readTagRules(box) {
  return Array.from(box.querySelectorAll('#settings-tagrep-body tr'))
    .map(tr => ({
      find: tr.querySelector('.tagrep-find').value.trim(),
      replace: tr.querySelector('.tagrep-replace').value.trim()
    }))
    .filter(r => r.find !== '');
}

function buildMarkup(s, engines, styles, tagRules) {
  const tagRuleRows = [...(tagRules || []), { find: '', replace: '' }]
    .map(r => tagRuleRowMarkup(r.find, r.replace)).join('');

  const savedTheme = s.custom.theme === 'light' ? 'lightTheme.css' : s.custom.theme;
  const styleOptions = [{ value: 'dark', label: 'Dark (default)' }, ...styles].map(st =>
    `<option value="${escapeAttr(st.value)}"${savedTheme === st.value ? ' selected' : ''}>${escapeHtml(st.label)}</option>`
  ).join('');

  const localePresetOptions = ['', ...PARSER_LOCALE_PRESETS.map(p => p.value)].map(value => {
    const preset = PARSER_LOCALE_PRESETS.find(p => p.value === value);
    const label = preset ? preset.label : 'Choose a preset\u2026';
    return `<option value="${value}">${label}</option>`;
  }).join('');

  const fromOptions = ['', ...LANGUAGE_OPTIONS.map(o => o.value)].map(value => {
    const opt = LANGUAGE_OPTIONS.find(o => o.value === value);
    const label = opt ? opt.label : 'Choose a preset…';
    return `<option value="${value}">${label}</option>`;
  }).join('');
  const toOptions = fromOptions;

  const engineOptions = engines.length
    ? engines.map(name => `<option value="${escapeAttr(name)}"${s.translation.translatorEngine === name ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('')
    : '<option value="">No scripts found in system/translator/</option>';

  return `
    <h2 class="settings-title">Settings</h2>
    <nav class="settings-tabs">
      <button type="button" class="settings-tab is-active" data-tab="general">General</button>
      <button type="button" class="settings-tab" data-tab="translation">Translation</button>
      <button type="button" class="settings-tab" data-tab="custom">Custom</button>
    </nav>

    <div class="settings-body">
      <div class="settings-tab-pane is-active" data-tab="general">
        <fieldset class="settings-group">
          <legend>Main folder</legend>
          <div class="settings-row">
            <input type="text" id="settings-game-folder" class="settings-input" value="${escapeAttr(s.general.gameFolder)}" placeholder="Not set">
            <button type="button" class="btn" id="settings-browse-folder">Browse</button>
          </div>
        </fieldset>

        <fieldset class="settings-group">
          <legend>Exclusion list</legend>
          <p class="settings-hint">File/folder names to skip when scanning for game executables (e.g. installers, uninstallers, crash handlers). Pipe-separated.</p>
          <textarea id="settings-exclusion-list" class="settings-input" rows="3">${escapeHtml(s.general.exclusionList)}</textarea>
        </fieldset>

        <fieldset class="settings-group">
          <legend>Renaming template</legend>
          <input type="text" id="settings-rename-template" class="settings-input" value="${escapeAttr(s.general.renameTemplate)}">
          <p class="settings-hint">Valid tags: {rjcode}, {circle}, {cvs}, {title}, {category}, {foldername}. Must contain at least {rjcode} or {foldername}.</p>
          <p class="settings-hint">Use \\ to organize in folders (relative to Main Folder)</p>
        </fieldset>
      </div>

      <div class="settings-tab-pane" data-tab="translation">
        <fieldset class="settings-group">
          <legend>Parser language</legend>
          <p class="settings-hint">Sets DLSITE_LOCALE, If game page has selected languages version info will be fetched with this language, otherwise it only affects elements like tags.</p>
          <div class="settings-row">
            <select id="settings-locale-preset" class="settings-input">${localePresetOptions}</select>
            <input type="text" id="settings-locale-input" class="settings-input" value="${escapeAttr(s.translation.parserLocale)}">
          </div>
        </fieldset>

        <fieldset class="settings-group">
          <legend>Translator</legend>
          <div class="settings-row">
            <label class="settings-inline-select">From
              <div class="settings-row">
                <select id="settings-translate-from-preset" class="settings-input">${fromOptions}</select>
                <input type="text" id="settings-translate-from" class="settings-input" value="${escapeAttr(s.translation.translateFrom)}">
              </div>
            </label>
            <label class="settings-inline-select">To
              <div class="settings-row">
                <select id="settings-translate-to-preset" class="settings-input">${toOptions}</select>
                <input type="text" id="settings-translate-to" class="settings-input" value="${escapeAttr(s.translation.translateTo)}">
              </div>
            </label>
          </div>
          <label class="settings-inline-select settings-engine-select">Engine
            <select id="settings-translator-engine" class="settings-input">${engineOptions}</select>
          </label>
          <p class="settings-hint">Engines are scripts found in system/translator/ - drop in your own (exporting an async translate(text, fromLang, toLang) function) to use a different translation service.</p>
        </fieldset>
      </div>

      <div class="settings-tab-pane" data-tab="custom">
        <fieldset class="settings-group">
          <legend>UI Style</legend>
          <select id="settings-ui-style" class="settings-input">${styleOptions}</select>
        </fieldset>

        <fieldset class="settings-group">
          <legend>Tags replacement</legend>
          <label class="settings-checkbox"><input type="checkbox" id="settings-tagrep-auto" ${s.custom.tagReplacementAuto ? 'checked' : ''}> Auto</label>
          <p class="settings-hint">If active, applied whenever a game's info is saved. Manually activated through Utility/Replace Tags. Leave the right side empty to remove a tag; separate several replacements with commas.</p>
          <div class="tagrep-scroll">
            <table class="tagrep-table">
              <thead><tr><th>Find tag</th><th>Replace with</th></tr></thead>
              <tbody id="settings-tagrep-body">${tagRuleRows}</tbody>
            </table>
          </div>
        </fieldset>
      </div>
    </div>

    <div class="confirm-buttons settings-buttons">
      <button type="button" class="btn" id="settings-cancel-btn">Cancel</button>
      <button type="button" class="btn btn--primary" id="settings-ok-btn">OK</button>
    </div>
  `;
}

function readValues(box, current) {
  return {
    general: {
      gameFolder: box.querySelector('#settings-game-folder').value,
      exclusionList: box.querySelector('#settings-exclusion-list').value,
      renameTemplate: box.querySelector('#settings-rename-template').value
    },
    ui: Object.assign({}, current.ui), // UI Settings tab removed; keep stored values untouched
    translation: {
      parserLocale: box.querySelector('#settings-locale-input').value.trim() || DEFAULT_SETTINGS.translation.parserLocale,
      translateFrom: box.querySelector('#settings-translate-from').value.trim() || DEFAULT_SETTINGS.translation.translateFrom,
      translateTo: box.querySelector('#settings-translate-to').value.trim() || DEFAULT_SETTINGS.translation.translateTo,
      translatorEngine: box.querySelector('#settings-translator-engine').value || DEFAULT_SETTINGS.translation.translatorEngine
    },
    custom: {
      theme: box.querySelector('#settings-ui-style').value || 'dark',
      tagReplacementAuto: box.querySelector('#settings-tagrep-auto').checked
    }
  };
}

function escapeAttr(str) {
  return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { openSettingsWindow, DEFAULT_SETTINGS };
