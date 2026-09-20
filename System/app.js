// System/app.js
// Single entry point, loaded via <script src="System/app.js" defer> in
// index.html. Everything else is require()'d as a plain CommonJS module.
//
// NOTE ON PATHS: require() calls made from a <script src> tag (as opposed
// to from within an already-required module) resolve relative to the main
// HTML document's folder (the app root), not relative to this script's own
// folder. requireModule() below tries the root-relative path first and
// falls back to a self-relative one, since this couldn't be verified by
// actually running NW.js - if you see a "module not found" error in
// devtools on first launch, that's what this guards against.
function requireModule(rootRelative, selfRelative) {
  try {
    return require(rootRelative);
  } catch (e) {
    return require(selfRelative);
  }
}

const { getAllGames, getGameRecord, updateGameOverride, updateGameFields, getAllCircles, saveCircle, deleteCircle, getSetting, setSetting } = requireModule('./System/db.js', './db.js');
const { GameTable } = requireModule('./System/table.js', './table.js');
const { EditPanel } = requireModule('./System/edit-panel.js', './edit-panel.js');
const { openSettingsWindow } = requireModule('./System/settings-window.js', './settings-window.js');

// The window is created hidden (package.json "window.show": false) so we
// can restore its saved position/size first and avoid a flash of the
// default size. win.show() MUST run no matter what else fails below, or
// the app would launch permanently invisible.
const win = nw.Window.get();

document.addEventListener('DOMContentLoaded', () => {
  restoreWindowBounds()
    .catch(err => console.error('Window bounds restore failed:', err))
    .finally(() => win.show());

  initSplitter().catch(err => console.error('Splitter init failed:', err));
  initTable().catch(err => console.error('Table init failed:', err));
  initSettingsMenu();
});

// ---------------------------------------------------------------
// Window size/position
// ---------------------------------------------------------------
async function restoreWindowBounds() {
  const bounds = await getSetting('ui.windowBounds', null);

  if (bounds) {
    win.moveTo(bounds.x, bounds.y);
    win.resizeTo(bounds.width, bounds.height);
  }

  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      setSetting('ui.windowBounds', {
        x: win.x, y: win.y, width: win.width, height: win.height
      });
    }, 400); // debounced so dragging/resizing doesn't hammer IndexedDB
  };

  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
}

// ---------------------------------------------------------------
// Splitter between the list panel and the edit panel
// ---------------------------------------------------------------
async function initSplitter() {
  const splitter = document.getElementById('panel-splitter');
  const editPanel = document.getElementById('edit-panel');
  const workspace = document.getElementById('workspace');

  const savedWidth = await getSetting('ui.editPanelWidth', 340);
  editPanel.style.flexBasis = savedWidth + 'px';

  let dragging = false;

  splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const workspaceRect = workspace.getBoundingClientRect();
    const minEditWidth = 240;
    const maxEditWidth = workspaceRect.width - 300; // leave room for the list panel
    let width = workspaceRect.right - e.clientX;
    width = Math.max(minEditWidth, Math.min(maxEditWidth, width));
    editPanel.style.flexBasis = width + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    setSetting('ui.editPanelWidth', editPanel.getBoundingClientRect().width);
  });
}

// ---------------------------------------------------------------
// Settings window (menu bar → Settings)
// ---------------------------------------------------------------
function initSettingsMenu() {
  const settingsBtn = document.getElementById('menu-settings-btn');
  if (!settingsBtn) return;

  settingsBtn.addEventListener('click', () => {
    openSettingsWindow({
      getSettings: () => getSetting('app', null),
      saveSettings: (settings) => setSetting('app', settings),
      browseFolder
    });
  });
}

/**
 * Native folder picker via NW.js's <input type="file" nwdirectory> trick -
 * there's no separate dialog API needed; a hidden file input with that
 * attribute opens the OS folder chooser and reports the chosen path back
 * through its normal 'change' event.
 */
function browseFolder() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('nwdirectory', '');
    input.style.display = 'none';
    document.body.appendChild(input);

    input.addEventListener('change', () => {
      resolve(input.value || null);
      input.remove();
    }, { once: true });

    // If the user cancels the dialog, no 'change' event fires; fall back
    // to resolving null once the window regains focus.
    window.addEventListener('focus', function onFocus() {
      window.removeEventListener('focus', onFocus);
      setTimeout(() => {
        if (document.body.contains(input)) {
          resolve(null);
          input.remove();
        }
      }, 300);
    }, { once: true });

    input.click();
  });
}

// ---------------------------------------------------------------
// Game table
// ---------------------------------------------------------------
let editPanel;

async function initTable() {
  const tableEl = document.getElementById('game-table');
  const statusEl = document.querySelector('#status-bar span');

  editPanel = new EditPanel({
    fetchRecord: getGameRecord,
    onApply: updateGameOverride,
    onUpdateLaunchSettings: updateGameFields,
    fetchCircles: getAllCircles,
    onSaveCircle: saveCircle,
    onDeleteCircle: deleteCircle
  });
  editPanel.show(null); // renders the empty/grayed field layout before anything is selected

  const table = new GameTable({
    container: tableEl,
    onColumnsChanged: (state) => setSetting('ui.columns', state),
    onSortChanged: (sort) => setSetting('ui.sort', sort),
    onRowSelected: async (game) => {
      const canLeave = await editPanel.requestLeave();
      if (!canLeave) return false;
      await editPanel.show(game.productCode);
      return true;
    }
  });

  const [savedColumns, savedSort] = await Promise.all([
    getSetting('ui.columns', null),
    getSetting('ui.sort', null)
  ]);

  table.applyColumnState(savedColumns);
  table.applySort(savedSort);

  const games = await getAllGames();
  table.render();
  table.setRows(games);

  if (statusEl) {
    statusEl.textContent = `${games.length} game${games.length === 1 ? '' : 's'} catalogued`;
  }
  // Empty state (no games yet) renders as a message row inside the table
  // body itself (see System/table.js renderBody) so the header stays put.
}
