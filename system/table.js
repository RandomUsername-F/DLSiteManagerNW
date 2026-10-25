// system/table.js
// Renders and manages the interactive game table: column drag-to-reorder,
// drag-to-resize, right-click show/hide, click-to-cycle sort
// (unsorted -> ascending -> descending -> unsorted), and Ctrl/Shift
// multi-select. Vanilla DOM, no
// external dependencies - the header/colgroup/rows are fully regenerated
// from a column-config array on every render() call, which is what makes
// reordering/hiding trivial (there's no separate "move this DOM node"
// step; we just rebuild in the new order).

// See system/dom-bridge.js: bare `document` isn't reliable inside a
// require()'d module on this NW.js build, so every DOM-touching file gets
// it explicitly instead. This `const` shadows the unreliable global for
// the rest of this file - nothing below needed to change.
const document = require('./dom-bridge.js').getDocument();

// Column order in this array IS the default display order.
const DEFAULT_COLUMNS = [
  { id: 'cover',      label: '',              width: 40,  minWidth: 40,  sortable: false, resizable: false },
  { id: 'rjcode',     label: 'RJCode',        width: 90,  minWidth: 60,  sortable: true,  field: 'productCode' },
  { id: 'title',      label: 'Title',         width: 260, minWidth: 120, sortable: true,  field: 'title' },
  { id: 'circle',     label: 'Circle',        width: 120, minWidth: 60,  sortable: true,  field: 'circle' },
  { id: 'language',   label: 'Language',      width: 90,  minWidth: 60,  sortable: true,  field: 'language' },
  { id: 'engine',     label: 'Engine',        width: 100, minWidth: 60,  sortable: true,  field: 'engine' },
  { id: 'dlsrating',  label: 'DLSite Rating', width: 110, minWidth: 60,  sortable: true,  field: 'dlsiteRating' },
  { id: 'size',       label: 'Size',          width: 90,  minWidth: 60,  sortable: true,  field: 'sizeBytes' },
  { id: 'lastplayed', label: 'Last Played',   width: 110, minWidth: 60,  sortable: true,  field: 'lastPlayedDate' },
  { id: 'dateadded',  label: 'Date Added',    width: 110, minWidth: 60,  sortable: true,  field: 'addedDate' }
];

class GameTable {
  constructor({ container, onColumnsChanged, onSortChanged, onRowSelected, onRowDoubleClick, onRowContextMenu }) {
    this.container = container; // the <table id="game-table">
    this.colgroup = container.querySelector('#game-table-colgroup');
    this.thead = container.querySelector('#game-table-head');
    this.tbody = container.querySelector('#game-table-body');

    this.onColumnsChanged = onColumnsChanged || (() => {});
    this.onSortChanged = onSortChanged || (() => {});
    this.onRowSelected = onRowSelected || (() => {});
    this.onRowDoubleClick = onRowDoubleClick || (() => {});
    this.onRowContextMenu = onRowContextMenu || (() => {});

    this.columns = DEFAULT_COLUMNS.map(c => ({ ...c }));
    this.sort = null; // { columnId, direction: 'asc' | 'desc' } | null
    this.rows = [];
    this.filterText = '';
    this.rowPredicate = null; // optional (game) => boolean, ANDed with the text filter
    this.selectedCode = null;      // primary selection (the row shown in the edit panel)
    this.selectedCodes = new Set(); // every selected row (Ctrl/Shift multi-select)
    this.anchorCode = null;         // range anchor for Shift+click

    this._dragColumnId = null;
    this._resizing = null;
    this._columnMenuEl = null;

    this._bindGlobalHandlers();
  }

  /** Merges saved {id, visible, width}[] (display order = array order) over the defaults. */
  applyColumnState(saved) {
    if (!saved || !saved.length) return;

    const byId = new Map(this.columns.map(c => [c.id, c]));
    const merged = [];

    for (const s of saved) {
      const col = byId.get(s.id);
      if (!col) continue; // ignore columns that no longer exist
      col.visible = s.visible !== false;
      if (s.width) col.width = Math.max(col.minWidth || 30, s.width);
      merged.push(col);
      byId.delete(s.id);
    }
    // Newly added columns not present in the saved state land at the end.
    for (const col of byId.values()) merged.push(col);

    this.columns = merged;
  }

  applySort(saved) {
    if (saved && saved.columnId) this.sort = saved;
  }

  setRows(rows) {
    this.rows = rows;
    this.renderBody();
  }

  /**
   * Filters the list. Terms are separated by "|" and combined with AND
   * (every term must match somewhere in a row), not OR - e.g. "circle|rpg"
   * only shows rows matching both "circle" and "rpg". Each row is matched
   * against title/circle/category/language/tags/productCode/dlcCode,
   * case-insensitively. Text starting with a backslash switches to a path
   * search instead (see _filteredRows).
   */
  setFilter(text) {
    this.filterText = text || '';
    this.renderBody();
  }

  /** Sets/clears an extra row predicate (menu-bar Filter). Pass null to clear. */
  setRowPredicate(fn) {
    this.rowPredicate = fn || null;
    this.renderBody();
  }

  /** Full re-render: colgroup + header + body, in current column order. */
  render() {
    this.renderHeader();
    this.renderBody();
  }

  renderHeader() {
    this.colgroup.innerHTML = '';
    this.thead.innerHTML = '';

    const tr = document.createElement('tr');

    for (const col of this.columns) {
      if (col.visible === false) continue;

      const colEl = document.createElement('col');
      colEl.style.width = col.width + 'px';
      this.colgroup.appendChild(colEl);

      const th = document.createElement('th');
      th.dataset.colId = col.id;
      th.className = 'col-' + col.id;
      th.draggable = true;

      const labelSpan = document.createElement('span');
      labelSpan.className = 'th-label';
      labelSpan.textContent = col.label;
      th.appendChild(labelSpan);

      if (col.sortable) {
        const arrow = document.createElement('span');
        arrow.className = 'th-sort-arrow';
        if (this.sort && this.sort.columnId === col.id) {
          arrow.textContent = this.sort.direction === 'asc' ? ' \u25B2' : ' \u25BC';
        }
        th.appendChild(arrow);

        th.addEventListener('click', () => {
          if (this._suppressNextClick) {
            this._suppressNextClick = false;
            return;
          }
          this._cycleSort(col.id);
        });
      }

      if (col.resizable !== false) {
        const handle = document.createElement('span');
        handle.className = 'th-resize-handle';
        handle.addEventListener('mousedown', (e) => this._startResize(e, col));
        th.appendChild(handle);
      }

      th.addEventListener('dragstart', (e) => this._startColumnDrag(e, col));
      th.addEventListener('dragover', (e) => e.preventDefault());
      th.addEventListener('drop', (e) => this._dropColumn(e, col));

      th.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        // The right-click's mousedown already closed an open column menu
        // (see _bindGlobalHandlers); don't immediately re-open it here.
        if (this._suppressColumnMenuOpen) {
          this._suppressColumnMenuOpen = false;
          return;
        }
        this._showColumnMenu(e.clientX, e.clientY);
      });

      tr.appendChild(th);
    }

    this.thead.appendChild(tr);
  }

  renderBody() {
    const sorted = this._sortedRows();
    const order = sorted.map(g => g.productCode);
    this.tbody.innerHTML = '';

    // Drop hidden (filtered-out) rows from a multi-selection; the primary stays.
    const visible = new Set(order);
    for (const code of Array.from(this.selectedCodes)) {
      if (code !== this.selectedCode && !visible.has(code)) this.selectedCodes.delete(code);
    }

    if (sorted.length === 0) {
      const visibleCount = this.columns.filter(c => c.visible !== false).length;
      const tr = document.createElement('tr');
      tr.className = 'empty-row';
      const td = document.createElement('td');
      td.colSpan = visibleCount;
      td.textContent = 'No games catalogued yet.';
      tr.appendChild(td);
      this.tbody.appendChild(tr);
      return;
    }

    for (const game of sorted) {
      const tr = document.createElement('tr');
      tr.dataset.productCode = game.productCode;
      if (this.selectedCodes.has(game.productCode)) tr.classList.add('is-selected');

      for (const col of this.columns) {
        if (col.visible === false) continue;
        const td = document.createElement('td');
        td.className = 'col-' + col.id;
        this._renderCell(td, col, game);
        tr.appendChild(td);
      }

      // Stop Shift/Ctrl+click from starting a text selection.
      tr.addEventListener('mousedown', (e) => {
        if (e.shiftKey || e.ctrlKey || e.metaKey) e.preventDefault();
      });

      tr.addEventListener('click', (e) => this._handleRowClick(e, game, order));

      tr.addEventListener('dblclick', () => this.onRowDoubleClick(game));

      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.onRowContextMenu(game, e.clientX, e.clientY);
      });

      this.tbody.appendChild(tr);
    }
  }

  /**
   * Plain click: single select. Ctrl+click: toggle one row in/out of the
   * selection. Shift+click: select every row between the anchor and the
   * clicked row (in current display order); Ctrl+Shift adds that range to
   * the existing selection. The edit panel always follows the primary
   * selection only; it changes (with the usual unsaved-changes prompt)
   * only on plain click or when Ctrl+click removes the primary row.
   */
  async _handleRowClick(e, game, order) {
    const code = game.productCode;
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;

    // Nothing selected yet: any click behaves as a plain click.
    if (!this.selectedCode) {
      return this._selectOnly(game);
    }

    if (shift) {
      const a = order.indexOf(this.anchorCode != null ? this.anchorCode : this.selectedCode);
      const b = order.indexOf(code);
      if (a === -1 || b === -1) return this._selectOnly(game);
      const [from, to] = a < b ? [a, b] : [b, a];
      if (!ctrl) this.selectedCodes = new Set();
      this.selectedCodes.add(this.selectedCode);
      for (let i = from; i <= to; i++) this.selectedCodes.add(order[i]);
      this._applySelectionClasses();
      return;
    }

    if (ctrl) {
      if (!this.selectedCodes.has(code)) {
        this.selectedCodes.add(code);
        this.anchorCode = code;
        this._applySelectionClasses();
        return;
      }
      if (this.selectedCodes.size === 1) return; // keep at least one row selected

      if (code === this.selectedCode) {
        // Primary removed: hand the edit panel to another selected row.
        const nextCode = order.find(c => c !== code && this.selectedCodes.has(c));
        const nextGame = this.rows.find(g => g.productCode === nextCode);
        if (!nextGame) return;
        const proceed = await this.onRowSelected(nextGame);
        if (proceed === false) return;
        this.selectedCodes.delete(code);
        this.selectedCode = nextCode;
      } else {
        this.selectedCodes.delete(code);
      }
      this.anchorCode = this.selectedCode;
      this._applySelectionClasses();
      return;
    }

    // Plain click
    if (code === this.selectedCode) {
      if (this.selectedCodes.size > 1) {
        this.selectedCodes = new Set([code]);
        this.anchorCode = code;
        this._applySelectionClasses();
      }
      return; // already the primary selection, nothing to confirm
    }
    return this._selectOnly(game);
  }

  async _selectOnly(game) {
    if (game.productCode !== this.selectedCode) {
      const proceed = await this.onRowSelected(game);
      if (proceed === false) return; // cancelled (e.g. unsaved-changes prompt)
    }
    this.selectedCode = game.productCode;
    this.selectedCodes = new Set([game.productCode]);
    this.anchorCode = game.productCode;
    this._applySelectionClasses();
  }

  _applySelectionClasses() {
    this.tbody.querySelectorAll('tr[data-product-code]').forEach(tr => {
      tr.classList.toggle('is-selected', this.selectedCodes.has(tr.dataset.productCode));
    });
  }

  /** Product codes of every selected (visible) row. */
  getSelectedCodes() {
    return Array.from(this.selectedCodes);
  }

  /** Product codes of the currently displayed rows, in display order. */
  getDisplayedCodes() {
    return this._sortedRows().map(g => g.productCode);
  }

  clearSelection() {
    this.selectedCode = null;
    this.selectedCodes = new Set();
    this.anchorCode = null;
    this._applySelectionClasses();
  }

  _renderCell(td, col, game) {
    switch (col.id) {
      case 'cover': {
        const img = document.createElement('img');
        img.className = 'cover-thumb';
        img.loading = 'lazy';
        img.alt = '';
        const thumbPath = (game.images && game.images.thumb) || 'images/thumb.jpg';
        img.src = `Database/Games/DLsite/${game.productCode}/${thumbPath}`;
        img.onerror = () => { img.style.visibility = 'hidden'; };
        td.appendChild(img);
        return;
      }
      case 'dlsrating': {
        const value = game.dlsiteRating;
        const span = document.createElement('span');
        span.className = 'stars stars--gold';
        span.style.setProperty('--fill', Math.round(((value || 0) / 5) * 100) + '%');
        td.appendChild(span);
        return;
      }
      case 'size': {
        td.textContent = formatBytes(game.sizeBytes);
        return;
      }
      case 'lastplayed': {
        td.textContent = game.lastPlayedDate ? formatDateYMD(game.lastPlayedDate) : '\u2014';
        return;
      }
      case 'dateadded': {
        td.textContent = game.addedDate ? formatDateYMD(game.addedDate) : '\u2014';
        return;
      }
      default: {
        const value = col.field ? game[col.field] : '';
        td.textContent = value == null ? '' : value;
      }
    }
  }

  _sortedRows() {
    const filtered = this._filteredRows();
    if (!this.sort) return filtered;
    const col = this.columns.find(c => c.id === this.sort.columnId);
    if (!col || !col.field) return filtered;

    const field = col.field;
    const dir = this.sort.direction === 'desc' ? -1 : 1;

    return [...filtered].sort((a, b) => {
      const av = a[field];
      const bv = b[field];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;  // nulls sort last regardless of direction
      if (bv == null) return -1;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }

  _filteredRows() {
    const base = this.rowPredicate ? this.rows.filter(this.rowPredicate) : this.rows;

    // Path search - only when the text STARTS with a backslash (e.g. "\folder"
    // or "\folder\RJ0123"); the leading backslash is just the switch. Matches
    // against each game's exe path, with the same "|" = AND rule. Kept opt-in
    // because it scans a longer string per row than the normal search.
    const text = this.filterText.trimStart();
    if (text.startsWith('\\')) {
      const pathTerms = text.slice(1).split('|')
        .map(t => t.trim().toLowerCase().replace(/\//g, '\\'))
        .filter(Boolean);
      if (!pathTerms.length) return base;

      return base.filter(game => {
        const gamePath = (game.path || '').toLowerCase().replace(/\//g, '\\');
        return pathTerms.every(term => gamePath.includes(term));
      });
    }

    const terms = this.filterText.split('|').map(t => t.trim().toLowerCase()).filter(Boolean);
    if (!terms.length) return base;

    return base.filter(game => {
      const haystack = [
        game.title, game.circle, game.category, game.language,
        (game.tags || []).join(' '), game.productCode, game.dlcCode
      ].filter(Boolean).join(' ').toLowerCase();
      return terms.every(term => haystack.includes(term));
    });
  }

  _cycleSort(columnId) {
    if (!this.sort || this.sort.columnId !== columnId) {
      this.sort = { columnId, direction: 'asc' };
    } else if (this.sort.direction === 'asc') {
      this.sort = { columnId, direction: 'desc' };
    } else {
      this.sort = null;
    }
    this.render();
    this.onSortChanged(this.sort);
  }

  _startColumnDrag(e, col) {
    if (this._resizing) {
      e.preventDefault();
      return;
    }
    this._dragColumnId = col.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', col.id);
  }

  _dropColumn(e, targetCol) {
    e.preventDefault();
    const draggedId = this._dragColumnId;
    this._dragColumnId = null;
    if (!draggedId || draggedId === targetCol.id) return;

    const fromIndex = this.columns.findIndex(c => c.id === draggedId);
    const toIndex = this.columns.findIndex(c => c.id === targetCol.id);
    if (fromIndex === -1 || toIndex === -1) return;

    const [moved] = this.columns.splice(fromIndex, 1);
    this.columns.splice(toIndex, 0, moved);

    this.render();
    this._notifyColumnsChanged();
  }

  _startResize(e, col) {
    e.preventDefault();
    e.stopPropagation();
    // A resize starting on the handle shouldn't also register as a sort
    // click on the header once the mouse is released over it.
    this._suppressNextClick = true;
    this._resizing = { col, startX: e.clientX, startWidth: col.width };
  }

  _bindGlobalHandlers() {
    document.addEventListener('mousemove', (e) => {
      if (!this._resizing) return;
      const { col, startX, startWidth } = this._resizing;
      const delta = e.clientX - startX;
      col.width = Math.max(col.minWidth || 30, startWidth + delta);

      const visibleIndex = this.columns.filter(c => c.visible !== false).indexOf(col);
      const colEl = this.colgroup.children[visibleIndex];
      if (colEl) colEl.style.width = col.width + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (this._resizing) {
        this._resizing = null;
        this._notifyColumnsChanged();
      }
    });

    // Any click outside the column-visibility menu closes it. A RIGHT-click
    // on a header while it's open only closes it (no re-open at the new spot).
    document.addEventListener('mousedown', (e) => {
      if (this._columnMenuEl && !this._columnMenuEl.contains(e.target)) {
        this._hideColumnMenu();
        if (e.button === 2 && e.target.closest && e.target.closest('th')) {
          this._suppressColumnMenuOpen = true;
        }
      }
    });
  }

  _notifyColumnsChanged() {
    const state = this.columns.map(c => ({ id: c.id, visible: c.visible !== false, width: c.width }));
    this.onColumnsChanged(state);
  }

  _showColumnMenu(x, y) {
    this._hideColumnMenu();

    const menu = document.createElement('div');
    menu.id = 'column-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    // Right-clicking the open menu itself closes it too.
    menu.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._hideColumnMenu();
    });

    for (const col of this.columns) {
      const label = document.createElement('label');
      label.className = 'column-menu-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = col.visible !== false;
      checkbox.addEventListener('change', () => {
        col.visible = checkbox.checked;
        this.render();
        this._notifyColumnsChanged();
      });

      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(col.label || '(cover image)'));
      menu.appendChild(label);
    }

    document.body.appendChild(menu);
    this._columnMenuEl = menu;
  }

  _hideColumnMenu() {
    if (this._columnMenuEl) {
      this._columnMenuEl.remove();
      this._columnMenuEl = null;
    }
  }
}

function formatBytes(bytes) {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

/** YYYY/MM/DD, all numeric (local time; date-only strings are used as-is to avoid timezone shifts). */
function formatDateYMD(isoOrDate) {
  if (typeof isoOrDate === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoOrDate.trim());
    if (m) return `${m[1]}/${m[2]}/${m[3]}`;
  }
  const d = new Date(isoOrDate);
  if (isNaN(d.getTime())) return String(isoOrDate);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

function formatDate(isoOrDate) {
  const d = new Date(isoOrDate);
  if (isNaN(d.getTime())) return String(isoOrDate);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

module.exports = { GameTable, DEFAULT_COLUMNS, formatBytes, formatDate };
