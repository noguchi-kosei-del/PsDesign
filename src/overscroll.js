// Photoshop 風のオーバースクロール挙動。
// PSD ステージ (spread-view.js) と PDF / 見本ステージ (pdf-view.js) の両方で共有する。
//
// 仕組み:
//   - キャンバスがステージ（viewport）より大きいとき、`.page` 要素に viewport の
//     OVERSCROLL_FRACTION 倍の margin を付与してスクロール可能領域を広げる。
//     これでキャンバスを画面端ぎりぎりまで寄せて配置できる（Photoshop と同じ挙動）。
//   - ズーム変更時のみ、redraw 前に「viewport 中心にあったキャンバス上の点」を
//     captureViewportCenterFraction でキャプチャ → 新サイズに合わせて
//     restoreViewportCenter でスクロール位置を再計算 → ズーム前後で同じ点を
//     画面中央に保つ。リサイズ・回転・ページ送りでは触らない。

// ステージ幅・高さに対する margin 比率。Photoshop の感覚に合わせて 0.85。
// 0.5 = 控えめ / 1.0 = キャンバスを完全に画面外まで送れる。
export const OVERSCROLL_FRACTION = 0.85;

export function captureViewportCenterFraction(stage, pageEl) {
  if (!stage || !pageEl) return null;
  const r = pageEl.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  const vcX = sr.left + stage.clientWidth / 2;
  const vcY = sr.top + stage.clientHeight / 2;
  return {
    fracX: (vcX - r.left) / r.width,
    fracY: (vcY - r.top) / r.height,
  };
}

// margin 設定は副作用として行い、戻り値は「margin が今回新規に付いたか」を示す。
// 戻り値 true は「直前は margin なし → 今回 margin あり」への遷移、つまり通常の
// scroll(0,0) では canvas が見切れる状態。呼び出し側はこの戻り値を見て
// centerCanvasInViewport で再センタリングするとよい（既に margin がある場合は
// ユーザーのスクロール位置を尊重する）。
//
// availW / availH（任意）は「スクロールバー無しの viewport 寸法」。省略時は
// stage.clientWidth/Height にフォールバックするが、ズーム遷移直後のように
// スクロールバーぶん clientWidth が削られている瞬間に呼ばれると過剰判定になり、
// 「ズーム=1 なのに margin が付いてキャンバスが見切れる」事故が起きる。
// pdf-view.js / spread-view.js では box.width-32 として算出した availW/H を渡す。
export function applyOverscrollMargin(stage, pageEl, visualW, visualH, availW, availH) {
  if (!stage || !pageEl) return false;
  const w = (typeof availW === "number" && availW > 0) ? availW : stage.clientWidth;
  const h = (typeof availH === "number" && availH > 0) ? availH : stage.clientHeight;
  const overflowsX = visualW > w;
  const overflowsY = visualH > h;
  const padX = overflowsX ? Math.round(w * OVERSCROLL_FRACTION) : 0;
  const padY = overflowsY ? Math.round(h * OVERSCROLL_FRACTION) : 0;
  // hadMargin: 直前に何らかの margin が style として設定されていたかどうか。
  // pageEl.style.marginLeft は inline style のみを返す（CSS シートの値は返さない）。
  const hadMargin = !!(pageEl.style.marginLeft || pageEl.style.marginTop);
  const willHaveMargin = padX > 0 || padY > 0;
  if (willHaveMargin) {
    pageEl.style.margin = `${padY}px ${padX}px`;
  } else {
    pageEl.style.margin = "";
  }
  return willHaveMargin && !hadMargin;
}

// キャンバス中央を viewport 中央に合わせるようスクロール位置を設定。
// 初回表示やページ切替直後など、スクロールが (0, 0) のままだと overscroll margin
// のぶんキャンバスが画面外に押し出されてしまうケース用。
export function centerCanvasInViewport(stage, pageEl) {
  if (!stage || !pageEl) return;
  const r = pageEl.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return;
  const canvasLeftInScroll = r.left - sr.left + stage.scrollLeft;
  const canvasTopInScroll = r.top - sr.top + stage.scrollTop;
  const canvasCenterX = canvasLeftInScroll + r.width / 2;
  const canvasCenterY = canvasTopInScroll + r.height / 2;
  const maxScrollX = Math.max(0, stage.scrollWidth - stage.clientWidth);
  const maxScrollY = Math.max(0, stage.scrollHeight - stage.clientHeight);
  stage.scrollLeft = Math.max(0, Math.min(maxScrollX, Math.round(canvasCenterX - stage.clientWidth / 2)));
  stage.scrollTop = Math.max(0, Math.min(maxScrollY, Math.round(canvasCenterY - stage.clientHeight / 2)));
}

export function restoreViewportCenter(stage, pageEl, frac) {
  if (!stage || !pageEl || !frac) return;
  // レイアウト確定後の getBoundingClientRect で実位置を取得し、
  // キャンバス相対 (fracX, fracY) のポイントを viewport 中心に合わせる。
  const r = pageEl.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  const w = r.width;
  const h = r.height;
  if (w <= 0 || h <= 0) return;
  const canvasLeftInScroll = r.left - sr.left + stage.scrollLeft;
  const canvasTopInScroll = r.top - sr.top + stage.scrollTop;
  const targetX = canvasLeftInScroll + frac.fracX * w;
  const targetY = canvasTopInScroll + frac.fracY * h;
  const maxScrollX = Math.max(0, stage.scrollWidth - stage.clientWidth);
  const maxScrollY = Math.max(0, stage.scrollHeight - stage.clientHeight);
  stage.scrollLeft = Math.max(0, Math.min(maxScrollX, Math.round(targetX - stage.clientWidth / 2)));
  stage.scrollTop = Math.max(0, Math.min(maxScrollY, Math.round(targetY - stage.clientHeight / 2)));
}
