import {
  getCurrentPageIndex,
  getPages,
  getParallelViewMode,
  getPsdRotation,
  getPsdZoom,
  onParallelViewModeChange,
  onPsdRotationChange,
  onPsdZoomChange,
} from "./state.js";
import { mountPageInteraction, refreshAllOverlays, unmountAll } from "./canvas-tools.js";
import { requestRulerRedraw } from "./rulers.js";
import {
  applyOverscrollMargin,
  captureViewportCenterFraction,
  captureViewportPointFraction,
  centerCanvasInViewport,
  restoreViewportCenter,
  restoreViewportPoint,
} from "./overscroll.js";
import { getCanvasDprCap } from "./memory-mode.js";

const container = () => document.getElementById("psd-stage");
const pageResizeObservers = new Set();
const pageRedraws = new Set();
let zoomSubscribed = false;
let rotationSubscribed = false;
let viewModeSubscribed = false;

const MAX_CANVAS_SIDE = 16384;
export const PSD_FIT_BASE_SCALE = 1.1;
export const PSD_FIT_ZOOM = 1;
const PSD_SPREAD_GAP = 0;

function isSpreadEditMode() {
  return getParallelViewMode() === "spreadEdit";
}

function viewportTarget(root = container()) {
  return root?.querySelector(".psd-view-target") || root?.querySelector(".page") || null;
}

// ズーム変更時、ビューポート中心にあったキャンバス上のポイントを再描画後も
// ビューポート中心に保つため、redraw 前にキャプチャしておく。
// redraw 内で読み出して新しいスクロール位置を計算 → null へリセット。
// それ以外（リサイズ・回転）の redraw ではこの値は null のままなので副作用なし。
let zoomTransitionCenter = null;
let zoomTransitionAnchor = null;
let resetZoomToStart = false;
let resetZoomDuringRedraw = false;

function centerCurrentPageInStage() {
  const root = container();
  const target = viewportTarget(root);
  if (!root || !target) return;
  centerCanvasInViewport(root, target);
}

function restoreCurrentPageCenter(center) {
  const root = container();
  const target = viewportTarget(root);
  if (!root || !target || !center) return;
  restoreViewportCenter(root, target, center);
}

export function capturePsdViewportCenter() {
  const root = container();
  return captureViewportCenterFraction(root, viewportTarget(root));
}

export function setNextPsdZoomAnchorFromClientPoint(clientX, clientY) {
  const root = container();
  zoomTransitionAnchor = captureViewportPointFraction(root, viewportTarget(root), clientX, clientY);
}

function refreshPsdStageLayout({ recenter = true, viewportCenter = null } = {}) {
  for (const fn of pageRedraws) fn();
  if (viewportCenter) restoreCurrentPageCenter(viewportCenter);
  else if (recenter) centerCurrentPageInStage();
}

export function schedulePsdStageLayoutRefresh({ durationMs = 360, recenter = true, viewportCenter = null } = {}) {
  const center = viewportCenter ?? (recenter ? null : capturePsdViewportCenter());
  const run = () => refreshPsdStageLayout({ recenter, viewportCenter: center });
  requestAnimationFrame(run);
  requestAnimationFrame(() => requestAnimationFrame(run));
  setTimeout(run, 80);
  setTimeout(run, Math.max(120, durationMs + 50));
}

export function resetPsdViewportToStart() {
  resetZoomToStart = true;
  const run = () => {
    const root = container();
    const target = viewportTarget(root);
    // setPsdZoom() は同じ倍率では change event を出さない。
    // 閲覧モード後の Ctrl+0 のように倍率は 100% のままでもステージ幅だけが
    // 通常表示へ戻っている場合があるため、リセット時は必ず redraw して寸法を再計算する。
    for (const fn of pageRedraws) fn();
    // Ctrl+0 はキャンバスを viewport 中央へ寄せる（PDF ペインと同方針）。
    // 旧 alignCanvasStartInViewport は左上に貼り付くため中央に寄らない不具合があった。
    centerCanvasInViewport(root, viewportTarget(root) || target);
    resetZoomToStart = false;
  };
  requestAnimationFrame(run);
  requestAnimationFrame(() => requestAnimationFrame(run));
  setTimeout(run, 80);
  setTimeout(run, 460);
}

export function renderAllSpreads() {
  const root = container();
  if (!root) return;
  if (!zoomSubscribed) {
    zoomSubscribed = true;
    onPsdZoomChange(() => {
      // redraw が走る前に「viewport 中心にあったキャンバス上のポイント」をキャプチャ。
      // redraw 内でこれを読み、新しいキャンバスサイズ + overscroll マージンに合わせて
      // スクロールを再計算する。これでズーム前後で同じ点が画面中央に保たれる。
      const stage = container();
      const target = viewportTarget(stage);
      resetZoomDuringRedraw = resetZoomToStart;
      resetZoomToStart = false;
      zoomTransitionCenter = resetZoomDuringRedraw
        ? null
        : (zoomTransitionAnchor ?? captureViewportCenterFraction(stage, target));
      try {
        for (const fn of pageRedraws) fn();
      } finally {
        zoomTransitionCenter = null;
        zoomTransitionAnchor = null;
        resetZoomDuringRedraw = false;
      }
    });
  }
  if (!rotationSubscribed) {
    rotationSubscribed = true;
    onPsdRotationChange(() => {
      for (const fn of pageRedraws) fn();
    });
  }
  if (!viewModeSubscribed) {
    viewModeSubscribed = true;
    onParallelViewModeChange(() => renderAllSpreads());
  }
  for (const ro of pageResizeObservers) ro.disconnect();
  pageResizeObservers.clear();
  pageRedraws.clear();
  root.innerHTML = "";
  root.classList.remove("psd-spread-edit-mode");
  unmountAll();
  const pages = getPages();
  // ステージ上部ラベル（ペイン上部の固定バー）の更新。空状態ではテキストもクリア。
  const psdLabelEl = document.getElementById("psd-stage-label");
  if (pages.length === 0) {
    if (psdLabelEl) psdLabelEl.textContent = "";
    return;
  }

  const idx = Math.max(0, Math.min(pages.length - 1, getCurrentPageIndex()));
  const spreadMode = isSpreadEditMode();
  root.classList.toggle("psd-spread-edit-mode", spreadMode);
  if (spreadMode) {
    const slots = psdSpreadSlots(pages, idx);
    if (psdLabelEl) psdLabelEl.textContent = truncateLabel(psdSpreadLabel(slots));
    const spread = document.createElement("div");
    spread.className = "psd-spread-view psd-view-target";
    spread.dataset.currentPageIndex = String(idx);
    root.appendChild(spread);
    for (const slot of slots) {
      if (slot.blank) {
        spread.appendChild(buildBlankPage(slot.template, root, {
          fitSlots: 2,
          viewportTarget: spread,
        }));
      } else {
        spread.appendChild(buildPage(slot.page, slot.index, root, {
          fitSlots: 2,
          viewportTarget: spread,
          applyOverscroll: false,
          current: slot.index === idx,
        }));
      }
    }
    return;
  }

  const page = pages[idx];
  if (psdLabelEl) psdLabelEl.textContent = truncateLabel(`P${pageNumLabel(idx + 1)}${splitSideLabel(page)}  ${fileName(page.sourcePath ?? page.path)}`);
  root.appendChild(buildPage(page, idx, root, { current: true }));
}

function psdSpreadSlots(pages, idx) {
  if (idx <= 0) {
    return [
      { page: pages[0], index: 0, blank: false },
      { template: pages[0], index: null, blank: true },
    ];
  }
  // 右綴じ想定: 視覚上は [左ページ(後のページ), 右ページ(前のページ)]。
  // P02/P03 は [P03, P02]、最終ページが片側だけなら右側に置いて左側を白紙にする。
  const right = idx % 2 === 1 ? idx : idx - 1;
  const left = right + 1;
  return [
    pages[left]
      ? { page: pages[left], index: left, blank: false }
      : { template: pages[right], index: null, blank: true },
    { page: pages[right], index: right, blank: false },
  ];
}

function psdSpreadLabel(slots) {
  const visible = slots.filter((slot) => !slot.blank);
  if (visible.length === 0) return "";
  if (visible.length === 1) {
    const slot = visible[0];
    return `見開き編集 P${pageNumLabel(slot.index + 1)}  ${fileName(slot.page.path)}`;
  }
  const indices = visible.map((slot) => slot.index).sort((a, b) => a - b);
  return `見開き編集 P${pageNumLabel(indices[0] + 1)}-P${pageNumLabel(indices[indices.length - 1] + 1)}`;
}

/* ページ番号は最低 2 桁ゼロ埋め（P01 / P10 / P100）。 */
function pageNumLabel(n) {
  return String(n).padStart(2, "0");
}

/* ステージ上部バーのラベル文字数上限。30 文字を超えたら末尾を `…` に置換する。
   `…` 自体を 1 文字として数える方針：max 30 のとき先頭 29 文字 + `…` = 30 文字。 */
const LABEL_MAX_CHARS = 30;
function truncateLabel(text) {
  if (typeof text !== "string") return "";
  // Array.from で surrogate pair（絵文字等）を 1 文字単位で扱う。
  const chars = Array.from(text);
  if (chars.length <= LABEL_MAX_CHARS) return text;
  return chars.slice(0, LABEL_MAX_CHARS - 1).join("") + "…";
}

export function getCurrentPsdPageDisplaySize() {
  const root = container();
  const pages = getPages();
  if (!root || pages.length === 0) return null;
  const idx = Math.max(0, Math.min(pages.length - 1, getCurrentPageIndex()));
  const metrics = computePageMetrics(pages[idx], root, 1);
  if (!metrics) return null;
  return {
    width: metrics.visualW,
    height: metrics.visualH,
    canvasWidth: metrics.cssW,
    canvasHeight: metrics.cssH,
    rotation: metrics.rotation,
  };
}

function computePageMetrics(page, root, fitSlots = 1) {
  const box = root.getBoundingClientRect();
  const totalGap = fitSlots > 1 ? PSD_SPREAD_GAP * (fitSlots - 1) : 0;
  const availW = Math.max(0, (box.width - 32 - totalGap) / Math.max(1, fitSlots));
  const availH = Math.max(0, box.height - 32);
  if (availW <= 0 || availH <= 0) return null;

  const rotation = getPsdRotation();
  const rotated90 = rotation === 90 || rotation === 270;
  const pageAR = page.width / page.height;
  const visualAR = rotated90 ? 1 / pageAR : pageAR;
  const availAR = availW / availH;
  let visualW;
  let visualH;
  if (visualAR >= availAR) {
    visualW = availW;
    visualH = availW / visualAR;
  } else {
    visualH = availH;
    visualW = availH * visualAR;
  }

  const zoom = getPsdZoom();
  // 単ページは PSD_FIT_BASE_SCALE (= 1.1) で初期表示を 110% に拡大して読みやすくする
  // （オーバースクロール演出も兼ねる）。見開きは横幅を 2 スロットで使い切るため、
  // 1.1 倍だと box.width × 1.1 がコンテナを超えて見切れる。見開き時のみ 1.0 で
  // ぴったりフィット表示にする。
  const baseScale = fitSlots > 1 ? 1.0 : PSD_FIT_BASE_SCALE;
  visualW *= baseScale * zoom;
  visualH *= baseScale * zoom;

  const cssW = rotated90 ? visualH : visualW;
  const cssH = rotated90 ? visualW : visualH;

  let dpr = Math.min(window.devicePixelRatio || 1, getCanvasDprCap());
  const maxDpr = Math.min(
    MAX_CANVAS_SIDE / Math.max(1, cssW),
    MAX_CANVAS_SIDE / Math.max(1, cssH),
  );
  if (dpr > maxDpr) dpr = Math.max(1, maxDpr);

  return {
    availW,
    availH,
    cssW,
    cssH,
    dpr,
    pxW: Math.max(1, Math.round(cssW * dpr)),
    pxH: Math.max(1, Math.round(cssH * dpr)),
    rotation,
    visualW,
    visualH,
  };
}

function applyPageGeometry(el, wrap, metrics) {
  el.style.width = `${metrics.visualW}px`;
  el.style.height = `${metrics.visualH}px`;
  if (!wrap) return;
  if (metrics.rotation === 0) {
    wrap.style.position = "";
    wrap.style.left = "";
    wrap.style.top = "";
    wrap.style.transform = "";
    wrap.style.transformOrigin = "";
  } else {
    wrap.style.position = "absolute";
    wrap.style.left = "50%";
    wrap.style.top = "50%";
    wrap.style.transformOrigin = "center center";
    wrap.style.transform = `translate(-50%, -50%) rotate(${metrics.rotation}deg)`;
  }
}

function buildBlankPage(templatePage, root, options = {}) {
  const { fitSlots = 1, viewportTarget = null } = options;
  const el = document.createElement("div");
  el.className = "page psd-blank-page";
  let isFirstRedraw = true;
  let lastStageWidth = null;
  let lastStageHeight = null;
  const redraw = () => {
    const box = root.getBoundingClientRect();
    const stageSizeChanged = lastStageWidth != null && lastStageHeight != null
      && (Math.abs(box.width - lastStageWidth) > 0.5 || Math.abs(box.height - lastStageHeight) > 0.5);
    lastStageWidth = box.width;
    lastStageHeight = box.height;
    const metrics = computePageMetrics(templatePage, root, fitSlots);
    if (!metrics) return;
    applyPageGeometry(el, null, metrics);
    const target = viewportTarget || el;
    if (resetZoomDuringRedraw) {
      centerCanvasInViewport(root, target);
    } else if (zoomTransitionCenter) {
      restoreViewportCenter(root, target, zoomTransitionCenter);
    } else if (stageSizeChanged || isFirstRedraw) {
      centerCanvasInViewport(root, target);
    }
    isFirstRedraw = false;
  };
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => redraw());
    ro.observe(root);
    pageResizeObservers.add(ro);
  }
  pageRedraws.add(redraw);
  queueMicrotask(redraw);
  return el;
}

function buildPage(page, pageIndex, root, options = {}) {
  const {
    fitSlots = 1,
    viewportTarget = null,
    applyOverscroll = true,
    current = false,
  } = options;
  const el = document.createElement("div");
  el.className = "page";
  el.classList.toggle("psd-current-page", current);

  // ラベルはペイン上部の `.stage-label-bar > #psd-stage-label` に表示。
  // ステージ内の `.page` 直下に浮かべる旧方式は廃止し、renderAllSpreads 側で
  // 現在ページ index に対応する文字列をバーへ書き込む。

  const wrap = document.createElement("div");
  wrap.className = "canvas-wrap";

  const canvas = document.createElement("canvas");
  canvas.dataset.pageIndex = String(pageIndex);

  const overlay = document.createElement("div");
  overlay.className = "page-overlay";

  // 当該 .page 要素にとっての「初回 redraw」フラグ。renderAllSpreads が
  // root.innerHTML="" でステージを破棄して buildPage を呼び直すたびに
  // 新しいクロージャで true で始まり、初回 redraw 後に false へ。
  // 初回 + overscroll margin 適用時は scroll(0,0) が padding 領域に乗ってしまう
  // ので、明示的にキャンバス中央へスクロールを合わせる。
  let isFirstRedraw = true;
  let lastStageWidth = null;
  let lastStageHeight = null;

  const redraw = () => {
    const box = root.getBoundingClientRect();
    const stageSizeChanged = lastStageWidth != null && lastStageHeight != null
      && (Math.abs(box.width - lastStageWidth) > 0.5 || Math.abs(box.height - lastStageHeight) > 0.5);
    lastStageWidth = box.width;
    lastStageHeight = box.height;
    const metrics = computePageMetrics(page, root, fitSlots);
    if (!metrics) return;
    const { availW, availH, cssW, cssH, dpr, pxW, pxH, visualW, visualH } = metrics;
    canvas.width = pxW;
    canvas.height = pxH;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;

    // .page は回転後の可視 bbox サイズ、.canvas-wrap は絶対中央配置 + 回転。
    applyPageGeometry(el, wrap, metrics);

    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (page.canvas) {
      ctx.drawImage(page.canvas, 0, 0, pxW, pxH);
    } else {
      ctx.fillStyle = "#444";
      ctx.fillRect(0, 0, pxW, pxH);
      ctx.fillStyle = "#bbb";
      ctx.font = `${Math.round(18 * dpr)}px sans-serif`;
      ctx.fillText("（合成プレビューなし）", 16 * dpr, 32 * dpr);
    }
    // オーバースクロール用のマージンを .page に付与。これで scroll content がキャンバス
    // サイズ＋viewport の OVERSCROLL_FRACTION 倍分まで広がり、Photoshop のように
    // キャンバスを画面端まで寄せられる。サイズが viewport より小さいときは 0。
    // 戻り値 true は「margin が今回新規に付いた」（直前は無し）→ scroll(0,0) では
    // キャンバスが画面外に押し出される状態なので、後段で再センタリングする。
    // availW/availH を渡してスクロールバー非依存に overflow 判定させる
    // （root.clientWidth はズーム中のスクロールバー分削られるので Ctrl+0 直後に誤判定する）。
    const target = viewportTarget || el;
    const marginNewlyApplied = applyOverscroll
      ? applyOverscrollMargin(root, target, visualW, visualH, availW, availH)
      : false;

    // ズーム変更時のみ、redraw 前にキャプチャした「viewport 中心のキャンバス相対座標」を
    // 新サイズで再計算してスクロールを復元する。リサイズや回転の redraw では null なので
    // 何もしない（ブラウザが既存スクロール位置を維持）。
    // 例外: ズーム後に overflow が解消した場合（Ctrl+0 で 100% に戻すなど）は
    // frac ベースの再計算が無意味なので、scroll を 0 に戻して flex の安全中央寄せに任せる。
    //
    // 比較に root.clientWidth/Height を使うとズームイン時のスクロールバーぶん clientWidth が
    // 削られて誤判定する可能性がある（pdf-view.js 参照）。代わりに availW/availH（=
    // box.width/height - 32、スクロールバー非依存）を使う。zoom ≤ 1 では visualW ≤ availW
    // が保証される。
    const hasOverflowAfter = visualW > availW || visualH > availH;
    if (resetZoomDuringRedraw) {
      // Ctrl+0 リセットはキャンバスを viewport 中央へ（左上貼り付きを解消、PDF と統一）。
      centerCanvasInViewport(root, target);
    } else if (zoomTransitionCenter) {
      if (hasOverflowAfter) {
        if (Number.isFinite(zoomTransitionCenter.offsetX) && Number.isFinite(zoomTransitionCenter.offsetY)) {
          restoreViewportPoint(root, target, zoomTransitionCenter);
        } else {
          restoreViewportCenter(root, target, zoomTransitionCenter);
        }
      } else {
        root.scrollLeft = 0;
        root.scrollTop = 0;
      }
    } else if (stageSizeChanged) {
      centerCanvasInViewport(root, target);
    } else if (isFirstRedraw || marginNewlyApplied) {
      // 初回 redraw（PSD ロード直後・ページ切替直後）または margin が新規付与された
      // ときは、ステージのスクロール位置が (0,0) で padding 上に乗っており、
      // キャンバスが画面外に押し出されているはず。明示的に中央へ合わせる。
      centerCanvasInViewport(root, target);
    }
    isFirstRedraw = false;

    refreshAllOverlays();
    // ページ DOM が再構築/再描画されるたびにルーラーとガイドの座標投影をやり直す。
    requestRulerRedraw();
  };

  wrap.appendChild(canvas);
  wrap.appendChild(overlay);
  el.appendChild(wrap);

  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => redraw());
    ro.observe(root);
    pageResizeObservers.add(ro);
  }
  pageRedraws.add(redraw);

  queueMicrotask(redraw);

  mountPageInteraction({ pageEl: el, canvas, overlay, page, pageIndex });

  return el;
}

function fileName(p) {
  if (!p) return "";
  const m = p.match(/[\\/]([^\\/]+)$/);
  return m ? m[1] : p;
}

function splitSideLabel(page) {
  if (page?.splitSide === "right") return "右";
  if (page?.splitSide === "left") return "左";
  return "";
}
