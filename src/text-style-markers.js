import {
  getEdit,
  getNewLayersForPsd,
  getPages,
} from "./state.js";

function refPageValue(value) {
  return Number.isInteger(value) ? value : null;
}

function refMatches(layerRef, pageNumber, paragraphIndex) {
  if (!layerRef || !Number.isInteger(layerRef.paragraphIndex)) return false;
  if (layerRef.paragraphIndex !== paragraphIndex) return false;
  const wantedPage = refPageValue(pageNumber);
  const actualPage = refPageValue(layerRef.pageNumber);
  return wantedPage == null || actualPage == null || wantedPage === actualPage;
}

function addIndex(idx, len, out) {
  const n = Number(idx);
  if (!Number.isInteger(n) || n < 0 || n >= len) return;
  out.add(n);
}

function collectOverrideIndexes({ text, defaultSizePt, defaultFont, charSizes, charFonts }) {
  const len = String(text ?? "").length;
  const indexes = new Set();
  const baseSize = Number(defaultSizePt);

  for (const [idx, value] of Object.entries(charSizes ?? {})) {
    const size = Number(value);
    if (!Number.isFinite(size)) continue;
    if (!Number.isFinite(baseSize) || Math.abs(size - baseSize) > 0.01) {
      addIndex(idx, len, indexes);
    }
  }

  for (const [idx, value] of Object.entries(charFonts ?? {})) {
    const font = typeof value === "string" ? value : "";
    if (font && font !== defaultFont) addIndex(idx, len, indexes);
  }

  return indexes;
}

function rangesFromIndexes(indexes) {
  const sorted = [...indexes].sort((a, b) => a - b);
  const ranges = [];
  let start = null;
  let prev = null;
  for (const idx of sorted) {
    if (start == null) {
      start = idx;
      prev = idx;
    } else if (idx === prev + 1) {
      prev = idx;
    } else {
      ranges.push({ start, end: prev + 1 });
      start = idx;
      prev = idx;
    }
  }
  if (start != null) ranges.push({ start, end: prev + 1 });
  return ranges;
}

function mergeRanges(ranges) {
  const indexes = new Set();
  for (const range of ranges) {
    const start = Math.max(0, Math.floor(Number(range.start) || 0));
    const end = Math.max(start, Math.floor(Number(range.end) || 0));
    for (let i = start; i < end; i += 1) indexes.add(i);
  }
  return rangesFromIndexes(indexes);
}

function rangesForNewLayer(layer) {
  const indexes = collectOverrideIndexes({
    text: layer.contents,
    defaultSizePt: layer.sizePt,
    defaultFont: layer.fontPostScriptName ?? null,
    charSizes: layer.charSizes,
    charFonts: layer.charFonts,
  });
  return rangesFromIndexes(indexes);
}

function rangesForExistingLayer(page, layer) {
  const edit = getEdit(page.path, layer.id) ?? {};
  const indexes = collectOverrideIndexes({
    text: edit.contents ?? layer.text,
    defaultSizePt: edit.sizePt ?? layer.fontSize,
    defaultFont: edit.fontPostScriptName ?? layer.font ?? null,
    charSizes: { ...(layer.charSizes ?? {}), ...(edit.charSizes ?? {}) },
    charFonts: edit.charFonts ?? layer.charFonts,
  });
  return rangesFromIndexes(indexes);
}

export function getStyleOverrideRangesForTxtRef(pageNumber, paragraphIndex) {
  const ranges = [];
  for (const page of getPages()) {
    for (const layer of getNewLayersForPsd(page.path)) {
      if (refMatches(layer?.sourceTxtRef, pageNumber, paragraphIndex)) {
        ranges.push(...rangesForNewLayer(layer));
      }
    }
    for (const layer of page.textLayers ?? []) {
      if (refMatches(layer?.sourceTxtRef, pageNumber, paragraphIndex)) {
        ranges.push(...rangesForExistingLayer(page, layer));
      }
    }
  }
  return mergeRanges(ranges);
}

export function appendTextWithStyleMarkers(parent, text, ranges) {
  const value = String(text ?? "");
  const sorted = mergeRanges(ranges ?? []).filter((r) => r.start < value.length);
  let pos = 0;
  for (const range of sorted) {
    const start = Math.max(pos, Math.min(value.length, range.start));
    const end = Math.max(start, Math.min(value.length, range.end));
    if (start > pos) parent.appendChild(document.createTextNode(value.slice(pos, start)));
    if (end > start) {
      const span = document.createElement("span");
      span.className = "text-style-override-marker";
      span.textContent = value.slice(start, end);
      parent.appendChild(span);
    }
    pos = end;
  }
  if (pos < value.length) parent.appendChild(document.createTextNode(value.slice(pos)));
}
