// System/circle-editor.js
// Circle manager modal, modeled on the old WinForms app's CircleEditor: a
// shared list of every circle across the whole library (Name + RGCode -
// the DLsite maker/circle code, which is the true stable identifier; the
// name is just a label and can be renamed independently). Lets the user
// pick which circle the current game belongs to, and add/rename/delete
// circles globally.
//
// Nothing is saved to the database until OK is pressed - Cancel discards
// everything, including new/deleted rows, same as the original.
//
// openCircleEditor({ circles, selectedCircleId, onSave, onDelete })
//   circles          - Circle[] currently in the database
//   selectedCircleId - the game's current circleId (or null), pre-selected
//   onSave           - ({circleId?, name, rgCode}) => Promise<circleId>
//   onDelete         - (circleId) => Promise
//
// Resolves to { cancelled: true } or { cancelled: false, selectedCircleId }.

const { isValidRgCode } = require('./db.js');

function openCircleEditor({ circles, selectedCircleId, onSave, onDelete }) {
  return new Promise((resolve) => {
    // Local mutable copy so Cancel can discard everything untouched.
    let rows = circles.map(c => ({
      circleId: c.circleId, name: c.name || '', rgCode: c.rgCode || '', isNew: false, isDeleted: false
    }));
    let selectedId = selectedCircleId;

    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    const box = document.createElement('div');
    box.className = 'circle-editor-box';

    const title = document.createElement('h2');
    title.className = 'circle-editor-title';
    title.textContent = 'Circles';
    box.appendChild(title);

    const list = document.createElement('div');
    list.className = 'circle-editor-list';
    box.appendChild(list);

    const errorEl = document.createElement('p');
    errorEl.className = 'circle-editor-error';
    box.appendChild(errorEl);

    function renderList() {
      list.innerHTML = '';

      rows.filter(r => !r.isDeleted).forEach((row) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'circle-editor-row' + (row.circleId === selectedId ? ' is-selected' : '');

        rowEl.addEventListener('click', (e) => {
          if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
          selectedId = row.circleId;
          renderList();
        });

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'circle-editor-name';
        nameInput.placeholder = 'Circle name';
        nameInput.value = row.name;
        nameInput.addEventListener('input', () => { row.name = nameInput.value; });

        const rgInput = document.createElement('input');
        rgInput.type = 'text';
        rgInput.className = 'circle-editor-rgcode';
        rgInput.placeholder = 'RG code';
        rgInput.value = row.rgCode;
        rgInput.addEventListener('input', () => { row.rgCode = rgInput.value; });

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn btn--inline';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', () => {
          row.isDeleted = true;
          if (selectedId === row.circleId) selectedId = null;
          renderList();
        });

        rowEl.appendChild(nameInput);
        rowEl.appendChild(rgInput);
        rowEl.appendChild(deleteBtn);
        list.appendChild(rowEl);
      });
    }

    renderList();

    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'btn';
    newBtn.textContent = 'New circle';
    newBtn.addEventListener('click', () => {
      const tempId = 'new-' + Math.random().toString(36).slice(2);
      rows.push({ circleId: tempId, name: '', rgCode: '', isNew: true, isDeleted: false });
      selectedId = tempId;
      renderList();
    });
    box.appendChild(newBtn);

    const buttons = document.createElement('div');
    buttons.className = 'confirm-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'btn btn--primary';
    okBtn.textContent = 'OK';

    buttons.appendChild(cancelBtn);
    buttons.appendChild(okBtn);
    box.appendChild(buttons);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function close(result) {
      overlay.remove();
      resolve(result);
    }

    cancelBtn.addEventListener('click', () => close({ cancelled: true }));
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close({ cancelled: true });
    });

    okBtn.addEventListener('click', async () => {
      errorEl.textContent = '';

      // Validate everything first (mirrors the old app: name required,
      // RGCode format checked) before saving anything.
      for (const row of rows) {
        if (row.isDeleted) continue;
        if (!row.name.trim()) {
          errorEl.textContent = 'Every circle needs a name.';
          return;
        }
        if (!isValidRgCode(row.rgCode)) {
          errorEl.textContent = `"${row.name}" has an invalid RG code.`;
          return;
        }
      }

      let finalSelectedId = selectedId;

      for (const row of rows) {
        if (row.isDeleted) {
          if (!row.isNew) await onDelete(row.circleId);
          continue;
        }
        const savedId = await onSave({
          circleId: row.isNew ? undefined : row.circleId,
          name: row.name.trim(),
          rgCode: row.rgCode.trim() || null
        });
        if (row.circleId === selectedId) finalSelectedId = savedId;
      }

      close({ cancelled: false, selectedCircleId: finalSelectedId });
    });
  });
}

module.exports = { openCircleEditor };
