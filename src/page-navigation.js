import {
  getParallelViewMode,
  getPdfSplitMode,
} from "./state.js";
import { getPdfVirtualPageAt } from "./pdf-pages.js";

function isSpreadNavigation(source) {
  if (source === "psd") return getParallelViewMode() === "spreadEdit";
  if (source === "pdf") return getPdfSplitMode();
  return false;
}

function hasLeadingSinglePage(source) {
  if (source === "psd") return true;
  if (source !== "pdf") return false;
  const first = getPdfVirtualPageAt(0);
  return first?.pageNum === 1 && first?.side === "left";
}

function spreadAnchorIndex(source, current) {
  const idx = Math.max(0, Math.trunc(Number(current) || 0));
  const leadingSingle = hasLeadingSinglePage(source);
  if (leadingSingle && idx <= 0) return 0;
  const firstSpread = leadingSingle ? 1 : 0;
  if (idx <= firstSpread) return firstSpread;
  const offset = idx - firstSpread;
  return firstSpread + offset - (offset % 2);
}

export function nextPageIndexForTurn(source, current, total, delta) {
  const count = Math.max(0, Math.trunc(Number(total) || 0));
  if (count <= 0) return 0;
  const currentIndex = Math.max(0, Math.min(count - 1, Math.trunc(Number(current) || 0)));
  const direction = Math.sign(Number(delta) || 0);
  if (direction === 0) return currentIndex;

  if (!isSpreadNavigation(source)) {
    return Math.max(0, Math.min(count - 1, currentIndex + direction));
  }

  const leadingSingle = hasLeadingSinglePage(source);
  const firstSpread = leadingSingle ? 1 : 0;
  const anchor = spreadAnchorIndex(source, currentIndex);
  let next;
  if (direction > 0) {
    next = leadingSingle && anchor === 0 ? firstSpread : anchor + 2;
  } else {
    next = leadingSingle && anchor <= firstSpread ? 0 : anchor - 2;
  }
  if (next < 0 || next >= count) return currentIndex;
  return next;
}
