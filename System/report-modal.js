// system/report-modal.js
// A simple read-only "OK to dismiss" list modal, styled to match the rest
// of the app. Used for showing scan results (e.g. Find Duplicates) that
// don't need a Yes/No decision - just something to review and close.
//
// showReport(title, items) -> Promise<void>, resolves once dismissed.
//   items: { primary: string, secondary?: string }[]

// See system/dom-bridge.js: bare `document` isn't reliable inside a
// require()'d module on this NW.js build, so every DOM-touching file gets
// it explicitly instead. This `const` shadows the unreliable global for
// the rest of this file.
const document = require('./dom-bridge.js').getDocument();

function showReport(title, items) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    const box = document.createElement('div');
    box.className = 'report-box';

    const titleEl = document.createElement('h2');
    titleEl.className = 'report-title';
    titleEl.textContent = title;
    box.appendChild(titleEl);

    if (items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'report-empty';
      empty.textContent = 'Nothing to report.';
      box.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'report-list';

      for (const item of items) {
        const row = document.createElement('div');
        row.className = 'report-list-item';

        const primary = document.createElement('span');
        primary.textContent = item.primary;
        row.appendChild(primary);

        if (item.secondary) {
          const secondary = document.createElement('span');
          secondary.className = 'report-path';
          secondary.textContent = item.secondary;
          row.appendChild(secondary);
        }

        list.appendChild(row);
      }

      box.appendChild(list);
    }

    const buttons = document.createElement('div');
    buttons.className = 'confirm-buttons';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'btn btn--primary';
    okBtn.textContent = 'OK';
    okBtn.addEventListener('click', () => {
      overlay.remove();
      resolve();
    });
    buttons.appendChild(okBtn);
    box.appendChild(buttons);

    overlay.appendChild(box);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) {
        overlay.remove();
        resolve();
      }
    });

    document.body.appendChild(overlay);
  });
}

module.exports = { showReport };
