// system/font-scale.js
// Scales the app's TEXT only (Ctrl + / Ctrl -), leaving layout, images and
// every other pixel size alone.
//
// How: the stylesheets use fixed px font sizes, so this reads
// system/style.css (plus the active theme file from system/styles/) and
// generates one extra <style> block that re-declares ONLY the font-size of
// every rule that has one, as `calc(<original>px * var(--font-scale, 1))`.
// It sits after the real stylesheets so it wins, and changing the scale is
// then just updating the --font-scale variable on <html>. Nothing in the
// original CSS files needs to change, and new font-size rules added to them
// are picked up automatically.

const fs = require('fs');
const path = require('path');
const document = require('./dom-bridge.js').getDocument();

const BASE_CSS = path.join(__dirname, 'style.css');
const STYLES_DIR = path.join(__dirname, 'styles');

const MIN_SCALE = 0.6;
const MAX_SCALE = 2.0;

let scale = 1;
let themeName = 'dark';
let styleEl = null;

/** `selector { font-size: calc(Npx * var(--font-scale, 1)); }` for every plain rule declaring a px font-size. */
function buildOverrides(cssText) {
  const out = [];
  const text = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = rule.exec(text))) {
    const selector = m[1].trim();
    if (!selector || selector.startsWith('@')) continue; // at-rule headers (@media ...) are never the selector of a plain rule
    const size = /font-size\s*:\s*(\d+(?:\.\d+)?)px/.exec(m[2]);
    if (size) out.push(`${selector} { font-size: calc(${size[1]}px * var(--font-scale, 1)); }`);
  }
  return out.join('\n');
}

function readSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return '';
  }
}

function rebuild() {
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'font-scale-overrides';
  }

  let css = buildOverrides(readSafe(BASE_CSS));
  if (themeName && themeName !== 'dark') {
    css += '\n' + buildOverrides(readSafe(path.join(STYLES_DIR, themeName)));
  }
  styleEl.textContent = css;

  // (Re)append so it stays the LAST stylesheet in <head>, after the theme link.
  document.head.appendChild(styleEl);
}

/** Call when the active UI style changes ('dark' or a file name in system/styles/). */
function setTheme(name) {
  themeName = name || 'dark';
  rebuild();
}

function setScale(value) {
  scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(value * 100) / 100));
  document.documentElement.style.setProperty('--font-scale', String(scale));
  if (!styleEl) rebuild();
  return scale;
}

function getScale() {
  return scale;
}

module.exports = { setTheme, setScale, getScale, MIN_SCALE, MAX_SCALE };
