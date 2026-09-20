// System/edit-panel.js
// Renders the right-side edit panel: image strip with hover-preview,
// Product Code / Path fields, and the Game info / Original info tabs.
// Pure UI - all data access goes through the fetchRecord/onApply callbacks
// passed in, so this file never touches Dexie directly (same separation
// System/table.js follows with System/app.js).
//
// SIMPLIFICATIONS FROM THE ORIGINAL APP (flagged here rather than silently):
// - Star ratings are edited via a plain number input (0-5, step 0.5) next
//   to a live star preview, not by clicking directly on the stars.
// - "Time Played" is edited in whole minutes, not a duration picker.
// - "Size" is edited in MB, not bytes.
// These are all still stored/displayed the same way as before; only how
// you type the value differs.

const { formatBytes, formatDate } = require('./table.js');
const { confirmDialog } = require('./confirm-dialog.js');

// Fields shown in both tabs, in display order. Non-fullWidth fields are
// paired two-per-row (reusing the .edit-row/.edit-field layout already
// used for Product Code/Path); fullWidth fields get their own row.
const EDIT_FIELDS = [
  { id: 'title', label: 'Title', type: 'text', fullWidth: true },
  { id: 'circle', label: 'Circle', type: 'text' },
  { id: 'category', label: 'Category', type: 'text' },
  { id: 'language', label: 'Language', type: 'text' },
  { id: 'engine', label: 'Engine', type: 'text' },
  { id: 'version', label: 'Version', type: 'text' },
  { id: 'sizeBytes', label: 'Size', type: 'size' },
  { id: 'rating', label: 'Rating', type: 'stars', readOnly: true },
  { id: 'dlsiteRating', label: 'DLSite Rating', type: 'stars', gold: true, readOnly: true },
  { id: 'timesPlayed', label: 'Times Played', type: 'number' },
  { id: 'secondsPlayed', label: 'Time Played', type: 'duration' },
  { id: 'lastPlayedDate', label: 'Last Played', type: 'date' },
  { id: 'releaseDate', label: 'Released', type: 'date' },
  { id: 'tags', label: 'Tags', type: 'list' },
  { id: 'hvdbTags', label: 'HVDB Tags', type: 'list' },
  { id: 'cvs', label: 'CVs', type: 'list' },
  { id: 'description', label: 'Description', type: 'textarea', fullWidth: true, collapsible: true },
  { id: 'comments', label: 'Comments', type: 'textarea', fullWidth: true }
];

class EditPanel {
  constructor({ fetchRecord, onApply }) {
    this.fetchRecord = fetchRecord; // (productCode) => Promise<rawRecord>
    this.onApply = onApply;         // (productCode, overridePatch) => Promise

    this.emptyStateEl = document.getElementById('edit-empty-state');
    this.contentEl = document.getElementById('edit-content');
    this.toggleBtn = document.getElementById('edit-toggle-btn');
    this.applyBtn = document.getElementById('edit-apply-btn');
    this.downloadBtn = document.getElementById('edit-download-btn');

    this.productCodeEl = document.getElementById('field-productcode');
    this.pathTextEl = document.getElementById('field-path-text');

    this.imageStripEl = document.getElementById('image-strip');
    this.overlayEl = document.getElementById('image-preview-overlay');
    this.overlayImgEl = document.getElementById('image-preview-img');

    this.tabButtons = Array.from(document.querySelectorAll('.edit-tab'));
    this.modifiedPane = document.getElementById('edit-tab-modified');
    this.originalPane = document.getElementById('edit-tab-original');

    this.currentRecord = null;
    this.editing = false;
    this.dirty = false;
    this._inputs = {}; // fieldId -> the live input element, while editing

    this._bindStaticHandlers();
  }

  _bindStaticHandlers() {
    this.tabButtons.forEach(btn => {
      btn.addEventListener('click', () => this._activateTab(btn.dataset.tab));
    });

    this.toggleBtn.addEventListener('click', () => {
      this.editing = true;
      this.dirty = false;
      this._activateTab('modified');
      this._renderModifiedTab();
      this.applyBtn.disabled = false;
    });

    this.applyBtn.addEventListener('click', () => this._applyChanges());

    // Hover-preview: delegated on the strip so it works for thumbs added
    // after the fact, without rebinding per-image.
    this.imageStripEl.addEventListener('mouseover', (e) => {
      const thumb = e.target.closest('.edit-thumb');
      if (!thumb) return;
      this._previewIndex = Number(thumb.dataset.index);
      this._showOverlay();
    });

    this.imageStripEl.addEventListener('mouseleave', (e) => {
      // Don't hide if the mouse moved onto the overlay itself.
      if (e.relatedTarget && this.overlayEl.contains(e.relatedTarget)) return;
      this._hideOverlay();
    });

    this.overlayEl.addEventListener('mouseleave', () => this._hideOverlay());

    const cycle = (e) => {
      if (this.overlayEl.hidden || !this._previewImages || !this._previewImages.length) return;
      e.preventDefault();
      const dir = e.deltaY > 0 ? 1 : -1; // scroll down -> next, scroll up -> previous
      const count = this._previewImages.length;
      this._previewIndex = ((this._previewIndex + dir) % count + count) % count;
      this._updateOverlayImage();
    };
    this.imageStripEl.addEventListener('wheel', cycle, { passive: false });
    this.overlayEl.addEventListener('wheel', cycle, { passive: false });
  }

  /**
   * Called by app.js before switching to a different game. If the user is
   * mid-edit with unsaved changes, asks for confirmation; resolves true if
   * it's OK to proceed (and discards/exits edit mode), false if the caller
   * should leave the current selection alone.
   */
  async requestLeave() {
    if (!this.editing || !this.dirty) return true;

    const confirmed = await confirmDialog(
      'You have unsaved changes in Game info. Discard them and switch games?'
    );

    if (confirmed) {
      this.editing = false;
      this.dirty = false;
    }

    return confirmed;
  }

  /** Called by app.js when a row is selected (or with null to clear). */
  async show(productCode) {
    if (!productCode) {
      this._showEmptyState();
      return;
    }

    const record = await this.fetchRecord(productCode);
    if (!record) {
      this._showEmptyState();
      return;
    }

    this.currentRecord = record;
    this.editing = false;
    this.dirty = false;
    this._inputs = {};

    this.emptyStateEl.hidden = true;
    this.contentEl.hidden = false;
    this.toggleBtn.disabled = false;
    this.downloadBtn.disabled = false;
    this.applyBtn.disabled = true;

    this.productCodeEl.textContent = record.productCode;
    this.pathTextEl.textContent = record.path || '';

    this._renderImageStrip(record);
    this._renderOriginalTab();
    this._renderModifiedTab();
    this._activateTab('modified');
  }

  _showEmptyState() {
    this.currentRecord = null;
    this.emptyStateEl.hidden = false;
    this.contentEl.hidden = true;
    this.toggleBtn.disabled = true;
    this.applyBtn.disabled = true;
    this.downloadBtn.disabled = true;
    this._hideOverlay();
  }

  // ---------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------
  _activateTab(tabName) {
    this.tabButtons.forEach(btn => btn.classList.toggle('is-active', btn.dataset.tab === tabName));
    this.modifiedPane.classList.toggle('is-active', tabName === 'modified');
    this.originalPane.classList.toggle('is-active', tabName === 'original');
  }

  // ---------------------------------------------------------------
  // Image strip + hover preview
  // ---------------------------------------------------------------
  _renderImageStrip(record) {
    const images = record.images || {};
    const list = [images.thumb, ...(images.gallery || [])].filter(Boolean);
    this._previewImages = list.map(rel => `Database/Games/DLsite/${record.productCode}/${rel}`);
    this._previewIndex = 0;

    this.imageStripEl.innerHTML = '';
    this._previewImages.forEach((src, index) => {
      const img = document.createElement('img');
      img.className = 'edit-thumb';
      img.dataset.index = String(index);
      img.src = src;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => { img.style.visibility = 'hidden'; };
      this.imageStripEl.appendChild(img);
    });
  }

  _showOverlay() {
    if (!this._previewImages || !this._previewImages.length) return;
    const listPanelRect = document.getElementById('list-panel').getBoundingClientRect();
    this.overlayEl.style.left = listPanelRect.left + 'px';
    this.overlayEl.style.top = listPanelRect.top + 'px';
    this.overlayEl.style.width = listPanelRect.width + 'px';
    this.overlayEl.style.height = listPanelRect.height + 'px';
    this.overlayEl.hidden = false;
    this._updateOverlayImage();
  }

  _updateOverlayImage() {
    this.overlayImgEl.src = this._previewImages[this._previewIndex];
  }

  _hideOverlay() {
    this.overlayEl.hidden = true;
  }

  // ---------------------------------------------------------------
  // Original info tab - always read-only, from record.original
  // ---------------------------------------------------------------
  _renderOriginalTab() {
    this.originalPane.innerHTML = '';
    this._renderFieldGroup(this.originalPane, EDIT_FIELDS, this.currentRecord.original || {}, {
      editable: false
    });
  }

  // ---------------------------------------------------------------
  // Game info tab - read-only display, or editable inputs while this.editing
  // ---------------------------------------------------------------
  _renderModifiedTab() {
    this.modifiedPane.innerHTML = '';
    this._inputs = {};

    if (!this.editing) {
      const original = this.currentRecord.original || {};
      const override = this.currentRecord.override || {};
      // View mode shows the effective (override-or-original) value, same
      // as the list, so the tab matches what's actually in use.
      const resolved = {};
      for (const field of EDIT_FIELDS) {
        const ov = override[field.id];
        const isEmpty = ov == null || ov === '' || (Array.isArray(ov) && ov.length === 0);
        resolved[field.id] = { value: isEmpty ? original[field.id] : ov, inherited: isEmpty };
      }
      this._renderFieldGroup(this.modifiedPane, EDIT_FIELDS, resolved, {
        editable: false, resolvedMode: true
      });
    } else {
      this._renderFieldGroup(this.modifiedPane, EDIT_FIELDS, this.currentRecord.override || {}, {
        editable: true,
        originalValues: this.currentRecord.original || {}
      });
    }
  }

  // ---------------------------------------------------------------
  // Shared field-group renderer, used by all three render modes above.
  // `data` is either a plain {fieldId: rawValue} object (read-only modes,
  // resolvedMode uses {fieldId: {value, inherited}}) or the override object
  // (editable mode, where options.originalValues supplies the fallback
  // shown as each input's placeholder).
  // ---------------------------------------------------------------
  _renderFieldGroup(container, fields, data, options) {
    let pendingRow = null;

    const flushRow = () => {
      if (pendingRow && pendingRow.children.length) container.appendChild(pendingRow);
      pendingRow = null;
    };

    for (const field of fields) {
      const wrapper = document.createElement('div');
      wrapper.className = 'edit-field' + (field.id === 'comments' ? ' edit-field--comments' : '');

      let valueEl;

      if (options.editable && field.readOnly) {
        // e.g. ratings: still resolved (override-or-original), but never an
        // editable control, even while the rest of the tab is in edit mode.
        const overrideValue = data[field.id];
        const originalValue = options.originalValues[field.id];
        const isEmpty = overrideValue == null || overrideValue === ''
          || (Array.isArray(overrideValue) && overrideValue.length === 0);
        valueEl = this._buildReadOnlyValue(field, isEmpty ? originalValue : overrideValue, isEmpty);
      } else if (options.editable) {
        valueEl = this._buildInput(field, data[field.id], options.originalValues[field.id]);
      } else if (options.resolvedMode) {
        const entry = data[field.id] || {};
        valueEl = this._buildReadOnlyValue(field, entry.value, entry.inherited);
      } else {
        valueEl = this._buildReadOnlyValue(field, data[field.id], false);
      }

      if (field.collapsible) {
        const details = document.createElement('details');
        details.className = 'edit-details';
        const summary = document.createElement('summary');
        summary.textContent = field.label;
        details.appendChild(summary);
        details.appendChild(valueEl);
        wrapper.appendChild(details);
      } else {
        const label = document.createElement('label');
        label.textContent = field.label;
        wrapper.appendChild(label);
        wrapper.appendChild(valueEl);
      }

      if (field.fullWidth) {
        flushRow();
        container.appendChild(wrapper);
      } else {
        if (!pendingRow) {
          pendingRow = document.createElement('div');
          pendingRow.className = 'edit-row';
        }
        pendingRow.appendChild(wrapper);
        if (pendingRow.children.length === 2) flushRow();
      }
    }

    flushRow();
  }

  _buildReadOnlyValue(field, rawValue, inherited) {
    if (field.type === 'stars') {
      const span = document.createElement('span');
      span.className = 'stars' + (field.gold ? ' stars--gold' : '') + (inherited ? ' stars--inherited' : '');
      span.style.setProperty('--fill', Math.round(((rawValue || 0) / 5) * 100) + '%');
      return span;
    }

    const p = document.createElement('p');
    p.className = 'edit-value'
      + (field.type === 'textarea' ? ' edit-value--comments' : '')
      + (field.id === 'description' ? ' edit-value--description' : '')
      + (field.id === 'title' ? ' edit-value--title' : '');
    p.textContent = formatDisplayValue(field, rawValue);
    if (inherited && rawValue != null && rawValue !== '') {
      const tag = document.createElement('span');
      tag.className = 'edit-inherited-tag';
      tag.textContent = ' (from original)';
      p.appendChild(tag);
    }
    return p;
  }

  _buildInput(field, overrideRawValue, originalRawValue) {
    const isEmptyOverride = overrideRawValue == null || overrideRawValue === ''
      || (Array.isArray(overrideRawValue) && overrideRawValue.length === 0);

    if (field.type === 'stars') {
      const wrap = document.createElement('div');
      wrap.className = 'star-input';

      const preview = document.createElement('span');
      preview.className = 'stars' + (field.gold ? ' stars--gold' : '') + (isEmptyOverride ? ' stars--inherited' : '');
      const previewValue = isEmptyOverride ? originalRawValue : overrideRawValue;
      preview.style.setProperty('--fill', Math.round(((previewValue || 0) / 5) * 100) + '%');

      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = '5';
      input.step = '0.5';
      input.className = 'star-input-number';
      input.value = isEmptyOverride ? '' : overrideRawValue;
      input.placeholder = originalRawValue != null ? String(originalRawValue) : '';
      input.addEventListener('input', () => {
        this.dirty = true;
        const v = input.value === '' ? null : Number(input.value);
        preview.classList.toggle('stars--inherited', v == null);
        preview.style.setProperty('--fill', Math.round((((v == null ? originalRawValue : v) || 0) / 5) * 100) + '%');
      });

      wrap.appendChild(preview);
      wrap.appendChild(input);
      this._inputs[field.id] = { element: input, type: field.type };
      return wrap;
    }

    if (field.type === 'textarea') {
      const el = document.createElement('textarea');
      el.rows = field.id === 'description' ? 6 : 3;
      el.value = isEmptyOverride ? '' : overrideRawValue;
      el.placeholder = originalRawValue || '';
      el.addEventListener('input', () => { this.dirty = true; });
      this._inputs[field.id] = { element: el, type: field.type };
      return el;
    }

    const el = document.createElement('input');
    el.type = field.type === 'date' ? 'date' : (field.type === 'number' || field.type === 'duration' || field.type === 'size' ? 'number' : 'text');
    if (field.id === 'title') el.className = 'edit-input--title';

    if (field.type === 'date') {
      el.value = isEmptyOverride ? '' : String(overrideRawValue).slice(0, 10);
      el.placeholder = '';
    } else if (field.type === 'duration') {
      el.value = isEmptyOverride ? '' : Math.round(overrideRawValue / 60); // stored in seconds, edited in minutes
      el.placeholder = originalRawValue != null ? String(Math.round(originalRawValue / 60)) : '';
      el.title = 'Minutes';
    } else if (field.type === 'size') {
      el.value = isEmptyOverride ? '' : (overrideRawValue / (1024 * 1024)).toFixed(1);
      el.placeholder = originalRawValue != null ? (originalRawValue / (1024 * 1024)).toFixed(1) : '';
      el.title = 'MB';
    } else if (field.type === 'list') {
      el.value = isEmptyOverride ? '' : overrideRawValue.join(', ');
      el.placeholder = Array.isArray(originalRawValue) ? originalRawValue.join(', ') : '';
    } else {
      el.value = isEmptyOverride ? '' : overrideRawValue;
      el.placeholder = originalRawValue != null ? String(originalRawValue) : '';
    }

    this._inputs[field.id] = { element: el, type: field.type };
    el.addEventListener('input', () => { this.dirty = true; });
    return el;
  }

  // ---------------------------------------------------------------
  // Apply: read every input, convert back to storage format, save.
  // ---------------------------------------------------------------
  async _applyChanges() {
    const patch = {};

    for (const field of EDIT_FIELDS) {
      const entry = this._inputs[field.id];
      if (!entry) continue;
      patch[field.id] = parseInputValue(field, entry.element);
    }

    await this.onApply(this.currentRecord.productCode, patch);

    this.currentRecord.override = Object.assign({}, this.currentRecord.override, patch);
    this.editing = false;
    this.dirty = false;
    this.applyBtn.disabled = true;
    this._renderModifiedTab();
  }
}

function parseInputValue(field, el) {
  const raw = el.value;

  if (raw === '' || raw == null) return null;

  switch (field.type) {
    case 'date':
      return raw; // already YYYY-MM-DD from <input type="date">
    case 'duration':
      return Math.round(Number(raw) * 60); // minutes -> seconds
    case 'size':
      return Math.round(Number(raw) * 1024 * 1024); // MB -> bytes
    case 'number':
    case 'stars':
      return Number(raw);
    case 'list':
      return raw.split(',').map(s => s.trim()).filter(Boolean);
    default:
      return raw;
  }
}

function formatDisplayValue(field, value) {
  if (value == null || value === '') return '';

  switch (field.type) {
    case 'size':
      return formatBytes(value);
    case 'date':
      return formatDate(value);
    case 'duration': {
      const totalMinutes = Math.round(value / 60);
      const h = Math.floor(totalMinutes / 60);
      const m = totalMinutes % 60;
      return `${h}h ${m}m`;
    }
    case 'list':
      return Array.isArray(value) ? value.join(', ') : String(value);
    default:
      return String(value);
  }
}

module.exports = { EditPanel, EDIT_FIELDS };
