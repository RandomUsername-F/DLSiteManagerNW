// system/app.js
// Single entry point, loaded from index.html. Everything else is
// require()'d as a plain CommonJS module. This file is only the wiring
// layer (DOM lookups, menus, callbacks); the logic lives in the modules.
//
// Confirmed on this NW.js build: bare `document`/`window` identifiers
// referenced from within a require()'d CommonJS module do NOT reliably
// resolve to the real page's document/window (window !== global.window,
// document !== global.document here), even though this script's own
// top-level `document`/`window` are correct. See system/dom-bridge.js -
// every other module that touches the DOM gets document/window from
// there instead of the bare globals. This script seeds it with its own
// known-correct references before requiring anything else.

// NOTE ON PATHS: require() calls made directly from the page (as opposed
// to from within an already-required module) resolve relative to the main
// HTML document's folder (the app root), not relative to this file's own
// folder. requireModule() tries the root-relative path first and falls
// back to a self-relative one, so it works however this file is loaded.
function requireModule(rootRelative, selfRelative) {
  try {
    return require(rootRelative);
  } catch (e) {
    return require(selfRelative);
  }
}

requireModule('./system/dom-bridge.js', './dom-bridge.js').init(window, document);

const { getAllGames, getGameRecord, updateGameOverride, updateGameFields, getAllCircles, saveCircle, deleteCircle, getSetting, setSetting, setFavorite } = requireModule('./system/db.js', './db.js');
const { GameTable } = requireModule('./system/table.js', './table.js');
const { EditPanel } = requireModule('./system/edit-panel.js', './edit-panel.js');
const { openSettingsWindow } = requireModule('./system/settings-window.js', './settings-window.js');
const { confirmDialog } = requireModule('./system/confirm-dialog.js', './confirm-dialog.js');
const { showContextMenu } = requireModule('./system/context-menu.js', './context-menu.js');
const { launchGame } = requireModule('./system/game-launcher.js', './game-launcher.js');
const { listTranslatorEngines, translate } = requireModule('./system/translator.js', './translator.js');
const libraryImport = requireModule('./system/library-import.js', './library-import.js');
const tagReplacer = requireModule('./system/tag-replacer.js', './tag-replacer.js');
const helpWindow = requireModule('./system/help-window.js', './help-window.js');
const fontScale = requireModule('./system/font-scale.js', './font-scale.js');
const fs = require('fs');
const path = require('path');

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
  initFontScale().catch(err => console.error('Font scale init failed:', err));
  initTable().catch(err => console.error('Table init failed:', err));
  initSettingsMenu();
  initViewMenu();
  initFilterMenu();
  initHelpButton();
  initActionMenu();
  initUtilityMenu();
  initDragDrop();
  initFindFilter();
  applyStoredCustomizations().catch(err => console.error('Applying stored theme/locale failed:', err));
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
// Font size: Ctrl + / Ctrl - scale the app's text only (not the layout) -
// see system/font-scale.js. Ctrl+0 resets. Remembered between runs.
// ---------------------------------------------------------------
const FONT_SCALE_STEP = 0.1;

async function initFontScale() {
  win.zoomLevel = 0; // clear any whole-window zoom left over from an earlier build
  fontScale.setScale(Number(await getSetting('ui.fontScale', 1)) || 1);

  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;

    let next;
    if (e.key === '+' || e.key === '=') next = fontScale.getScale() + FONT_SCALE_STEP;
    else if (e.key === '-' || e.key === '_') next = fontScale.getScale() - FONT_SCALE_STEP;
    else if (e.key === '0') next = 1;
    else return;

    e.preventDefault();
    const applied = fontScale.setScale(next);
    setSetting('ui.fontScale', applied);
  });
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

  settingsBtn.addEventListener('click', async () => {
    const result = await openSettingsWindow({
      getSettings: () => getSetting('app', null),
      saveSettings: (settings) => setSetting('app', settings),
      browseFolder,
      listTranslatorEngines,
      listUiStyles,
      getTagReplacements: () => tagReplacer.getRules(),
      saveTagReplacements: (rules) => tagReplacer.saveRules(rules)
    });
    if (result && !result.cancelled) {
      applyCustomizations(result.settings);
    }
  });
}

/** Applies the UI style, tag-replacement Auto mode and parser locale settings to the running app - called right after Settings is saved, and once at startup (see applyStoredCustomizations below). */
function applyCustomizations(settings) {
  applyUiStyle(settings.custom && settings.custom.theme);
  tagReplacer.setAuto(settings.custom && settings.custom.tagReplacementAuto);

  process.env.DLSITE_LOCALE = (settings.translation && settings.translation.parserLocale) || 'en_US';
}

// ---------------------------------------------------------------
// UI styles: 'dark' = base style.css only; anything else is a .css file
// name in system/styles/, layered on top via #theme-stylesheet.
// ---------------------------------------------------------------
let activeUiStyle = 'dark';

function getStylesDir() {
  const candidates = [];
  if (typeof __dirname !== 'undefined') {
    candidates.push(path.join(__dirname, 'styles'), path.join(__dirname, 'system', 'styles'));
  }
  candidates.push(path.join(process.cwd(), 'system', 'styles'));
  return candidates.find(p => fs.existsSync(p)) || null;
}

/** [{ value: 'lightTheme.css', label: 'lightTheme' }, ...] for every .css file in system/styles/. */
function listUiStyles() {
  const dir = getStylesDir();
  if (!dir) return [];
  try {
    return fs.readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith('.css'))
      .sort((a, b) => a.localeCompare(b))
      .map(f => ({ value: f, label: f.replace(/\.css$/i, '') }));
  } catch (e) {
    console.error('Failed to list system/styles:', e);
    return [];
  }
}

function applyUiStyle(name) {
  if (name === 'light') name = 'lightTheme.css'; // legacy value
  if (!name || name === 'dark' || !listUiStyles().some(s => s.value === name)) {
    name = 'dark';
  }
  activeUiStyle = name;
  fontScale.setTheme(name); // keep the font-scale overrides in step with the active style's font sizes

  const link = document.getElementById('theme-stylesheet');
  if (!link) return;
  if (name === 'dark') {
    link.disabled = true;
    link.removeAttribute('href');
  } else {
    link.setAttribute('href', 'system/styles/' + encodeURIComponent(name));
    link.disabled = false;
  }
}

async function setUiStyle(name) {
  const settings = (await getSetting('app', null)) || {};
  settings.custom = Object.assign({}, settings.custom, { theme: name });
  await setSetting('app', settings);
  applyUiStyle(name);
}

function initViewMenu() {
  attachDropdownMenu('menu-view-btn', [
    {
      label: 'UI Styles',
      submenu: () => [{ value: 'dark', label: 'Dark (default)' }, ...listUiStyles()].map(s => ({
        label: s.label,
        checked: s.value === activeUiStyle,
        run: () => setUiStyle(s.value)
      }))
    }
  ]);
}

// ---------------------------------------------------------------
// Filter menu (menu bar -> Filter): one extra row filter at a time,
// ANDed with the find-bar text. Picking the active one again clears it.
// ---------------------------------------------------------------
let activeFilter = null; // null | 'duplicates' | 'favorites' | 'missingTags' | 'brokenLinks'
let brokenCheckToken = 0;
let allGames = [];

function initHelpButton() {
  const btn = document.getElementById('menu-help-btn');
  if (btn) btn.addEventListener('click', () => helpWindow.showHelp());
}

function initFilterMenu() {
  const toggle = (name) => () => {
    activeFilter = activeFilter === name ? null : name;
    applyRowFilter();
  };
  attachDropdownMenu('menu-filter-btn', [
    { label: 'Filter on Duplicates', checked: () => activeFilter === 'duplicates', run: toggle('duplicates') },
    { label: 'Filter on Favorites', checked: () => activeFilter === 'favorites', run: toggle('favorites') },
    { label: 'Filter on Missing Tags', checked: () => activeFilter === 'missingTags', run: toggle('missingTags') },
    { label: 'Filter on Broken Links', checked: () => activeFilter === 'brokenLinks', run: toggle('brokenLinks') }
  ]);
}

function baseCode(code) {
  return String(code || '').replace(/-DUP\w*$/i, '').toUpperCase();
}

function applyRowFilter() {
  if (!table) return;
  brokenCheckToken++; // invalidates any Broken Links check still in flight

  if (activeFilter === 'favorites') {
    table.setRowPredicate(g => g.favorite);
  } else if (activeFilter === 'missingTags') {
    table.setRowPredicate(g => !g.tags || (Array.isArray(g.tags) ? g.tags.length === 0 : !String(g.tags).trim()));
  } else if (activeFilter === 'brokenLinks') {
    // Checked against the disk each time the list refreshes (an empty path counts
    // as broken). Async so a slow/unreachable drive can't freeze the UI; the
    // token drops the result if the list or filter changed while it was running.
    const token = ++brokenCheckToken;
    const games = allGames;
    Promise.all(games.map(g => g.path
      ? fs.promises.access(g.path).then(() => null, () => g.productCode)
      : g.productCode
    )).then(codes => {
      if (token !== brokenCheckToken || activeFilter !== 'brokenLinks') return;
      const broken = new Set(codes.filter(Boolean));
      table.setRowPredicate(g => broken.has(g.productCode));
    });
  } else if (activeFilter === 'duplicates') {
    // A game is a duplicate if any of its codes (base product code, DLC code)
    // is also claimed by a different game.
    const owners = new Map(); // code -> Set<productCode>
    const keysOf = (g) => [baseCode(g.productCode), g.dlcCode ? baseCode(g.dlcCode) : null].filter(Boolean);
    for (const g of allGames) {
      if (String(g.productCode).startsWith('LOCAL-')) continue;
      for (const k of keysOf(g)) {
        if (!owners.has(k)) owners.set(k, new Set());
        owners.get(k).add(g.productCode);
      }
    }
    table.setRowPredicate(g => !String(g.productCode).startsWith('LOCAL-') && keysOf(g).some(k => {
      const set = owners.get(k);
      return set && (set.size > 1 || !set.has(g.productCode));
    }));
  } else {
    table.setRowPredicate(null);
  }
}

async function toggleFavorite(productCodes, value) {
  for (const code of productCodes) await setFavorite(code, value);
  await refreshGames();
}

async function applyStoredCustomizations() {
  const settings = await getSetting('app', null);
  if (settings) applyCustomizations(settings);
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
// Rebuild index, then Rename by Template / Rename/Organize by Template
// for the whole library. Built fresh as a floating menu on every click
// (see attachDropdownMenu) rather than a static dropdown in the markup,
// so there's no separate dropdown element that can go missing from the
// DOM. The add/rebuild items call into system/library-import.js, which
// does the actual scan/prompt/add work.
// ---------------------------------------------------------------
function initActionMenu() {
  attachDropdownMenu('menu-action-btn', [
    { label: 'Add executable', run: runAddExecutable },
    { label: 'Add directory', run: runAddDirectory },
    { label: 'Rebuild index', run: runRebuildIndex },
    { separator: true },
    { label: 'Rename by Template', run: () => runRenameAll(false) },
    { label: 'Rename/Organize by Template', run: () => runRenameAll(true) }
  ]);
}

/** Action menu version of the context-menu renames: applies to EVERY game in the library, after a warning. */
async function runRenameAll(organize) {
  const codes = allGames.map(g => g.productCode);
  if (!codes.length) return;

  const settings = await getSetting('app', null);
  const template = (settings && settings.general && settings.general.renameTemplate) || '{rjcode} [{circle}] {title}';
  const mainFolder = (settings && settings.general && settings.general.gameFolder) || '';

  if (organize && !mainFolder) {
    await confirmDialog('Set a Main folder in Settings first.', { okLabel: 'OK', cancelLabel: 'OK' });
    return;
  }

  const proceed = await confirmDialog(
    `Warning: this will ${organize ? 'rename AND move' : 'rename'} the folders of ALL ${codes.length} game${codes.length === 1 ? '' : 's'} in your library on disk, ` +
    `using the template "${template}"` + (organize ? ` into "${mainFolder}"` : '') + '. ' +
    'It cannot be undone automatically. Make sure no game is running.',
    { okLabel: 'Continue', cancelLabel: 'Cancel' }
  );
  if (!proceed) return;

  await runBatch(codes, organize ? 'Rename/Organize' : 'Rename', (code) => libraryImport.renameGame(code, template, organize, mainFolder));
}

// ---------------------------------------------------------------
// Utility menu (menu bar → Utility): Import (from the old app) and
// Replace Tags (manual run of the tag replacement rules).
// ---------------------------------------------------------------
function initUtilityMenu() {
  attachDropdownMenu('menu-utility-btn', [
    { label: 'Import', run: runImport },
    { label: 'Replace Tags', run: runReplaceTags }
  ]);
}

/** Manual tag replacement over every game, using the rules in Database/replacementTags.json. */
async function runReplaceTags() {
  try {
    setStatus('Replacing tags\u2026');
    const count = await tagReplacer.applyToAll();
    setStatus(null);
    await refreshGames();
    if (editPanel && editPanel.currentRecord) await editPanel.show(editPanel.currentRecord.productCode);
    await confirmDialog(`Tags replaced in ${count} game${count === 1 ? '' : 's'}.`, { okLabel: 'OK', cancelLabel: 'OK' });
  } catch (e) {
    setStatus(null);
    console.error('Replace tags failed:', e);
    await confirmDialog('Replace tags failed: ' + e.message, { okLabel: 'OK', cancelLabel: 'OK' });
  }
}

/** Imports/converts an existing database from the old GameManager app - see system/plugins/importOldApp.js. */
async function runImport() {
  const proceed = await confirmDialog(
    "This imports and converts your existing game library from the old GameManager app: it reads " +
    "its Games.db and maps each game's info into this app's format, optionally copying/moving its " +
    "images too. Anything already in your library (matched by product code) is skipped automatically " +
    "- nothing existing gets overwritten.",
    { okLabel: 'Proceed', cancelLabel: 'Cancel' }
  );
  if (!proceed) return;

  const exePaths = await browseExecutables();
  if (!exePaths.length) return;

  const importOldApp = requireModule('./system/plugins/importOldApp.js', './plugins/importOldApp.js');
  await importOldApp.run(exePaths[0]);
  await refreshGames();
}

/**
 * Shared floating-dropdown logic for menu-bar buttons: builds a fresh
 * menu on every click (no static dropdown element in the markup that can
 * go missing), positioned under the button, closed on outside click.
 * actions entries:
 *   { label, run, checked? }   - checked: () => boolean shows a leading check mark
 *   { label, submenu }         - submenu: () => [{ label, run, checked? }] opens a flyout
 *   { separator: true }
 */
function attachDropdownMenu(buttonId, actions) {
  const button = document.getElementById(buttonId);
  if (!button) {
    console.error(`attachDropdownMenu: #${buttonId} not found in the DOM.`);
    return;
  }

  let openMenuEl = null;
  let openSubEl = null;

  function closeSub() {
    if (openSubEl) {
      openSubEl.remove();
      openSubEl = null;
    }
  }

  function openSub(anchor, entries) {
    const r = anchor.getBoundingClientRect();
    const sub = document.createElement('div');
    sub.className = 'menu-dropdown';
    sub.style.left = r.right + 'px';
    sub.style.top = r.top + 'px';
    for (const entry of entries) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'menu-dropdown-item';
      el.textContent = (entry.checked ? '\u2713 ' : '\u2003 ') + entry.label;
      el.addEventListener('click', () => {
        closeMenu();
        entry.run();
      });
      sub.appendChild(el);
    }
    document.body.appendChild(sub);
    openSubEl = sub;
  }

  function closeMenu() {
    closeSub();
    if (openMenuEl) {
      openMenuEl.remove();
      openMenuEl = null;
    }
  }

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openMenuEl) {
      closeMenu();
      return;
    }

    const rect = button.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'menu-dropdown';
    menu.style.left = rect.left + 'px';
    menu.style.top = rect.bottom + 'px';

    for (const action of actions) {
      if (action.separator) {
        const sep = document.createElement('div');
        sep.className = 'menu-dropdown-separator';
        menu.appendChild(sep);
        continue;
      }
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'menu-dropdown-item';
      item.textContent = (typeof action.checked === 'function' ? (action.checked() ? '\u2713 ' : '\u2003 ') : '') + action.label;
      if (action.submenu) item.classList.add('has-submenu');
      item.addEventListener('mouseenter', () => {
        closeSub();
        if (action.submenu) openSub(item, action.submenu());
      });
      item.addEventListener('click', () => {
        if (action.submenu) {
          closeSub();
          openSub(item, action.submenu());
          return;
        }
        closeMenu();
        action.run();
      });
      menu.appendChild(item);
    }

    document.body.appendChild(menu);
    openMenuEl = menu;
  });

  document.addEventListener('mousedown', (e) => {
    if (openMenuEl && !openMenuEl.contains(e.target) && !(openSubEl && openSubEl.contains(e.target)) && e.target !== button) {
      closeMenu();
    }
  });
}

async function runAddExecutable() {
  const exePaths = await browseExecutables();
  if (!exePaths.length) return;
  await libraryImport.addFromExecutablePaths(exePaths, { onStatus: setStatus });
  await refreshGames();
}

async function runAddDirectory() {
  const dir = await browseFolder();
  if (!dir) return;
  await libraryImport.addFromDirectoryPaths([dir], { onStatus: setStatus });
  await refreshGames();
}

/** Unused: "Find duplicates" was removed from the Action menu (see the Filter menu's "Filter on Duplicates"). Kept only until libraryImport.findDuplicates is retired too. */
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

    await libraryImport.addFromDroppedPaths(paths, { onStatus: setStatus });
    await refreshGames();
  });
}

// ---------------------------------------------------------------
// Find/filter bar - Ctrl+F focuses it; "|" between terms is AND, not OR
// (see system/table.js's setFilter/_filteredRows).
// ---------------------------------------------------------------
function initFindFilter() {
  const findInput = document.getElementById('find-input');
  if (!findInput) {
    console.error('initFindFilter: #find-input not found in the DOM.');
    return;
  }

  findInput.addEventListener('input', () => table.setFilter(findInput.value));

  const clearBtn = document.getElementById('find-clear');
  if (clearBtn) {
    const clear = () => {
      findInput.value = '';
      table.setFilter('');
      findInput.focus();
    };
    clearBtn.addEventListener('click', clear);
    clearBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        clear();
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      findInput.focus();
      findInput.select();
    }
  });
}

/** Filters the list down to one circle, by name (resolved from its RG code by the caller - see onRowContextMenu's "Filter on Circle" handler) - used since table.js's filter only matches against the resolved circle name, not the RG code itself. */
function filterByCircleName(circleName) {
  const findInput = document.getElementById('find-input');
  if (findInput) findInput.value = circleName || '';
  table.setFilter(circleName || '');
}

/** Shows/clears a transient status-bar message (e.g. "Fetching RJ012345…") - passed as the onStatus callback into system/library-import.js calls. */
function setStatus(text) {
  const el = document.getElementById('status-activity');
  if (el) el.textContent = text || '';
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
    onDeleteCircle: deleteCircle,
    onRecordChanged: () => refreshGames(),
    onDownloadInfo: (productCode) => libraryImport.downloadInfo(productCode, { onStatus: setStatus }),
    onBrowsePath: async () => {
      const paths = await browseExecutables();
      return paths[0] || null;
    },
    onTranslateText: (text) => translateLongText(text)
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
    },
    onRowDoubleClick: (game) => runLaunch(game),
    onRowContextMenu: (game, x, y) => showGameContextMenu(game, x, y)
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
  allGames = games;
  table.setRows(games);
  applyRowFilter();

  const statusEl = document.querySelector('#status-bar span');
  if (statusEl) {
    statusEl.textContent = `${games.length} game${games.length === 1 ? '' : 's'} catalogued`;
  }
}

// ---------------------------------------------------------------
// Launching (double-click, and the "Run" context-menu item)
// ---------------------------------------------------------------
async function runLaunch(resolvedGame) {
  const record = await getGameRecord(resolvedGame.productCode);
  if (!record) return;

  try {
    await launchGame(record); // resolves once the process has actually started
  } catch (e) {
    console.error('Launch failed for', resolvedGame.productCode, e);
    await confirmDialog(`Could not launch ${resolvedGame.title || resolvedGame.productCode}: ${e.message}`, { okLabel: 'OK', cancelLabel: 'OK' });
    return;
  }

  // Started successfully: stamp Last Played (stored as the user's own value, so it wins over any imported one).
  try {
    await updateGameOverride(record.productCode, { lastPlayedDate: new Date().toISOString() });
    await refreshGames();
    // Don't re-render the panel mid-edit - that would throw away unsaved changes.
    if (editPanel.currentRecord && editPanel.currentRecord.productCode === record.productCode && !editPanel.editing) {
      await editPanel.show(record.productCode);
    }
  } catch (e) {
    console.error('Failed to record last played for', record.productCode, e);
  }
}

// ---------------------------------------------------------------
// Right-click context menu
// ---------------------------------------------------------------
async function showGameContextMenu(resolvedGame, x, y) {
  const record = await getGameRecord(resolvedGame.productCode);
  if (!record) return;

  const circles = await getAllCircles();
  const circle = record.original && record.original.circleId != null
    ? circles.find(c => c.circleId === record.original.circleId)
    : null;

  // Batch actions apply to the whole selection when the right-clicked row is part of a multi-selection.
  const targets = getTargetCodes(resolvedGame);

  showContextMenu(x, y, [
    { label: 'Run', onClick: () => runLaunch(resolvedGame) },
    { label: 'Open Containing Folder', onClick: () => openContainingFolder(record) },
    { separator: true },
    { label: 'Open on DLSite', onClick: () => openOnDlsite(record), disabled: isLocalCode(record.productCode) || isFanzaCode(record.productCode) },
    { label: 'Check for Updates', onClick: () => runCheckForUpdates(record), disabled: isFanzaCode(record.productCode) },
    { separator: true },
    {
      label: 'Filter on Circle',
      onClick: () => filterByCircleName(circle ? circle.name : ''),
      disabled: !circle
    },
    { separator: true },
    resolvedGame.favorite
      ? { label: 'Remove from Favorites', onClick: () => toggleFavorite(targets, false) }
      : { label: 'Add to Favorites', onClick: () => toggleFavorite(targets, true) },
    { separator: true },
    { label: 'Translate Title', onClick: () => runTranslateTitle(targets) },
    { label: 'Rename by Template', onClick: () => runRename(targets, false) },
    { label: 'Rename/Organize by Template', onClick: () => runRename(targets, true) },
    { separator: true },
    { label: 'Download info', title: 'Overwrites every field with freshly parsed data.', onClick: () => runDownloadInfo(targets) },
    { label: 'Update info', title: 'Only fills in fields that are currently empty - never overwrites existing data.', onClick: () => runUpdateInfo(targets) },
    { separator: true },
    { label: 'Remove from List', onClick: () => runRemove(targets) }
  ]);
}

/** Codes the batch actions apply to: the whole selection (in display order) if the clicked row is in a multi-selection, else just the clicked row. */
function getTargetCodes(resolvedGame) {
  const selected = new Set(table.getSelectedCodes());
  if (selected.size > 1 && selected.has(resolvedGame.productCode)) {
    return table.getDisplayedCodes().filter(c => selected.has(c));
  }
  return [resolvedGame.productCode];
}

/**
 * Runs worker(code, onStatus) over each code ONE AT A TIME - each item
 * fully finishes before the next starts. Failures are collected and shown
 * in a single summary at the end rather than one dialog per item.
 * worker may return false to count as a failure with no exception.
 */
async function runBatch(codes, label, worker) {
  const failures = [];
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const suffix = codes.length > 1 ? ` (${i + 1}/${codes.length})` : '';
    try {
      const result = await worker(code, (text) => setStatus(text ? text + suffix : text));
      if (result === false) failures.push(`${code}: nothing was retrieved/changed`);
    } catch (e) {
      console.error(`${label} failed for ${code}:`, e);
      failures.push(`${code}: ${e.message}`);
    }
  }
  setStatus(null);

  await refreshGames();
  if (editPanel.currentRecord && codes.includes(editPanel.currentRecord.productCode)) {
    await editPanel.show(editPanel.currentRecord.productCode);
  }

  if (failures.length) {
    const shown = failures.slice(0, 6).join('\n') + (failures.length > 6 ? `\n\u2026and ${failures.length - 6} more` : '');
    await confirmDialog(`${label} failed for ${failures.length} of ${codes.length}:\n${shown}`, { okLabel: 'OK', cancelLabel: 'OK' });
  }
}

/** For batches of 2+: one up-front connectivity check instead of an offline prompt per item. Returns false if offline (after telling the user). */
async function batchOnlineCheck(codes) {
  if (codes.length < 2) return true;
  if (await libraryImport.checkConnectivity()) return true;
  await confirmDialog("Couldn't reach DLsite (no internet connection?).", { okLabel: 'OK', cancelLabel: 'OK' });
  return false;
}

function isLocalCode(code) {
  return !code || code.startsWith('LOCAL-');
}

/** FANZA/DMM codes (d_123456) - no DLsite page exists for them, so DLsite-only actions are disabled. */
function isFanzaCode(code) {
  return /^d_\d{4,8}(-DUP\w*)?$/.test(String(code || ''));
}

function openContainingFolder(record) {
  if (record.path) nw.Shell.showItemInFolder(record.path);
}

function openOnDlsite(record) {
  const prefix = record.productCode.slice(0, 2).toUpperCase();
  const section = prefix === 'VJ' ? 'soft' : prefix === 'BJ' ? 'books' : 'maniax';
  nw.Shell.openExternal(`https://www.dlsite.com/${section}/work/=/product_id/${record.productCode}.html`);
}

async function runCheckForUpdates(record) {
  const latest = await libraryImport.checkForUpdates(record.productCode, { onStatus: setStatus });
  if (latest == null) {
    await confirmDialog("Couldn't check for updates (offline, or nothing found).", { okLabel: 'OK', cancelLabel: 'OK' });
  }
  await refreshGames();
  if (editPanel.currentRecord && editPanel.currentRecord.productCode === record.productCode) {
    await editPanel.show(record.productCode);
  }
}

async function runDownloadInfo(codes) {
  if (!(await batchOnlineCheck(codes))) return;
  await runBatch(codes, 'Download info', (code, onStatus) =>
    libraryImport.downloadInfo(code, { onStatus, skipConnectivityCheck: codes.length > 1 }));
}

async function runUpdateInfo(codes) {
  if (!(await batchOnlineCheck(codes))) return;
  await runBatch(codes, 'Update info', (code, onStatus) =>
    libraryImport.updateInfo(code, { onStatus, skipConnectivityCheck: codes.length > 1 }));
}

async function runRemove(codes) {
  const multiple = codes.length > 1;
  if (multiple) {
    const confirmed = await confirmDialog(
      `Remove ${codes.length} games from your library? This does not delete the actual game files - only DLSiteManager's saved info about them.`,
      { okLabel: 'Remove', cancelLabel: 'Cancel' }
    );
    if (!confirmed) return;
  }

  const removed = [];
  const failures = [];
  for (const code of codes) { // one at a time
    try {
      // A single removal asks its own confirmation inside removeFromList.
      if (await libraryImport.removeFromList(code, { skipConfirm: multiple })) removed.push(code);
    } catch (e) {
      console.error('Remove failed for', code, e);
      failures.push(`${code}: ${e.message}`);
    }
  }

  await afterRemove(removed);
  if (failures.length) {
    await confirmDialog(`Remove failed for ${failures.length} of ${codes.length}:\n${failures.slice(0, 6).join('\n')}`, { okLabel: 'OK', cancelLabel: 'OK' });
  }
}
async function afterRemove(removedCodes) {
  if (table.selectedCode && removedCodes.includes(table.selectedCode)) table.clearSelection();
  if (editPanel.currentRecord && removedCodes.includes(editPanel.currentRecord.productCode)) {
    await editPanel.show(null);
  }
  await refreshGames();
}

/**
 * Translates arbitrary-length text with the configured translator plugin
 * (same settings as Translate Title). Long text is split on line breaks
 * into chunks of at most ~1500 characters and translated one chunk at a
 * time, so plugins with request-size limits still work.
 */
async function translateLongText(text) {
  const settings = await getSetting('app', null);
  const t = (settings && settings.translation) || {};
  const engine = t.translatorEngine || 'googleTranslator';
  const from = t.translateFrom || 'ja';
  const to = t.translateTo || 'en';

  const MAX = 1500;
  const chunks = [];
  let current = '';
  for (const line of String(text).split('\n')) {
    // A single over-long line is hard-split.
    const pieces = [];
    for (let i = 0; i < line.length; i += MAX) pieces.push(line.slice(i, i + MAX));
    if (!pieces.length) pieces.push('');

    for (const piece of pieces) {
      if (current && (current.length + piece.length + 1) > MAX) {
        chunks.push(current);
        current = piece;
      } else {
        current = current ? current + '\n' + piece : piece;
      }
    }
  }
  if (current) chunks.push(current);

  const out = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      if (!chunks[i].trim()) {
        out.push(chunks[i]);
        continue;
      }
      setStatus(`Translating\u2026${chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ''}`);
      out.push(await translate(engine, chunks[i], from, to));
    }
  } finally {
    setStatus(null);
  }
  return out.join('\n');
}

async function runTranslateTitle(codes) {
  const settings = await getSetting('app', null);
  const t = (settings && settings.translation) || {};

  await runBatch(codes, 'Translate title', async (code, onStatus) => {
    const record = await getGameRecord(code);
    if (!record) return false;
    const title = record.override.title || record.original.title;
    if (!title) return; // nothing to translate - not an error

    onStatus('Translating\u2026');
    const translated = await translate(t.translatorEngine || 'googleTranslator', title, t.translateFrom || 'ja', t.translateTo || 'en');
    await updateGameOverride(code, { title: translated });
  });
}

async function runRename(codes, organize) {
  const settings = await getSetting('app', null);
  const template = (settings && settings.general && settings.general.renameTemplate) || '{rjcode} [{circle}] {title}';
  const mainFolder = (settings && settings.general && settings.general.gameFolder) || '';

  if (organize && !mainFolder) {
    await confirmDialog('Set a Main folder in Settings first.', { okLabel: 'OK', cancelLabel: 'OK' });
    return;
  }

  await runBatch(codes, 'Rename', (code) => libraryImport.renameGame(code, template, organize, mainFolder));
}
