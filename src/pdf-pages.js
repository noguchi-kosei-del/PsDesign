import {
  getPdfPageCount,
  getPdfSkipFirstBlank,
  getPdfSplitMode,
} from "./state.js";

// 先頭白紙除外 ON のときは split モードに関わらず物理 P1 を除外する。
// 単ページ化 OFF:
//   skip OFF: P1, P2, ... を full 表示
//   skip ON : P2, P3, ... を full 表示
// 単ページ化 ON（横長見開き原稿）:
//   skip OFF: P1 左半分 / P2+ 右半分→左半分（2 仮想ページ）
//   skip ON : P2 左半分 / P3+ 右半分→左半分（P1 を完全に除外）

export function getPdfVirtualPages() {
  const total = getPdfPageCount();
  if (total <= 0) return [];
  const split = getPdfSplitMode();
  const skip = getPdfSkipFirstBlank();
  const startPage = skip ? 2 : 1;
  if (startPage > total) return [];
  const out = [];
  if (!split) {
    for (let i = startPage; i <= total; i++) out.push({ pageNum: i, side: "full" });
    return out;
  }
  // 先頭ページ（startPage）は表紙扱い：左半分のみ
  out.push({ pageNum: startPage, side: "left" });
  // 以降は右→左の 2 仮想ページ
  for (let i = startPage + 1; i <= total; i++) {
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

// 物理ページ番号 → 仮想 index（同一物理ページに複数仮想がある場合は先頭の仮想を返す）。
// 見つからない場合は最も近い前方ページへフォールバック。
export function getPdfVirtualIndexForPhysicalPage(pageNum) {
  const pages = getPdfVirtualPages();
  if (pages.length === 0) return 0;
  const idx = pages.findIndex((p) => p.pageNum === pageNum);
  if (idx >= 0) return idx;
  for (let i = pages.length - 1; i >= 0; i--) {
    if (pages[i].pageNum <= pageNum) return i;
  }
  return 0;
}
