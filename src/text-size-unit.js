const TEXT_SIZE_UNIT_KEY = "psdesign_text_size_unit";
const PT_PER_Q = 72 / 25.4 * 0.25;
const listeners = new Set();

export function normalizeTextSizeUnit(unit) {
  return unit === "q" ? "q" : "pt";
}

export function getTextSizeUnit() {
  try {
    return normalizeTextSizeUnit(localStorage.getItem(TEXT_SIZE_UNIT_KEY));
  } catch (_) {
    return "pt";
  }
}

export function setTextSizeUnit(unit) {
  const next = normalizeTextSizeUnit(unit);
  const prev = getTextSizeUnit();
  if (prev === next) return;
  try {
    localStorage.setItem(TEXT_SIZE_UNIT_KEY, next);
  } catch (_) {}
  for (const fn of listeners) fn(next);
}

export function onTextSizeUnitChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function textSizeUnitLabel(unit = getTextSizeUnit()) {
  return normalizeTextSizeUnit(unit) === "q" ? "級" : "pt";
}

export function textSizePtToUnitValue(pt, unit = getTextSizeUnit()) {
  const n = Number(pt);
  if (!Number.isFinite(n)) return null;
  return normalizeTextSizeUnit(unit) === "q" ? n / PT_PER_Q : n;
}

export function textSizeUnitValueToPt(value, unit = getTextSizeUnit()) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return normalizeTextSizeUnit(unit) === "q" ? n * PT_PER_Q : n;
}

export function formatTextSizeUnitValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  const rounded = Math.round(n * 100) / 100;
  return String(rounded).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

export function formatTextSizePt(pt, unit = getTextSizeUnit(), withUnit = false) {
  const converted = textSizePtToUnitValue(pt, unit);
  if (converted == null) return "";
  const value = formatTextSizeUnitValue(converted);
  return withUnit ? `${value}${textSizeUnitLabel(unit)}` : value;
}
