// system/confirm-dialog.js
// A small custom OK/Cancel modal matching the app's visual design,
// used instead of the native window.confirm() (which would look like a
// plain OS dialog box, out of place next to the rest of the UI).
//
// Usage: const confirmed = await confirmDialog('Discard your changes?');

// See system/dom-bridge.js: bare `document` isn't reliable inside a
// require()'d module on this NW.js build, so every DOM-touching file gets
// it explicitly instead. This `const` shadows the unreliable global for
// the rest of this file.
const document = require('./dom-bridge.js').getDocument();

function confirmDialog(message, options) {
  const okLabel = (options && options.okLabel) || 'Discard changes';
  const cancelLabel = (options && options.cancelLabel) || 'Keep editing';

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    const box = document.createElement('div');
    box.className = 'confirm-box';

    const text = document.createElement('p');
    text.className = 'confirm-message';
    text.textContent = message;
    box.appendChild(text);

    const buttons = document.createElement('div');
    buttons.className = 'confirm-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.textContent = cancelLabel;

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'btn btn--primary';
    okBtn.textContent = okLabel;

    buttons.appendChild(cancelBtn);
    buttons.appendChild(okBtn);
    box.appendChild(buttons);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function close(result) {
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
      resolve(result);
    }

    function onKeydown(e) {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter') close(true);
    }

    okBtn.addEventListener('click', () => close(true));
    cancelBtn.addEventListener('click', () => close(false));
    // Clicking the dimmed backdrop (not the box itself) cancels, same as Escape.
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close(false);
    });

    document.addEventListener('keydown', onKeydown);

    // Default focus is the non-destructive option.
    cancelBtn.focus();
  });
}

module.exports = { confirmDialog };
