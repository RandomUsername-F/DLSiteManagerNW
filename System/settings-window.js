// System/settings-window.js
// Settings modal, opened from the "Settings" menu-bar button. Ported from
// the old WinForms app's SettingsForm - but only the General and UI
// Settings tabs, as instructed. Translator, DLSite, and Performance are
// skipped entirely (this app doesn't do AGTH/ChiiTrans launching, live
// DLSite scraping, or the perf-tuning knobs those tabs controlled).
//
// SIMPLIFICATIONS / NOT-YET-LIVE, flagged rather than silent:
// - "Desktop resolution while running games" is a preset dropdown; nothing
//   actually changes the display resolution yet - that was a native
//   Windows API call (ChangeDisplaySettings) the old app made, which this
//   app doesn't do.
// - "List font" is a plain family-name + size pair, not a true native
//   font-chooser dialog - the web platform doesn't expose one the way
//   WinForms' FontDialog did.
// - Several UI Settings (rating-as-image, row height, image sizes, word
//   wrap, tile font) don't yet have a visible effect on the table, since
//   the table/tile rendering hasn't been built to read them yet. They
//   still load/save correctly for when that catches up.
//
// openSettingsWindow({ getSettings, saveSettings, browseFolder })
//   getSettings()          -> Promise<Settings|undefined>
//   saveSettings(settings) -> Promise
//   browseFolder()         -> Promise<string|null>  (native folder picker)
// Resolves to { cancelled: true } or { cancelled: false, settings }.

const DEFAULT_SETTINGS = {
  general: {
    gameFolder: '',
    moveGamesOption: 'ask',       // 'always' | 'never' | 'ask'
    postExtractionAction: 'ask',  // 'delete' | 'rename' | 'ask' | 'nothing'
    resolution: 'none',           // 'none' | 'ask' | '<width>x<height>'
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
  }
};

const RESOLUTION_PRESETS = ['1920x1080', '1600x900', '1366x768', '1280x720', '1024x768'];

function openSettingsWindow({ getSettings, saveSettings, browseFolder }) {
  return new Promise((resolve) => {
    build().catch((err) => {
      console.error('Failed to open settings window:', err);
      resolve({ cancelled: true, error: err });
    });

    async function build() {
      const current = mergeDefaults(await getSettings());

      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';

      const box = document.createElement('div');
      box.className = 'settings-box';
      box.innerHTML = buildMarkup(current);
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
    ui: Object.assign({}, DEFAULT_SETTINGS.ui, saved && saved.ui)
  };
}

function buildMarkup(s) {
  const resolutionOptions = ['none', 'ask', ...RESOLUTION_PRESETS].map(value => {
    const label = value === 'none' ? "Don't change" : value === 'ask' ? 'Ask each time' : value;
    const selected = s.general.resolution === value ? ' selected' : '';
    return `<option value="${value}"${selected}>${label}</option>`;
  }).join('');

  return `
    <h2 class="settings-title">Settings</h2>
    <nav class="settings-tabs">
      <button type="button" class="settings-tab is-active" data-tab="general">General</button>
      <button type="button" class="settings-tab" data-tab="ui">UI Settings</button>
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
          <legend>Desktop resolution while running games</legend>
          <select id="settings-resolution" class="settings-input">${resolutionOptions}</select>
        </fieldset>

        <fieldset class="settings-group">
          <legend>After successfully extracting a CG archive</legend>
          <label class="settings-radio"><input type="radio" name="settings-extract" value="delete" ${s.general.postExtractionAction === 'delete' ? 'checked' : ''}> Delete archive</label>
          <label class="settings-radio"><input type="radio" name="settings-extract" value="nothing" ${s.general.postExtractionAction === 'nothing' ? 'checked' : ''}> Neither</label>
          <label class="settings-radio"><input type="radio" name="settings-extract" value="ask" ${s.general.postExtractionAction === 'ask' ? 'checked' : ''}> Ask</label>
          <label class="settings-radio"><input type="radio" name="settings-extract" value="rename" ${s.general.postExtractionAction === 'rename' ? 'checked' : ''}> Rename archive</label>
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
  box.querySelector('#settings-resolution').value = s.general.resolution;
  box.querySelector(`input[name="settings-extract"][value="${s.general.postExtractionAction}"]`).checked = true;
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
      postExtractionAction: box.querySelector('input[name="settings-extract"]:checked').value,
      resolution: box.querySelector('#settings-resolution').value,
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
    }
  };
}

function escapeAttr(str) {
  return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

module.exports = { openSettingsWindow, DEFAULT_SETTINGS };
