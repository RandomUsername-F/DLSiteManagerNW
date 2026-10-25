// system/context-menu.js
// Small reusable right-click menu, positioned at the cursor and kept
// on-screen, closed on any outside click or Escape.
//
// showContextMenu(x, y, items) - items: { label, onClick, title?,
// disabled?, separator? }[]. A `separator: true` entry renders a divider
// instead of a button (other fields ignored for it).

const document = require('./dom-bridge.js').getDocument();
const window = require('./dom-bridge.js').getWindow();

function showContextMenu(x, y, items) {
  const existing = document.getElementById('app-context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.id = 'app-context-menu';
  menu.className = 'context-menu';

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      menu.appendChild(sep);
      continue;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'context-menu-item';
    btn.textContent = item.label;
    if (item.title) btn.title = item.title;

    if (item.disabled) {
      btn.disabled = true;
    } else {
      btn.addEventListener('click', () => {
        menu.remove();
        item.onClick();
      });
    }
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 8));
  const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 8));
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  function close(e) {
    if (e && menu.contains(e.target)) return;
    menu.remove();
    document.removeEventListener('mousedown', close);
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  // Deferred so the same click/contextmenu event that opened this menu
  // doesn't immediately trigger its own close handler.
  setTimeout(() => {
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
  }, 0);
}

module.exports = { showContextMenu };
