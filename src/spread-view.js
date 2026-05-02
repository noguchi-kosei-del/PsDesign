import {
  getCurrentPageIndex,
  getPages,
  getPsdRotation,
  getPsdZoom,
  onPsdRotationChange,
  onPsdZoomChange,
} from "./state.js";
import { mountPageInteraction, refreshAllOverlays, unmountAll } from "./canvas-tools.js";
import { requestRulerRedraw } from "./rulers.js";
import {
  applyOverscrollMargin,
  captureViewportCenterFraction,
  centerCanvasInViewport,
  restoreViewportCenter,
} from "./overscroll.js";

const container = () => document.getElementById("psd-stage");
const pageResizeObservers = new Set();
const pageRedraws = new Set();
let zoomSubscribed = false;
let rotationSubscribed = false;

const MAX_CANVAS_SIDE = 16384;

// ズーム変更時、ビューポート中心にあったキャンバス上のポイントを再描画後も
// ビューポート中心に保つため、redraw 前にキャプチャしておく。
// redraw 内で読み出して新しいスクロール位置を計算 → null へリセット。
// それ以外（リサイズ・回転）の redraw ではこの値は null のままなので副作用なし。
let zoomTransitionCenter = null;

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
      const pageEl = stage ? stage.querySelector(".page") : null;
      zoomTransitionCenter = captureViewportCenterFraction(stage, pageEl);
      try {
        for (const fn of pageRedraws) fn();
      } finally {
        zoomTransitionCenter = null;
      }
    });
  }
  if (!rotationSubscribed) {
    rotationSubscribed = true;
    onPsdRotationChange(() => {
      for (const fn of pageRedraws) fn();
    });
  }
  for (const ro of pageResizeObservers) ro.disconnect();
  pageResizeObservers.clear();
  pageRedraws.clear();
  root.innerHTML = "";
  unmountAll();
  const pages = getPages();
  if (pages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "spreads-empty";
    empty.innerHTML = `
      <svg class="spreads-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
        <text x="12" y="17" font-size="6.5" text-anchor="middle" fill="currentColor" stroke="none" style="font-family: sans-serif; font-weight: 700;">PSD</text>
      </svg>
      <p class="spreads-empty-text">「PSD を開く」で編集したい PSD ファイルを選択、またはこのウィンドウにドロップしてください。</p>
    `;
    root.appendChild(empty);
    return;
  }

  const idx = Math.max(0, Math.min(pages.length - 1, getCurrentPageIndex()));
  const page = pages[idx];
  root.appendChild(buildPage(page, idx, root));
}

export function refreshOverlays() {
  refreshAllOverlays();
}

function buildPage(page, pageIndex, root) {
  const el = document.createElement("div");
  el.className = "page";

  const label = document.createElement("div");
  label.className = "page-label";
  label.textContent = `#${pageIndex + 1}  ${fileName(page.path)}`;
  el.appendChild(label);

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

  const redraw = () => {
    const box = root.getBoundingClientRect();
    const availW = Math.max(0, box.width - 32);
    const availH = Math.max(0, box.height - 32);
    if (availW <= 0 || availH <= 0) return;

    const rotation = getPsdRotation();
    const rotated90 = rotation === 90 || rotation === 270;

    // 回転後の視覚 AR で利用可能領域にフィットするよう算出。
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
    visualW *= zoom;
    visualH *= zoom;

    // canvas 自体の CSS サイズ（= 回転前の寸法）
    const cssW = rotated90 ? visualH : visualW;
    const cssH = rotated90 ? visualW : visualH;

    let dpr = window.devicePixelRatio || 1;
    const maxDpr = Math.min(
      MAX_CANVAS_SIDE / Math.max(1, cssW),
      MAX_CANVAS_SIDE / Math.max(1, cssH),
    );
    if (dpr > maxDpr) dpr = Math.max(1, maxDpr);

    const pxW = Math.max(1, Math.round(cssW * dpr));
    const pxH = Math.max(1, Math.round(cssH * dpr));
    canvas.width = pxW;
    canvas.height = pxH;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;

    // .page は回転後の可視 bbox サイズ、.canvas-wrap は絶対中央配置 + 回転。
    el.style.width = `${visualW}px`;
    el.style.height = `${visualH}px`;
    if (rotation === 0) {
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
      wrap.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
    }

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
    const marginNewlyApplied = applyOverscrollMargin(root, el, visualW, visualH, availW, availH);

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
    if (zoomTransitionCenter) {
      if (hasOverflowAfter) {
        restoreViewportCenter(root, el, zoomTransitionCenter);
      } else {
        root.scrollLeft = 0;
        root.scrollTop = 0;
      }
    } else if (isFirstRedraw || marginNewlyApplied) {
      // 初回 redraw（PSD ロード直後・ページ切替直後）または margin が新規付与された
      // ときは、ステージのスクロール位置が (0,0) で padding 上に乗っており、
      // キャンバスが画面外に押し出されているはず。明示的に中央へ合わせる。
      centerCanvasInViewport(root, el);
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
