// system/app.js
// Single entry point, loaded via <script src="system/app.js" defer> in
// index.html. Everything else is require()'d as a plain CommonJS module.
//
// Confirmed on this NW.js build: bare `document`/`window` identifiers
// referenced from within a require()'d CommonJS module do NOT reliably
// resolve to the real page's document/window (window !== global.window,
// document !== global.document here), even though this script's own
// top-level `document`/`window` are correct. See system/dom-bridge.js -
// every other module that touches the DOM gets document/window from
// there instead of the bare globals. This script seeds it with its own
// known-correct references before requiring anything else.

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

requireModule('./system/dom-bridge.js', './dom-bridge.js').init(window, document);

const { getAllGames, getGameRecord, updateGameOverride, updateGameFields, getAllCircles, saveCircle, deleteCircle, getSetting, setSetting } = requireModule('./system/db.js', './db.js');
const { GameTable } = requireModule('./system/table.js', './table.js');
const { EditPanel } = requireModule('./system/edit-panel.js', './edit-panel.js');
const { openSettingsWindow } = requireModule('./system/settings-window.js', './settings-window.js');
const { confirmDialog } = requireModule('./system/confirm-dialog.js', './confirm-dialog.js');
const libraryImport = requireModule('./system/library-import.js', './library-import.js');

// The window is created hidden (package.json "window.show": false) so we
// can restore its saved position/size first and avoid a flash of the
// default size. win.show() MUST run no matter what else fails below, or
// the app would launch permanently invisible.
const win = nw.Window.get();

// Using a plain 'DOMContentLoaded' listener here previously produced a
// real bug: if that event had already fired by the time this script's
// listener got attached (observed happening in practice, even though this
// script sits at the very end of <body>), the callback would simply never
// run - and every element lookup after it would see an apparently "empty"
// document. This checks document.readyState first and runs immediately if
// the DOM is already parsed, instead of only ever waiting for an event
// that may already be in the past.
function whenDomReady(callback) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', callback);
  } else {
    callback();
  }
}

whenDomReady(() => {
  restoreWindowBounds()
    .catch(err => console.error('Window bounds restore failed:', err))
    .finally(() => win.show());

  initSplitter().catch(err => console.error('Splitter init failed:', err));
  initTable().catch(err => console.error('Table init failed:', err));
  initSettingsMenu();
  initActionMenu();
  initDragDrop();
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
  if (!settingsBtn) {
    console.error('initSettingsMenu: #menu-settings-btn not found in the DOM.');
    return;
  }

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
// Action menu (menu bar → Action): Add executable / Add directory /
// Find duplicates / Rebuild index. Built fresh as a floating menu on
// every click (same approach as the column-visibility menu in
// system/table.js) rather than a static dropdown in the markup - so
// there's no separate dropdown element that can go missing from the DOM.
// All four items ultimately call into system/library-import.js, which
// does the actual scan/prompt/add work.
// ---------------------------------------------------------------
function initActionMenu() {
  const actionBtn = document.getElementById('menu-action-btn');
  if (!actionBtn) {
    console.error('initActionMenu: #menu-action-btn not found in the DOM.');
    return;
  }

  const ACTIONS = [
    { label: 'Add executable', run: runAddExecutable },
    { label: 'Add directory', run: runAddDirectory },
    { label: 'Find duplicates', run: runFindDuplicates },
    { label: 'Rebuild index', run: runRebuildIndex }
  ];

  let openMenuEl = null;

  function closeMenu() {
    if (openMenuEl) {
      openMenuEl.remove();
      openMenuEl = null;
    }
  }

  actionBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openMenuEl) {
      closeMenu();
      return;
    }

    const rect = actionBtn.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'menu-dropdown';
    menu.style.left = rect.left + 'px';
    menu.style.top = rect.bottom + 'px';

    for (const action of ACTIONS) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'menu-dropdown-item';
      item.textContent = action.label;
      item.addEventListener('click', () => {
        closeMenu();
        action.run();
      });
      menu.appendChild(item);
    }

    document.body.appendChild(menu);
    openMenuEl = menu;
  });

  document.addEventListener('mousedown', (e) => {
    if (openMenuEl && !openMenuEl.contains(e.target) && e.target !== actionBtn) {
      closeMenu();
    }
  });
}

async function runAddExecutable() {
  const exePaths = await browseExecutables();
  if (!exePaths.length) return;
  await libraryImport.addFromExecutablePaths(exePaths);
  await refreshGames();
}

async function runAddDirectory() {
  const dir = await browseFolder();
  if (!dir) return;
  await libraryImport.addFromDirectoryPaths([dir]);
  await refreshGames();
}

async function runFindDuplicates() {
  const dir = await browseFolder();
  if (!dir) return;
  await libraryImport.findDuplicates(dir); // shows its own report modal
}

async function runRebuildIndex() {
  const confirmed = await confirmDialog(
    "This reloads every game from its JSON backup under Database/Games, replacing what's currently in the database. Continue?",
    { okLabel: 'Rebuild', cancelLabel: 'Cancel' }
  );
  if (!confirmed) return;
  await libraryImport.rebuildIndex();
  await refreshGames();
}

/** Same native-picker trick as browseFolder(), but a normal multi-select file input filtered to .exe. */
function browseExecutables() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.exe';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);

    input.addEventListener('change', () => {
      const paths = Array.from(input.files).map(f => f.path).filter(Boolean);
      resolve(paths);
      input.remove();
    }, { once: true });

    window.addEventListener('focus', function onFocus() {
      window.removeEventListener('focus', onFocus);
      setTimeout(() => {
        if (document.body.contains(input)) {
          resolve([]);
          input.remove();
        }
      }, 300);
    }, { once: true });

    input.click();
  });
}

// ---------------------------------------------------------------
// Drag-and-drop onto the list panel: same processing as the menu
// actions, routed automatically by whether each dropped path is a file
// or a directory (system/library-import.js's addFromDroppedPaths).
// ---------------------------------------------------------------
function initDragDrop() {
  const listPanel = document.getElementById('list-panel');
  if (!listPanel) {
    console.error('initDragDrop: #list-panel not found in the DOM.');
    return;
  }

  listPanel.addEventListener('dragover', (e) => {
    e.preventDefault();
    listPanel.classList.add('is-drag-over');
  });

  listPanel.addEventListener('dragleave', (e) => {
    if (!listPanel.contains(e.relatedTarget)) {
      listPanel.classList.remove('is-drag-over');
    }
  });

  listPanel.addEventListener('drop', async (e) => {
    e.preventDefault();
    listPanel.classList.remove('is-drag-over');

    // NW.js exposes the real filesystem path of a dropped file as
    // File.path (not available on dropped files in a normal sandboxed
    // browser context - this only works because of NW.js's Node access).
    const paths = Array.from(e.dataTransfer.files).map(f => f.path).filter(Boolean);
    if (!paths.length) return;

    await libraryImport.addFromDroppedPaths(paths);
    await refreshGames();
  });
}

// ---------------------------------------------------------------
// Game table
// ---------------------------------------------------------------
let editPanel;
let table;

async function initTable() {
  const tableEl = document.getElementById('game-table');

  editPanel = new EditPanel({
    fetchRecord: getGameRecord,
    onApply: updateGameOverride,
    onUpdateLaunchSettings: updateGameFields,
    fetchCircles: getAllCircles,
    onSaveCircle: saveCircle,
    onDeleteCircle: deleteCircle
  });
  editPanel.show(null); // renders the empty/grayed field layout before anything is selected

  table = new GameTable({
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

  table.render();
  await refreshGames();
  // Empty state (no games yet) renders as a message row inside the table
  // body itself (see system/table.js renderBody) so the header stays put.
}

/** Re-fetches the game list and re-renders the table + status bar. Called once after startup, and again after any add/import finishes. */
async function refreshGames() {
  const games = await getAllGames();
  table.setRows(games);

  const statusEl = document.querySelector('#status-bar span');
  if (statusEl) {
    statusEl.textContent = `${games.length} game${games.length === 1 ? '' : 's'} catalogued`;
  }
}
