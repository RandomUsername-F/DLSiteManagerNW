// system/dom-bridge.js
// Central, explicit source of truth for `document`/`window`.
//
// Root cause this works around: on this NW.js build, bare `document`/
// `window` identifiers referenced from within a require()'d CommonJS
// module do NOT reliably resolve to the same objects as the real page's
// `document`/`window` (confirmed: `window !== global.window` and
// `document !== global.document` here) - even though app.js's own
// top-level script code, loaded via <script src>, sees the correct ones.
//
// Fix: app.js calls init(window, document) with its own known-correct
// references, before requiring anything else. Every other module that
// touches the DOM does:
//   const document = require('./dom-bridge.js').getDocument();
// at its own top level. That's a normal JS `const` declaration, so it
// shadows the (unreliable) global `document` for the rest of that file -
// no other line in the file needs to change.

let _window = null;
let _document = null;

function init(win, doc) {
  _window = win;
  _document = doc;
}

function getWindow() {
  if (!_window) {
    throw new Error('dom-bridge: getWindow() called before init() - app.js must call init() before requiring anything that needs the DOM.');
  }
  return _window;
}

function getDocument() {
  if (!_document) {
    throw new Error('dom-bridge: getDocument() called before init() - app.js must call init() before requiring anything that needs the DOM.');
  }
  return _document;
}

module.exports = { init, getWindow, getDocument };
