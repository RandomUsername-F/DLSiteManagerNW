# DLSite Manager NW

A less-than-accurate replica (not a port) of **DLSite Game Manager by Lux**, built on [NW.js](https://nwjs.io/).
Liberties were taken: some things were added, some removed.

> **Region-blocked games:** to grab game data for region-blocked products you still need DLBooster or another VPN.

It also includes a database importer for the original Manager by Lux.

## Install / setup

1. Open <https://nwjs.io/downloads/>, download the **normal** version for your OS, extract it and rename the folder to `DLSite Manager NW`.
2. Download `DLSiteManagerNW.zip` from the provided links and extract it directly into that folder (where `nw.exe` is). Overwrite if asked.
3. *(Optional)* Rename `nw.exe` to `Manager.exe`.
4. Run `install-dependencies.bat`. You will need Node <https://nodejs.org/en/download/> installed for this step.
5. Start the executable. The first run may take a little longer while the database is set up.

The app is portable: there is no installer, and its data lives in the `Database` folder next to the executable.

## Features

### Library
- **Add games** with *Action → Add executable* / *Add directory*, or drag and drop files and folders onto the list. Several games can be added at once; they are processed one at a time with a progress counter, and files added mid-way join the end of the running batch.
- **Game info from DLsite**: title, circle, category, release date, tags, description, rating, size, latest version and images are fetched automatically.
- **Engine detection** (RPG Maker variants, Wolf RPG, Unity, Ren'Py, KiriKiri, and more) from the game's files, falling back to the executable's *File description*.
- **DLC warning** when a game being added is a DLC of a game already in the library (*Add anyway* / *Skip*, with *Do this for all* for batches).
- **FANZA (DMM) codes** such as `d_457096` are recognized and stored as the product code, but never fetched, because DMM blocks foreign IPs.
- **Old app importer**: *Utility → Import* converts a Manager by Lux database (copying or moving its images; the old database and game files are never modified).

### List
- Sortable, reorderable, resizable columns; right-click a header to show or hide columns.
- **Filter bar** (Ctrl+F): terms separated by `|` must all match. Start with a backslash (for example `\folder\RJ0123`) to search game paths instead.
- **Filter menu**: Duplicates, Favorites, Missing Tags, Broken Links.
- **Multi-select** with Ctrl+click and Shift+click.
- Double-click a game to run it. A per-game *Launcher* and *Launch parameters* can be set; a relative launcher path is resolved against the game's folder.

### Right-click menu
Run, Open Containing Folder, Open on DLSite, Check for Updates, Filter on Circle, Favorites, Translate Title, Rename by Template, Rename/Organize by Template, Download info, Update info, Remove from List.
Favorites, Translate Title, the rename actions, Download/Update info and Remove apply to every selected game, one at a time.

### Editing
- The side panel has an editable **Game info** tab and a read-only **Original info** tab, so your edits never overwrite the fetched data.
- Circles are separate entries that can be renamed independently of their code.
- A **Translate** button for descriptions and a *Translate Title* action use the translator plugin chosen in Settings.

### Settings and customization
- **Rename template** with placeholders `{rjcode}`, `{circle}`, `{cvs}`, `{title}`, `{category}`, `{foldername}`. *Rename* only renames the game folder in place; *Rename/Organize* also moves it into the Main folder (a `\` in the template creates sub-folders). Both are also available for the whole library from the *Action* menu.
- **Tags replacement**: find/replace rules for tags, stored in `Database/replacementTags.json`, applied automatically on every save (*Auto*) or on demand with *Utility → Replace Tags*.
- **UI Style**: Dark is built in; drop any `.css` file into `system/styles/` and it appears in *View → UI Styles* and in Settings.
- **Translator plugins**: scripts in `system/translator/` that export `async function translate(text, fromLang, toLang)`.
- **Font size**: Ctrl + / Ctrl − (Ctrl+0 resets). Only text is scaled.
- The **?** button in the menu bar shows built-in help.

### Data and backups
- The live library is stored in IndexedDB inside the `Database` folder.
- Every game is also backed up as `Database/Games/DLsite/<code>/info.json` with its images, and circles in `Database/circles.json`. *Action → Rebuild index* restores the library from these backups.
- Favorites are not part of the backups.

## Notes
- Games and features were written without an automated test suite, so expect rough edges. Back up your `Database` folder before bulk operations such as renaming or importing.
- Dependencies (`dexie`, `cheerio`, `sql.js`) are bundled in `node_modules`.
