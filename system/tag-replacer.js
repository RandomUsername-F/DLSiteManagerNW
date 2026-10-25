// system/tag-replacer.js
// Find/replace rules for game tags. Rules live in Database/replacementTags.json
// as [{ find, replace }]. Matching is exact per tag, case-insensitive, single
// pass (no chaining). An empty `replace` removes the tag; a comma-separated
// `replace` expands into several tags. Applies to `tags` in both `original`
// and `override`.
//
// Auto mode (Settings -> Custom) runs on every game save via db.js's
// pre-backup hook; manual runs (Utility -> Replace Tags) go through applyToAll().

const fs = require('fs');
const path = require('path');
const db = require('./db.js');

const RULES_PATH = path.join(__dirname, '..', 'Database', 'replacementTags.json');

let rules = [];
let ruleMap = new Map();
let auto = false;

function normalizeRules(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map(r => ({
      find: String((r && r.find) == null ? '' : r.find).trim(),
      replace: String((r && r.replace) == null ? '' : r.replace).trim()
    }))
    .filter(r => r.find !== '');
}

function rebuildMap() {
  ruleMap = new Map();
  for (const r of rules) {
    const key = r.find.toLowerCase();
    if (ruleMap.has(key)) continue; // first rule wins
    ruleMap.set(key, r.replace.split(',').map(s => s.trim()).filter(Boolean));
  }
}

function loadRules() {
  try {
    if (fs.existsSync(RULES_PATH)) {
      rules = normalizeRules(JSON.parse(fs.readFileSync(RULES_PATH, 'utf8')));
    }
  } catch (e) {
    console.error('Failed to read Database/replacementTags.json', e);
    rules = [];
  }
  rebuildMap();
  return getRules();
}

function getRules() {
  return rules.map(r => Object.assign({}, r));
}

function saveRules(list) {
  rules = normalizeRules(list);
  rebuildMap();
  try {
    fs.mkdirSync(path.dirname(RULES_PATH), { recursive: true });
    fs.writeFileSync(RULES_PATH, JSON.stringify(rules, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write Database/replacementTags.json', e);
  }
  return getRules();
}

function setAuto(value) {
  auto = !!value;
}

/** Returns the new tag array, or null if nothing changed. */
function replaceTagList(tags) {
  if (!Array.isArray(tags) || !tags.length || !ruleMap.size) return null;

  const out = [];
  const seen = new Set();
  for (const tag of tags) {
    const replacement = ruleMap.get(String(tag).trim().toLowerCase());
    for (const t of (replacement || [tag])) {
      const k = String(t).trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
  }
  return JSON.stringify(out) === JSON.stringify(tags) ? null : out;
}

/** Mutates the record in place; returns true if anything changed. */
function applyToRecord(record) {
  let changed = false;
  for (const bucket of ['original', 'override']) {
    const obj = record[bucket];
    if (!obj) continue;
    const next = replaceTagList(obj.tags);
    if (next) {
      obj.tags = next;
      changed = true;
    }
  }
  return changed;
}

/** Manual run over every game (ignores the Auto setting). Returns the number of games changed. */
async function applyToAll() {
  const records = await db.db.games.toArray();
  let count = 0;
  for (const record of records) {
    if (applyToRecord(record)) {
      await db.db.games.put(record);
      await db.saveGameBackup(record.productCode, { skipHook: true });
      count++;
    }
  }
  return count;
}

loadRules();
db.setPreBackupHook((record) => auto && applyToRecord(record));

module.exports = { loadRules, getRules, saveRules, setAuto, applyToAll, applyToRecord, replaceTagList, RULES_PATH };
