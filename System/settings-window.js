// system/settings-window.js
// Settings modal, opened from the "Settings" menu-bar button. General and
// UI Settings tabs are ported from the old WinForms app (Translator,
// DLSite, Performance skipped - not applicable here). Translation and
// Custom are new.
//
// SIMPLIFICATIONS / NOT-YET-LIVE, flagged rather than silent:
// - "List font" is a plain family-name + size pair, not a true native
//   font-chooser dialog - the web platform doesn't expose one the way
//   WinForms' FontDialog did.
// - Several UI Settings (rating-as-image, row height, image sizes, word
//   wrap, tile font) don't yet have a visible effect on the table, since
//   the table/tile rendering hasn't been built to read them yet. They
//   still load/save correctly for when that catches up.
// - The exclusion list is read by system/library-import.js when scanning
//   for game folders/executables (Action menu, drag-drop); it has no
//   effect anywhere else yet.
//
// openSettingsWindow({ getSettings, saveSettings, browseFolder, listTranslatorEngines })
//   getSettings()            -> Promise<Settings|undefined>
//   saveSettings(settings)   -> Promise
//   browseFolder()           -> Promise<string|null>  (native folder picker)
//   listTranslatorEngines()  -> string[] (script names found in settings/translator/)
// Resolves to { cancelled: true } or { cancelled: false, settings }.

// See system/dom-bridge.js: bare `document` isn't reliable inside a
// require()'d module on this NW.js build, so every DOM-touching file gets
// it explicitly instead. This `const` shadows the unreliable global for
// the rest of this file.
const document = require('./dom-bridge.js').getDocument();
const { DEFAULT_EXCLUSION_LIST } = require('./library-import.js');

const DEFAULT_SETTINGS = {
  general: {
    gameFolder: '',
    moveGamesOption: 'ask',       // 'always' | 'never' | 'ask'
    exclusionList: DEFAULT_EXCLUSION_LIST,
    renameTemplate: '{rjcode} [{circle}] {title}',
    renameOrganize: false
  },
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
    theme: 'dark'                 // 'dark' | 'light'
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

function openSettingsWindow({ getSettings, saveSettings, browseFolder, listTranslatorEngines }) {
  return new Promise((resolve) => {
    build().catch((err) => {
      console.error('Failed to open settings window:', err);
      resolve({ cancelled: true, error: err });
    });

    async function build() {
      const current = mergeDefaults(await getSettings());
      const engines = listTranslatorEngines ? listTranslatorEngines() : [];

      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';

      const box = document.createElement('div');
      box.className = 'settings-box';
      box.innerHTML = buildMarkup(current, engines);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

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

      box.querySelector('#settings-restore-defaults').addEventListener('click', () => {
        applyValues(box, { general: current.general, ui: DEFAULT_SETTINGS.ui });
      });

      // Parser language combo: picking a preset fills the text input,
      // which remains the actual editable/stored value (the combo is
      // just a convenience-filler, per spec - typing a custom value
      // directly into the input always works too).
      box.querySelector('#settings-locale-preset').addEventListener('change', (e) => {
        if (e.target.value) box.querySelector('#settings-locale-input').value = e.target.value;
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
        const updated = readValues(box);
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

function buildMarkup(s, engines) {
  const localePresetOptions = ['', ...PARSER_LOCALE_PRESETS.map(p => p.value)].map(value => {
    const preset = PARSER_LOCALE_PRESETS.find(p => p.value === value);
    const label = preset ? preset.label : 'Choose a preset\u2026';
    return `<option value="${value}">${label}</option>`;
  }).join('');

  const fromOptions = LANGUAGE_OPTIONS.map(o =>
    `<option value="${o.value}"${s.translation.translateFrom === o.value ? ' selected' : ''}>${o.label}</option>`
  ).join('');
  const toOptions = LANGUAGE_OPTIONS.map(o =>
    `<option value="${o.value}"${s.translation.translateTo === o.value ? ' selected' : ''}>${o.label}</option>`
  ).join('');

  const engineOptions = engines.length
    ? engines.map(name => `<option value="${escapeAttr(name)}"${s.translation.translatorEngine === name ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('')
    : '<option value="">No scripts found in settings/translator/</option>';

  return `
    <h2 class="settings-title">Settings</h2>
    <nav class="settings-tabs">
      <button type="button" class="settings-tab is-active" data-tab="general">General</button>
      <button type="button" class="settings-tab" data-tab="ui">UI Settings</button>
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
          <fieldset class="settings-subgroup">
            <legend>Move new works to the main folder</legend>
            <label class="settings-radio"><input type="radio" name="settings-move" value="always" ${s.general.moveGamesOption === 'always' ? 'checked' : ''}> Always move</label>
            <label class="settings-radio"><input type="radio" name="settings-move" value="never" ${s.general.moveGamesOption === 'never' ? 'checked' : ''}> Never move</label>
            <label class="settings-radio"><input type="radio" name="settings-move" value="ask" ${s.general.moveGamesOption === 'ask' ? 'checked' : ''}> Ask</label>
          </fieldset>
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
          <label class="settings-checkbox"><input type="checkbox" id="settings-rename-organize" ${s.general.renameOrganize ? 'checked' : ''}> Use \\ to organize in folders (relative to Main Folder)</label>
        </fieldset>
      </div>

      <div class="settings-tab-pane" data-tab="ui">
        <label class="settings-checkbox"><input type="checkbox" id="settings-doubleclick" ${s.ui.doubleClickToRun ? 'checked' : ''}> Double clicking a work will run or open it</label>
        <label class="settings-checkbox"><input type="checkbox" id="settings-cover-as-list" ${s.ui.useCoverImageAsListImage ? 'checked' : ''}> Display cover images instead of list images next to works</label>
        <label class="settings-checkbox"><input type="checkbox" id="settings-rating-as-image" ${s.ui.ratingAsImage ? 'checked' : ''}> View work's rating as images</label>
        <label class="settings-checkbox"><input type="checkbox" id="settings-wordwrap" ${s.ui.wordWrapRowText ? 'checked' : ''}> Word wrap row text</label>

        <div class="settings-row">
          <fieldset class="settings-subgroup settings-size-group">
            <legend>List image size</legend>
            <label>Width: <input type="number" id="settings-list-w" min="1" max="999" value="${s.ui.listImageWidth}"></label>
            <label>Height: <input type="number" id="settings-list-h" min="1" max="999" value="${s.ui.listImageHeight}"></label>
          </fieldset>
          <fieldset class="settings-subgroup settings-size-group">
            <legend>Tile image size</legend>
            <label>Width: <input type="number" id="settings-tile-w" min="1" max="999" value="${s.ui.tileImageWidth}"></label>
            <label>Height: <input type="number" id="settings-tile-h" min="1" max="999" value="${s.ui.tileImageHeight}"></label>
          </fieldset>
        </div>
        <div class="settings-row">
          <fieldset class="settings-subgroup settings-size-group">
            <legend>Thumbnail size</legend>
            <label>Width: <input type="number" id="settings-thumb-w" min="1" max="999" value="${s.ui.thumbnailWidth}"></label>
            <label>Height: <input type="number" id="settings-thumb-h" min="1" max="999" value="${s.ui.thumbnailHeight}"></label>
          </fieldset>
          <label class="settings-inline-number">Row height:<input type="number" id="settings-row-height" min="20" max="255" value="${s.ui.rowHeight}"></label>
        </div>

        <fieldset class="settings-group">
          <legend>List font</legend>
          <div class="settings-row">
            <input type="text" id="settings-font-family" class="settings-input" value="${escapeAttr(s.ui.listFontFamily)}" placeholder="Font family">
            <input type="number" id="settings-font-size" min="6" max="72" value="${s.ui.listFontSize}" class="settings-font-size">
          </div>
          <label class="settings-checkbox"><input type="checkbox" id="settings-apply-font-tiles" ${s.ui.applyListFontToTiles ? 'checked' : ''}> Apply list font to tiles</label>
        </fieldset>

        <button type="button" class="btn" id="settings-restore-defaults">Restore defaults</button>
      </div>

      <div class="settings-tab-pane" data-tab="translation">
        <fieldset class="settings-group">
          <legend>Parser language</legend>
          <p class="settings-hint">Sets DLSITE_LOCALE, which the parser sends as the site's display language (affects text on the fetched page, not what's actually being scraped).</p>
          <div class="settings-row">
            <select id="settings-locale-preset" class="settings-input">${localePresetOptions}</select>
            <input type="text" id="settings-locale-input" class="settings-input" value="${escapeAttr(s.translation.parserLocale)}">
          </div>
        </fieldset>

        <fieldset class="settings-group">
          <legend>Translator</legend>
          <div class="settings-row">
            <label class="settings-inline-select">From
              <select id="settings-translate-from" class="settings-input">${fromOptions}</select>
            </label>
            <label class="settings-inline-select">To
              <select id="settings-translate-to" class="settings-input">${toOptions}</select>
            </label>
          </div>
          <label class="settings-inline-select settings-engine-select">Engine
            <select id="settings-translator-engine" class="settings-input">${engineOptions}</select>
          </label>
          <p class="settings-hint">Engines are scripts found in settings/translator/ - drop in your own (exporting an async translate(text, fromLang, toLang) function) to use a different translation service.</p>
        </fieldset>
      </div>

      <div class="settings-tab-pane" data-tab="custom">
        <fieldset class="settings-group">
          <legend>Theme</legend>
          <label class="settings-radio"><input type="radio" name="settings-theme" value="dark" ${s.custom.theme === 'dark' ? 'checked' : ''}> Dark (default)</label>
          <label class="settings-radio"><input type="radio" name="settings-theme" value="light" ${s.custom.theme === 'light' ? 'checked' : ''}> Light</label>
        </fieldset>
      </div>
    </div>

    <div class="confirm-buttons settings-buttons">
      <button type="button" class="btn" id="settings-cancel-btn">Cancel</button>
      <button type="button" class="btn btn--primary" id="settings-ok-btn">OK</button>
    </div>
  `;
}

function applyValues(box, s) {
  box.querySelector('#settings-game-folder').value = s.general.gameFolder;
  box.querySelector(`input[name="settings-move"][value="${s.general.moveGamesOption}"]`).checked = true;
  box.querySelector('#settings-exclusion-list').value = s.general.exclusionList;
  box.querySelector('#settings-rename-template').value = s.general.renameTemplate;
  box.querySelector('#settings-rename-organize').checked = s.general.renameOrganize;

  box.querySelector('#settings-doubleclick').checked = s.ui.doubleClickToRun;
  box.querySelector('#settings-cover-as-list').checked = s.ui.useCoverImageAsListImage;
  box.querySelector('#settings-rating-as-image').checked = s.ui.ratingAsImage;
  box.querySelector('#settings-wordwrap').checked = s.ui.wordWrapRowText;
  box.querySelector('#settings-list-w').value = s.ui.listImageWidth;
  box.querySelector('#settings-list-h').value = s.ui.listImageHeight;
  box.querySelector('#settings-tile-w').value = s.ui.tileImageWidth;
  box.querySelector('#settings-tile-h').value = s.ui.tileImageHeight;
  box.querySelector('#settings-thumb-w').value = s.ui.thumbnailWidth;
  box.querySelector('#settings-thumb-h').value = s.ui.thumbnailHeight;
  box.querySelector('#settings-row-height').value = s.ui.rowHeight;
  box.querySelector('#settings-font-family').value = s.ui.listFontFamily;
  box.querySelector('#settings-font-size').value = s.ui.listFontSize;
  box.querySelector('#settings-apply-font-tiles').checked = s.ui.applyListFontToTiles;
}

function readValues(box) {
  return {
    general: {
      gameFolder: box.querySelector('#settings-game-folder').value,
      moveGamesOption: box.querySelector('input[name="settings-move"]:checked').value,
      exclusionList: box.querySelector('#settings-exclusion-list').value,
      renameTemplate: box.querySelector('#settings-rename-template').value,
      renameOrganize: box.querySelector('#settings-rename-organize').checked
    },
    ui: {
      doubleClickToRun: box.querySelector('#settings-doubleclick').checked,
      useCoverImageAsListImage: box.querySelector('#settings-cover-as-list').checked,
      ratingAsImage: box.querySelector('#settings-rating-as-image').checked,
      wordWrapRowText: box.querySelector('#settings-wordwrap').checked,
      rowHeight: Number(box.querySelector('#settings-row-height').value) || DEFAULT_SETTINGS.ui.rowHeight,
      listImageWidth: Number(box.querySelector('#settings-list-w').value) || DEFAULT_SETTINGS.ui.listImageWidth,
      listImageHeight: Number(box.querySelector('#settings-list-h').value) || DEFAULT_SETTINGS.ui.listImageHeight,
      tileImageWidth: Number(box.querySelector('#settings-tile-w').value) || DEFAULT_SETTINGS.ui.tileImageWidth,
      tileImageHeight: Number(box.querySelector('#settings-tile-h').value) || DEFAULT_SETTINGS.ui.tileImageHeight,
      thumbnailWidth: Number(box.querySelector('#settings-thumb-w').value) || DEFAULT_SETTINGS.ui.thumbnailWidth,
      thumbnailHeight: Number(box.querySelector('#settings-thumb-h').value) || DEFAULT_SETTINGS.ui.thumbnailHeight,
      applyListFontToTiles: box.querySelector('#settings-apply-font-tiles').checked,
      listFontFamily: box.querySelector('#settings-font-family').value || DEFAULT_SETTINGS.ui.listFontFamily,
      listFontSize: Number(box.querySelector('#settings-font-size').value) || DEFAULT_SETTINGS.ui.listFontSize
    },
    translation: {
      parserLocale: box.querySelector('#settings-locale-input').value.trim() || DEFAULT_SETTINGS.translation.parserLocale,
      translateFrom: box.querySelector('#settings-translate-from').value,
      translateTo: box.querySelector('#settings-translate-to').value,
      translatorEngine: box.querySelector('#settings-translator-engine').value || DEFAULT_SETTINGS.translation.translatorEngine
    },
    custom: {
      theme: box.querySelector('input[name="settings-theme"]:checked').value
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
