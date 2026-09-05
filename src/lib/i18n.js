const strings = require('../../data/i18n.json');

const LANGS = strings._languages.map((l) => l.code);
const DEFAULT_LANG = 'en';

function normaliseLang(lang) {
  return LANGS.includes(lang) ? lang : DEFAULT_LANG;
}

/**
 * Look up a UI/engine string. Falls back to English, then to the key itself,
 * so a missing translation degrades to readable text rather than "undefined".
 */
function t(lang, key, vars) {
  const l = normaliseLang(lang);
  let out = (strings[l] && strings[l][key]) || strings[DEFAULT_LANG][key] || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.split(`{${k}}`).join(v);
    }
  }
  return out;
}

/**
 * Pick a language variant out of a content object like
 * { en: "...", zh: "...", ms: "...", ta: "..." }.
 * Accepts plain strings and arrays too, so callers don't need to type-check.
 */
function pick(value, lang) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || Array.isArray(value)) return value;
  if (typeof value !== 'object') return value;
  const l = normaliseLang(lang);
  if (l in value) return value[l];
  if (DEFAULT_LANG in value) return value[DEFAULT_LANG];
  return value;
}

function languages() {
  return strings._languages;
}

module.exports = { t, pick, languages, normaliseLang, LANGS, DEFAULT_LANG };
