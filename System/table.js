// System/table.js
// Renders and manages the interactive game table: column drag-to-reorder,
// drag-to-resize, right-click show/hide, and click-to-cycle sort
// (unsorted -> ascending -> descending -> unsorted). Vanilla DOM, no
// external dependencies - the header/colgroup/rows are fully regenerated
// from a column-config array on every render() call, which is what makes
// reordering/hiding trivial (there's no separate "move this DOM node"
// step; we just rebuild in the new order).

// Column order in this array IS the default display order.
const DEFAULT_COLUMNS = [
  { id: 'cover',      label: '',              width: 40,  minWidth: 40,  sortable: false, resizable: false },
  { id: 'rjcode',     label: 'RJCode',        width: 90,  minWidth: 60,  sortable: true,  field: 'productCode' },
  { id: 'title',      label: 'Title',         width: 260, minWidth: 120, sortable: true,  field: 'title' },
  { id: 'circle',     label: 'Circle',        width: 120, minWidth: 60,  sortable: true,  field: 'circle' },
  { id: 'language',   label: 'Language',      width: 90,  minWidth: 60,  sortable: true,  field: 'language' },
  { id: 'rating',     label: 'Rating',        width: 90,  minWidth: 60,  sortable: true,  field: 'rating' },
  { id: 'dlsrating',  label: 'DLSite Rating', width: 110, minWidth: 60,  sortable: true,  field: 'dlsiteRating' },
  { id: 'size',       label: 'Size',          width: 90,  minWidth: 60,  sortable: true,  field: 'sizeBytes' },
  { id: 'lastplayed', label: 'Last Played',   width: 110, minWidth: 60,  sortable: true,  field: 'lastPlayedDate' }
];

class GameTable {
  constructor({ container, onColumnsChanged, onSortChanged, onRowSelected }) {
    this.container = container; // the <table id="game-table">
    this.colgroup = container.querySelector('#game-table-colgroup');
    this.thead = container.querySelector('#game-table-head');
    this.tbody = container.querySelector('#game-table-body');

    this.onColumnsChanged = onColumnsChanged || (() => {});
    this.onSortChanged = onSortChanged || (() => {});
    this.onRowSelected = onRowSelected || (() => {});

    this.columns = DEFAULT_COLUMNS.map(c => ({ ...c }));
    this.sort = null; // { columnId, direction: 'asc' | 'desc' } | null
    this.rows = [];
    this.selectedCode = null;

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
        this._showColumnMenu(e.clientX, e.clientY);
      });

      tr.appendChild(th);
    }

    this.thead.appendChild(tr);
  }

  renderBody() {
    const sorted = this._sortedRows();
    this.tbody.innerHTML = '';

    for (const game of sorted) {
      const tr = document.createElement('tr');
      tr.dataset.productCode = game.productCode;
      if (game.productCode === this.selectedCode) tr.classList.add('is-selected');

      for (const col of this.columns) {
        if (col.visible === false) continue;
        const td = document.createElement('td');
        td.className = 'col-' + col.id;
        this._renderCell(td, col, game);
        tr.appendChild(td);
      }

      tr.addEventListener('click', () => {
        this.selectedCode = game.productCode;
        this.tbody.querySelectorAll('tr.is-selected').forEach(el => el.classList.remove('is-selected'));
        tr.classList.add('is-selected');
        this.onRowSelected(game);
      });

      this.tbody.appendChild(tr);
    }
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
      case 'rating':
      case 'dlsrating': {
        const value = col.id === 'rating' ? game.rating : game.dlsiteRating;
        const span = document.createElement('span');
        span.className = 'stars' + (col.id === 'dlsrating' ? ' stars--gold' : '');
        span.style.setProperty('--fill', Math.round(((value || 0) / 5) * 100) + '%');
        td.appendChild(span);
        return;
      }
      case 'size': {
        td.textContent = formatBytes(game.sizeBytes);
        return;
      }
      case 'lastplayed': {
        td.textContent = game.lastPlayedDate ? formatDate(game.lastPlayedDate) : '\u2014';
        return;
      }
      default: {
        const value = col.field ? game[col.field] : '';
        td.textContent = value == null ? '' : value;
      }
    }
  }

  _sortedRows() {
    if (!this.sort) return this.rows;
    const col = this.columns.find(c => c.id === this.sort.columnId);
    if (!col || !col.field) return this.rows;

    const field = col.field;
    const dir = this.sort.direction === 'desc' ? -1 : 1;

    return [...this.rows].sort((a, b) => {
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

    // Any click outside the column-visibility menu closes it.
    document.addEventListener('mousedown', (e) => {
      if (this._columnMenuEl && !this._columnMenuEl.contains(e.target)) {
        this._hideColumnMenu();
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

function formatDate(isoOrDate) {
  const d = new Date(isoOrDate);
  if (isNaN(d.getTime())) return String(isoOrDate);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

module.exports = { GameTable, DEFAULT_COLUMNS };
