import {
  getPdfFirstRightBlank,
  getPdfPageCount,
  getPdfSkipFirstBlank,
  getPdfSplitPageNumbers,
  getPdfSplitMode,
} from "./state.js";

export function getPdfVirtualPages() {
  const total = getPdfPageCount();
  if (total <= 0) return [];
  const split = getPdfSplitMode();
  const splitPageNumbers = getPdfSplitPageNumbers();
  const skip = getPdfSkipFirstBlank();
  const out = [];

  if (!split) {
    const startPage = skip ? 2 : 1;
    for (let i = startPage; i <= total; i += 1) {
      out.push({ pageNum: i, side: "full" });
    }
    return out;
  }

  const startPage = skip ? 2 : 1;
  for (let i = startPage; i <= total; i += 1) {
    const shouldSplitThisPage = splitPageNumbers.size === 0 || splitPageNumbers.has(i);
    if (!shouldSplitThisPage) {
      out.push({ pageNum: i, side: "full" });
      continue;
    }
    if (i === 1 && getPdfFirstRightBlank()) {
      out.push({ pageNum: i, side: "left" });
      continue;
    }
    out.push({ pageNum: i, side: "right" });
    out.push({ pageNum: i, side: "left" });
  }
  return out;
}

export function getPdfVirtualPageCount() {
  return getPdfVirtualPages().length;
}

export function getPdfVirtualPageAt(virtualIndex) {
  const pages = getPdfVirtualPages();
  if (virtualIndex < 0 || virtualIndex >= pages.length) return null;
  return pages[virtualIndex];
}

export function getPdfVirtualIndexForPhysicalPage(pageNum) {
  const pages = getPdfVirtualPages();
  if (pages.length === 0) return 0;
  const idx = pages.findIndex((p) => p.pageNum === pageNum);
  if (idx >= 0) return idx;
  for (let i = pages.length - 1; i >= 0; i -= 1) {
    if (pages[i].pageNum <= pageNum) return i;
  }
  return 0;
}
