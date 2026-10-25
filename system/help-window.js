// system/help-window.js
// The "?" popup: explains the right-click menu actions, multi-select, and
// how the filter bar works. Self-contained modal like confirm-dialog.js -
// builds its own overlay, resolves when closed.

const document = require('./dom-bridge.js').getDocument();

const SECTIONS = [
  {
    title: 'Customization',
    items: [
      ['Default styles', 'Manager comes with dark(default) and light styles. You can change them through Settings or View/UI Styles'],
      ['Custom styles', 'You can place your own custom css in system/styles. It will automatically be added to selection.'],
      ['Custom translation engine', 'In system/translator you can place your own translation script. '],
      ['Font Scaling', 'Ctrl and + (or =) makes text larger, Ctrl and - makes it smaller, and Ctrl+0 resets. Each press changes it by 10%, within 60%–200% ']
    ]
  },
  {
    title: 'Adding games',
    items: [
      ['Action/Add executable', 'Simply select game executable'],
      ['Action/Add directory', 'Select game directory. Multiple directories can be selected. It will not search in sub-directories.'],
      ['Drag-drop', 'You can drag-drop game executables or directories directly onto list. Multiple files will be added to batch and processed sequentially.'],
      ['Game info', 'Script expects RJ code in directory name, when detected it will automatically fetch game info from DLSite. You can add game without code but then you will need to enter RJ code into game info before information can be downloaded. Alternatively, you can manually enter all information yourself.'],
      ['Rebuild index', 'Backup game information is stored alongside images. In case of database corruption or migration, this option will clear existing database and rebuild it from backups.'],
      ['Importer', 'If you have been using DLSite Manager from before 2014, you can import its database with importer in utilities. This import is non-destructive, unless you choose to move images. Note: This app is not related to previous DLSite Manager or its creator.']
    ]
  },
  {
    title: 'Filter bar',
    items: [
      ['Where it looks', 'Title, circle, category, language, tags, product code and DLC code. Matching is case-insensitive and finds partial text.'],
      ['Several terms', 'Separate terms with | - every term must match (AND, not OR). "circle|rpg" only shows games matching both "circle" and "rpg".'],
      ['Path search', 'Start the text with a backslash to search game paths instead, e.g. \\folder or \\folder\\RJ0123. The leading backslash only switches the mode (it is not part of the search), and | still works. Without it, paths are never searched.'],
      ['Filter menu', 'The menu-bar Filter button (Duplicates / Favorites / Missing Tags) works together with the bar - a game must pass both. Pick the active entry again to switch it off.']
    ]
  },
  {
    title: 'Selecting several games',
    items: [
      ['Ctrl + click', 'Adds or removes selected game from the selection.'],
      ['Shift + click', 'Selects every game between the last clicked game and next one (Ctrl+Shift adds the range to the current selection).'],
      ['Right-click', 'Favorites, Translate Title, Rename, Download/Update info and Remove will apply to ALL selected games.']
    ]
  },
  {
    title: 'Right-click menu',
    items: [
      ['Run', 'Launches the game (same as double-click), using the Launcher and Launch parameters set for it.'],
      ['Open Containing Folder', 'Shows the game\'s executable in Explorer.'],
      ['Open on DLSite', 'Opens the product page in your browser. Unavailable for entries without a product code.'],
      ['Check for Updates', 'Looks up only the version on DLsite and stores it as "Latest version". Your own "Version" is never changed.'],
      ['Filter on Circle', 'Puts the game\'s circle name into the filter bar.'],
      ['Add to / Remove from Favorites', 'Marks the game as a favorite (shown by Filter > Filter on Favorites).'],
      ['Translate Title', 'Translates the title with the translator chosen in Settings > Translation and saves it as your own edit.'],
      ['Rename by Template', 'Renames the game\'s folder in place using the template from Settings > General. Never moves it - only the last part of the template (after any \\) is used.'],
      ['Rename/Organize by Template', 'Renames AND moves the folder into the Main folder. A \\ in the template creates sub-folders, e.g. [{circle}]\\{rjcode} {title}.'],
      ['Download info', 'Re-fetches everything from DLsite and overwrites the "Original info" fields. Your own edits are kept.'],
      ['Update info', 'Fetches from DLsite but only fills "Original info" fields that are currently empty.'],
      ['Remove from List', 'Removes the game and its saved info from the library. The game files on disk are never deleted.']
    ]
  },
  {
    title: 'Custom Launcher',
    items: [
      ['Launcher', 'Specifies alternative launcher for game. When active, starting game through manager will activate this instead.'],
      ['Launch parameters', 'When active, passes parameters/arguments to game executable on launch. If Launcher is active it passes parameters to it instead.']
    ]
  }
];

function showHelp() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    const box = document.createElement('div');
    box.className = 'confirm-box help-box';

    const heading = document.createElement('h2');
    heading.className = 'help-title';
    heading.textContent = 'Help';
    box.appendChild(heading);

    const body = document.createElement('div');
    body.className = 'help-body';

    for (const section of SECTIONS) {
      const h = document.createElement('h3');
      h.className = 'help-section-title';
      h.textContent = section.title;
      body.appendChild(h);

      const dl = document.createElement('dl');
      dl.className = 'help-list';
      for (const [term, text] of section.items) {
        const dt = document.createElement('dt');
        dt.textContent = term;
        const dd = document.createElement('dd');
        dd.textContent = text;
        dl.appendChild(dt);
        dl.appendChild(dd);
      }
      body.appendChild(dl);
    }
    box.appendChild(body);

    const buttons = document.createElement('div');
    buttons.className = 'confirm-buttons';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn--primary';
    closeBtn.textContent = 'Close';
    buttons.appendChild(closeBtn);
    box.appendChild(buttons);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function close() {
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
      resolve();
    }

    function onKeydown(e) {
      if (e.key === 'Escape' || e.key === 'Enter') close();
    }

    closeBtn.addEventListener('click', close);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onKeydown);
    closeBtn.focus();
  });
}

module.exports = { showHelp };
