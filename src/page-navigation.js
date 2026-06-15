import {
  getParallelViewMode,
  getPdfSplitMode,
} from "./state.js";
import { getPdfVirtualPageAt, getPdfVirtualPages } from "./pdf-pages.js";

function isSpreadNavigation(source) {
  if (source === "psd") return getParallelViewMode() === "spreadEdit";
  if (source === "pdf") {
    if (!getPdfSplitMode()) return false;
    const pages = getPdfVirtualPages();
    return pages.length > 0 && pages.every((p) => p.side !== "full");
  }
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

// マウスホイールとトラックパッド二本指スクロールを判別する。
// マウスホイール = ページ移動 / トラックパッド = 表示スクロール、へ振り分けるために使う。
// 完全な判別は不可能なので「明確にホイールと言える信号」だけ true を返し、それ以外
// （小さい / 端数 / 横成分ありの連続デルタ）はトラックパッド扱い（= 現状維持のスクロール）にする。
export function isMouseWheelEvent(e) {
  // 行 / ページ単位のデルタはマウスホイール（Chromium ではまれだが念のため）。
  if (e.deltaMode !== 0) return true;
  // 横方向の成分があれば二本指トラックパッドのスクロール。
  if (Math.abs(e.deltaX) > 0) return false;
  const ay = Math.abs(e.deltaY);
  if (ay === 0) return false;
  // マウスホイール 1 ノッチは wheelDeltaY が 120 の倍数（Chromium / WebView2）。
  const wdy = Math.abs(Number(e.wheelDeltaY) || 0);
  if (wdy > 0 && wdy % 120 === 0) return true;
  // フォールバック: 横成分なし・大きめ(>=100)・整数の純縦デルタはホイール扱い。
  return ay >= 100 && Number.isInteger(e.deltaY);
}
