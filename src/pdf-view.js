import {
  getPdfDoc,
  getPdfPageIndex,
  getPdfPath,
  getPdfRotation,
  getPdfZoom,
  getEditorLeftPaneMode,
  getParallelViewMode,
  getTool,
  onEditorLeftPaneModeChange,
  onPageIndexChange,
  onParallelViewModeChange,
  onPdfChange,
  onPdfFirstRightBlankChange,
  onPdfPageIndexChange,
  onPdfRotationChange,
  onPdfSkipFirstBlankChange,
  onPdfSplitModeChange,
  onPdfSplitPageNumbersChange,
  onPdfZoomChange,
  onPsdRotationChange,
  onPsdZoomChange,
  onToolChange,
} from "./state.js";
import {
  getPdfVirtualPageAt,
  getPdfVirtualPageCount,
} from "./pdf-pages.js";
import { getCurrentPsdPageDisplaySize } from "./spread-view.js";
import {
  applyOverscrollMargin,
  captureViewportCenterFraction,
  captureViewportPointFraction,
  centerCanvasInViewport,
  restoreViewportCenter,
  restoreViewportPoint,
} from "./overscroll.js";
import { getCanvasDprCap } from "./memory-mode.js";

const MAX_CANVAS_SIDE = 16384;
export const PDF_FIT_BASE_SCALE = 1.1;
export const PDF_FIT_ZOOM = 1;

let mounted = false;
let rootEl = null;
let stageEl = null;
let pageWrap = null;
let labelEl = null;
let canvas = null;
let emptyEl = null;
let outOfRangeEl = null;
let renderToken = 0;
let pendingRaf = 0;
// ResizeObserver 経由 redraw の trailing debounce タイマー。連続リサイズ（CSS width
// トランジション / ウインドウドラッグ）中は最後の 1 回だけ pdfjs を再レンダする。
let resizeRedrawTimer = 0;
// 進行中の pdfjs RenderTask。連打で新しい redraw が走るときに .cancel() を呼んで
// 古いレンダ計算を即停止する（呼ばないと CPU を食い続け、連打中に 30 件以上の
// レンダタスクが裏で並行進行してラグの原因になる）。
let currentRenderTask = null;
// ズーム変更時のみ「viewport 中心にあったキャンバス上の点」を保持して、redraw 後に
// 新しいキャンバスサイズで同じ点が中央に来るようスクロールを再計算する。
// schedule() は他のイベント（ページ送り・回転・リサイズ等）でも呼ばれるため、
// ズーム由来かどうかをフラグで区別する。
let pdfZoomDirty = false;
let resetZoomToStart = false;
let pendingZoomAnchor = null;
// 前回 redraw 時のステージ（ペイン）サイズ。リサイズ検知に使う。
let lastStageW = null;
let lastStageH = null;

function isEditorPdfSampleMode() {
  return getParallelViewMode() === "editor" && getEditorLeftPaneMode() === "pdf";
}

function getEditorSampleSizeFromPsd(pageAR) {
  if (!isEditorPdfSampleMode()) return null;
  const psd = getCurrentPsdPageDisplaySize();
  if (!psd) return null;
  const targetW = Number(psd.width);
  const targetH = Number(psd.height);
  if (!(targetW > 0) || !(targetH > 0) || !(pageAR > 0)) return null;
  const targetAR = targetW / targetH;
  const diff = Math.abs(pageAR - targetAR) / Math.max(targetAR, 0.0001);
  if (diff <= 0.02) {
    return { width: targetW, height: targetH };
  }
  if (pageAR >= targetAR) {
    return { width: targetW, height: targetW / pageAR };
  }
  return { width: targetH * pageAR, height: targetH };
}

function cancelInFlightRender() {
  if (!currentRenderTask) return;
  try { currentRenderTask.cancel(); } catch (_) {}
  currentRenderTask = null;
}

// MojiQ 流パン状態：mousedown 時にスクロール起点を保存し、move でスクロール量を更新する。
let panState = null;
if (typeof window !== "undefined") {
  window.addEventListener("mouseup", () => { if (panState) endPdfPan(); });
  window.addEventListener("blur", () => { if (panState) endPdfPan(); });
}

function basename(p) {
  if (!p) return "";
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

export function mountPdfView() {
  if (mounted) return;
  rootEl = document.getElementById("spreads-pdf-area");
  stageEl = document.getElementById("pdf-stage");
  if (!rootEl || !stageEl) return;
  mounted = true;

  stageEl.innerHTML = "";

  pageWrap = document.createElement("div");
  pageWrap.className = "page pdf-page";

  // ラベルはペイン上部の `.stage-label-bar` 内 `#pdf-stage-label` に表示。
  // ステージ内のページに浮かべる旧方式は廃止。
  labelEl = document.getElementById("pdf-stage-label");

  canvas = document.createElement("canvas");
  canvas.className = "pdf-canvas";
  pageWrap.appendChild(canvas);

  stageEl.appendChild(pageWrap);

  emptyEl = document.createElement("div");
  emptyEl.className = "pdf-empty";
  emptyEl.innerHTML = `
    <svg class="pdf-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/>
      <path d="M14 2v5a1 1 0 0 0 1 1h5"/>
      <circle cx="10" cy="12" r="2"/>
      <path d="m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22"/>
    </svg>
    <p class="pdf-empty-text">「見本を読み込み」で見本画像を選択、またはこのウィンドウにドロップしてください。（PDF、JPEG、PNG）</p>
  `;
  stageEl.appendChild(emptyEl);

  outOfRangeEl = document.createElement("div");
  outOfRangeEl.className = "pdf-empty pdf-empty-out";
  outOfRangeEl.hidden = true;
  stageEl.appendChild(outOfRangeEl);

  onPdfChange(() => schedule());
  onPdfPageIndexChange(() => schedule());
  onPdfZoomChange(() => {
    // ズーム変更経由の redraw だけ「中心保持」を発動させたいので印を付ける。
    // 連続でズームするときは最後の値が pdfZoomDirty=true 状態で残り、redraw 内で
    // フラグを消費しつつ、その時点の (= 直前にレンダ済みの) 表示中心をキャプチャする。
    pdfZoomDirty = true;
    schedule();
  });
  onPdfRotationChange(() => schedule());
  onPdfSplitModeChange(() => schedule());
  onPdfSplitPageNumbersChange(() => schedule());
  onPdfFirstRightBlankChange(() => schedule());
  onPdfSkipFirstBlankChange(() => schedule());
  onParallelViewModeChange(() => schedule());
  onEditorLeftPaneModeChange(() => schedule());
  onPsdZoomChange(() => { if (isEditorPdfSampleMode()) schedule(); });
  onPsdRotationChange(() => { if (isEditorPdfSampleMode()) schedule(); });
  onPageIndexChange(() => { if (isEditorPdfSampleMode()) schedule(); });

  // パンツール対応：canvas 上で mousedown→move→up で stage をスクロールする。
  // PSD 側 (canvas-tools.js) と同じく、リスナーは canvas 自身に張り、毎回 stopPropagation
  // で親要素へのバブリングを抑止する。
  canvas.addEventListener("mousedown", (e) => onPdfCanvasMouseDown(e), true);
  canvas.addEventListener("mousemove", (e) => onPdfCanvasMouseMove(e), true);
  canvas.addEventListener("mouseup", (e) => onPdfCanvasMouseUp(e), true);

  // ツール変更でカーソルを更新（pan のとき grab、それ以外 default）。
  onToolChange(() => updatePdfCursor());
  updatePdfCursor();

  if (typeof ResizeObserver !== "undefined") {
    // リサイズは redraw 内で stageSizeChanged を検知してキャンバスを中央へ寄せ直す
    // （PSD 側 spread-view.js と同方針）。ResizeObserver 内で中心 fraction を捕捉すると、
    // ステージは新サイズ・キャンバスは旧サイズの中途半端なレイアウトから誤った値を取り、
    // restoreViewportCenter が位置をずらす原因になっていた。
    const ro = new ResizeObserver(() => {
      // 直接 schedule() せず debounce 版を使う。校正↔見本切替の width トランジション中に
      // 毎フレーム pdfjs 再レンダが走って重くなるのを防ぐ（収束後 1 回だけ描画）。
      scheduleResizeRedraw();
    });
    ro.observe(rootEl);
  }

  schedule();
}

function updatePdfCursor() {
  if (!canvas) return;
  canvas.style.cursor = getTool() === "pan" ? (panState ? "grabbing" : "grab") : "default";
}

function onPdfCanvasMouseDown(e) {
  if (getTool() !== "pan") return;
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  if (!stageEl) return;
  panState = {
    startX: e.clientX,
    startY: e.clientY,
    scrollStart: { left: stageEl.scrollLeft, top: stageEl.scrollTop },
    prevUserSelect: document.body.style.userSelect,
  };
  document.body.style.userSelect = "none";
  canvas.style.cursor = "grabbing";
}

function onPdfCanvasMouseMove(e) {
  if (!panState) return;
  e.preventDefault();
  e.stopPropagation();
  if (!stageEl) return;
  const dx = e.clientX - panState.startX;
  const dy = e.clientY - panState.startY;
  stageEl.scrollLeft = panState.scrollStart.left - dx;
  stageEl.scrollTop = panState.scrollStart.top - dy;
}

function onPdfCanvasMouseUp(e) {
  if (!panState) return;
  e.preventDefault();
  e.stopPropagation();
  endPdfPan();
}

function endPdfPan() {
  if (!panState) return;
  document.body.style.userSelect = panState.prevUserSelect;
  panState = null;
  updatePdfCursor();
}

function centerCurrentPdfPageInStage() {
  if (!stageEl || !pageWrap || pageWrap.hidden) return;
  centerCanvasInViewport(stageEl, pageWrap);
}

function restoreCurrentPdfPageCenter(center) {
  if (!stageEl || !pageWrap || pageWrap.hidden || !center) return;
  restoreViewportCenter(stageEl, pageWrap, center);
}

export function capturePdfViewportCenter() {
  if (!stageEl || !pageWrap || pageWrap.hidden) return null;
  return captureViewportCenterFraction(stageEl, pageWrap);
}

export function setNextPdfZoomAnchorFromClientPoint(clientX, clientY) {
  if (!stageEl || !pageWrap || pageWrap.hidden) return;
  pendingZoomAnchor = captureViewportPointFraction(stageEl, pageWrap, clientX, clientY);
}

export function resetPdfViewportToStart() {
  resetZoomToStart = true;
  const run = () => {
    if (!resetZoomToStart) return;
    if (pdfZoomDirty) return;
    centerCanvasInViewport(stageEl, pageWrap);
    resetZoomToStart = false;
  };
  requestAnimationFrame(run);
  requestAnimationFrame(() => requestAnimationFrame(run));
  setTimeout(run, 80);
}

function refreshPdfStageLayout({ recenter = true, viewportCenter = null } = {}) {
  if (isEditorPdfSampleMode()) {
    centerCurrentPdfPageInStage();
    return;
  }
  if (viewportCenter) {
    restoreCurrentPdfPageCenter(viewportCenter);
  } else if (recenter) {
    centerCurrentPdfPageInStage();
  }
}

export function schedulePdfStageLayoutRefresh({ durationMs = 360, recenter = true, viewportCenter = null } = {}) {
  const center = viewportCenter ?? (recenter ? null : capturePdfViewportCenter());
  const run = () => refreshPdfStageLayout({ recenter, viewportCenter: center });
  requestAnimationFrame(run);
  requestAnimationFrame(() => requestAnimationFrame(run));
  setTimeout(run, 80);
  setTimeout(run, Math.max(120, durationMs + 50));
  setTimeout(run, Math.max(260, durationMs + 180));
}

function schedule() {
  if (!mounted) return;
  if (pendingRaf) cancelAnimationFrame(pendingRaf);
  pendingRaf = requestAnimationFrame(() => {
    pendingRaf = 0;
    redraw().catch((e) => console.error("pdf redraw:", e));
  });
}

export function refreshPdfView() {
  schedule();
}

// ResizeObserver 用の trailing debounce 版 schedule。
// 【重要】テキストエディタの「校正 ↔ 見本」切替で .spreads-pdf-area の width が共有
// transition rule (width 0.3s) でアニメすると、ResizeObserver が毎フレーム発火して
// schedule()→redraw()→pdfjs page.render() が ~18 回連続で走り、見本切替が重くなる。
// 連続リサイズが収まってから 1 回だけ再レンダすることで storm を解消する。
// （ウインドウリサイズのドラッグ中も同様に間引かれ、副次的に軽くなる。）
const RESIZE_REDRAW_DEBOUNCE_MS = 130;
function scheduleResizeRedraw() {
  if (!mounted) return;
  if (resizeRedrawTimer) clearTimeout(resizeRedrawTimer);
  resizeRedrawTimer = window.setTimeout(() => {
    resizeRedrawTimer = 0;
    schedule();
  }, RESIZE_REDRAW_DEBOUNCE_MS);
}

/* ステージ上部バーのラベル文字数上限。30 文字を超えたら末尾を `…` に置換する。
   `…` 自体を 1 文字として数える方針：max 30 のとき先頭 29 文字 + `…` = 30 文字。 */
const LABEL_MAX_CHARS = 30;
function truncateLabel(text) {
  if (typeof text !== "string") return "";
  const chars = Array.from(text);
  if (chars.length <= LABEL_MAX_CHARS) return text;
  return chars.slice(0, LABEL_MAX_CHARS - 1).join("") + "…";
}

/* ページ番号は最低 2 桁ゼロ埋め（P01 / P10 / P100）。 */
function pageNumLabel(n) {
  return String(n).padStart(2, "0");
}

function showEmpty() {
  pageWrap.hidden = true;
  outOfRangeEl.hidden = true;
  emptyEl.hidden = false;
  if (labelEl) labelEl.textContent = "";
}

function showOutOfRange(requested, total) {
  pageWrap.hidden = true;
  emptyEl.hidden = true;
  outOfRangeEl.innerHTML = `
    <svg class="pdf-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/>
      <path d="M14 2v5a1 1 0 0 0 1 1h5"/>
      <circle cx="10" cy="12" r="2"/>
      <path d="m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22"/>
    </svg>
    <p class="pdf-empty-text">見本にこのページはありません (${requested} / ${total})</p>
  `;
  outOfRangeEl.hidden = false;
  if (labelEl) labelEl.textContent = truncateLabel(`P${pageNumLabel(requested)} (見本範囲外 / ${total})`);
}

function showCanvas(pageNum, side) {
  emptyEl.hidden = true;
  outOfRangeEl.hidden = true;
  pageWrap.hidden = false;
  if (labelEl) {
    const sideLabel = side === "right" ? "右" : side === "left" ? "左" : "";
    const pn = pageNumLabel(pageNum);
    // 合成 doc（loadReferenceFiles）は getSourcePath(pageNum) で per-page の元
    // ファイルパスを返す。フォールバックで getPdfPath()（先頭ファイル）を使う。
    const doc = getPdfDoc();
    const srcPath = (doc && typeof doc.getSourcePath === "function")
      ? doc.getSourcePath(pageNum)
      : null;
    const filename = basename(srcPath ?? getPdfPath());
    const raw = sideLabel
      ? `P${pn}${sideLabel}  ${filename}`
      : `P${pn}  ${filename}`;
    labelEl.textContent = truncateLabel(raw);
  }
}

async function redraw() {
  if (!mounted) return;
  const doc = getPdfDoc();
  if (!doc) {
    showEmpty();
    return;
  }

  const vtotal = getPdfVirtualPageCount();
  if (vtotal === 0) {
    showEmpty();
    return;
  }
  const vidx = getPdfPageIndex();
  if (vidx >= vtotal) {
    showOutOfRange(vidx + 1, vtotal);
    return;
  }
  const vp = getPdfVirtualPageAt(vidx);
  if (!vp) {
    showOutOfRange(vidx + 1, vtotal);
    return;
  }
  const pageNum = vp.pageNum;

  const box = rootEl.getBoundingClientRect();
  // ステージ（ペイン）サイズが前回 redraw から変化したか。リサイズ時にキャンバスを
  // viewport 中央へ寄せ直すために使う（PSD 側 spread-view.js と同方針）。
  const stageSizeChanged = lastStageW != null && lastStageH != null
    && (Math.abs(box.width - lastStageW) > 0.5 || Math.abs(box.height - lastStageH) > 0.5);
  lastStageW = box.width;
  lastStageH = box.height;
  const availW = Math.max(0, box.width - 32);
  const availH = Math.max(0, box.height - 32);
  if (availW <= 0 || availH <= 0) return;

  let page;
  try {
    page = await doc.getPage(pageNum);
  } catch (e) {
    console.error("getPage failed:", e);
    return;
  }
  const baseRotation = typeof page.rotate === "number" ? page.rotate : 0;
  const userRotation = getPdfRotation();
  const totalRotation = (((baseRotation + userRotation) % 360) + 360) % 360;

  const viewport0 = page.getViewport({ scale: 1, rotation: totalRotation });
  // 左/右半分表示は「横長ページ（width > height）」のときのみ有効。
  // 縦長ページや 90/270° 回転で縦長に見えるときは full にフォールバック。
  const isLandscape = viewport0.width > viewport0.height;
  const wantsSplit = vp.side === "left" || vp.side === "right";
  const side = wantsSplit && isLandscape ? vp.side : "full";

  const fullAR = viewport0.width / viewport0.height;
  const pageAR = side === "full" ? fullAR : fullAR / 2;
  let cssW;
  let cssH;
  const editorMatchedSize = getEditorSampleSizeFromPsd(pageAR);
  if (editorMatchedSize) {
    cssW = editorMatchedSize.width;
    cssH = editorMatchedSize.height;
  } else {
    const availAR = availW / availH;
    if (pageAR >= availAR) {
      cssW = availW;
      cssH = availW / pageAR;
    } else {
      cssH = availH;
      cssW = availH * pageAR;
    }
    const fitToPane = isEditorPdfSampleMode();
    const zoom = fitToPane ? PDF_FIT_ZOOM : getPdfZoom();
    cssW *= PDF_FIT_BASE_SCALE * zoom;
    cssH *= PDF_FIT_BASE_SCALE * zoom;
  }
  const fitToPane = isEditorPdfSampleMode();

  let dpr = Math.min(window.devicePixelRatio || 1, getCanvasDprCap());
  const maxSideCss = side === "full" ? cssW : cssW * 2;
  const maxDpr = Math.min(
    MAX_CANVAS_SIDE / Math.max(1, maxSideCss),
    MAX_CANVAS_SIDE / Math.max(1, cssH),
  );
  if (dpr > maxDpr) dpr = Math.max(1, maxDpr);

  // renderScale は「フルページ」基準。half の場合も full の倍率で render → 片側を切り出す。
  const renderScale = (cssW * (side === "full" ? 1 : 2) / viewport0.width) * dpr;
  const viewport = page.getViewport({ scale: renderScale, rotation: totalRotation });
  const pxW = Math.max(1, Math.round(viewport.width));
  const pxH = Math.max(1, Math.round(viewport.height));

  const myToken = ++renderToken;
  // 新しい redraw を始める前に古いタスクを必ずキャンセル。これがないと連打時に
  // pdfjs が複数のレンダを並行実行して CPU が飽和する。
  cancelInFlightRender();

  // 初回読込・OOB → 有効ページ復帰など、pageWrap が hidden だった状態から
  // 表示に切り替わるタイミングを検知して後段で再センタリングするためのフラグ。
  // showEmpty / showOutOfRange は pageWrap.hidden = true にする。
  const wasHidden = pageWrap.hidden;
  showCanvas(pageNum, side);

  // ズーム経由の redraw のときだけ、サイズ変更前の現在レイアウトから
  // viewport 中心のキャンバス相対座標をキャプチャ。フラグはここで消費。
  let zoomFracForThisRedraw = null;
  let resetZoomForThisRedraw = false;
  if (pdfZoomDirty) {
    pdfZoomDirty = false;
    resetZoomForThisRedraw = resetZoomToStart;
    resetZoomToStart = false;
    if (!fitToPane && !resetZoomForThisRedraw) {
      zoomFracForThisRedraw = pendingZoomAnchor ?? captureViewportCenterFraction(stageEl, pageWrap);
    }
    pendingZoomAnchor = null;
  }

  // canvas の CSS サイズを先に設定して pageWrap のレイアウトを確定させる
  // （canvas.width / canvas.height は backing pixel 解像度、両分岐で別値を入れる）。
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;

  // Photoshop 風オーバースクロール：キャンバスが stage より大きいときだけ pageWrap に
  // viewport の OVERSCROLL_FRACTION 倍の margin を付け、スクロール可能領域を広げる。
  // 戻り値 true は「margin が新規に付いた」状態 → scroll(0,0) で見切れるので再センタ。
  // availW/availH を渡してスクロールバー非依存に overflow 判定させる
  // （stage.clientWidth はズームイン中のスクロールバー分だけ削られているため
  //  ズーム=1 直後の遷移で誤判定し、過剰に margin が付与される事故を防ぐ）。
  const marginNewlyApplied = applyOverscrollMargin(stageEl, pageWrap, cssW, cssH, availW, availH);

  // ズーム前後で同じキャンバス上の点が viewport 中央に来るようスクロールを再計算。
  // それ以外（ページ送り・回転・リサイズ）の redraw では null なので何もしない。
  // 例外: ズーム後に overflow が解消した場合（Ctrl+0 で 100% に戻すなど）は frac
  // ベースの再計算が無意味（スクロール余地が無く flex 中央に貼られる）なので、
  // 明示的にスクロールを 0 に戻して flex の安全中央寄せに任せる。
  //
  // 比較に stage.clientWidth/Height を使うと、ズームイン状態のスクロールバー（横/縦）
  // が clientWidth/Height からその幅・高さぶん削っているせいで、Ctrl+0 直後でも
  // 「まだ overflow している」と誤判定し restoreViewportCenter 経路に入って
  // キャンバスがずれる。代わりに rootEl のコンテンツ寸法（= スクロールバー無視）
  // を使う：cssW/cssH はそもそも fit-to-availW/H × zoom で算出するので、ズーム≤1 では
  // 必ず availW/availH 以下になる。
  const hasOverflowAfter = cssW > availW || cssH > availH;
  if (fitToPane) {
    centerCanvasInViewport(stageEl, pageWrap);
  } else if (resetZoomForThisRedraw) {
    centerCanvasInViewport(stageEl, pageWrap);
  } else if (zoomFracForThisRedraw) {
    if (hasOverflowAfter) {
      if (Number.isFinite(zoomFracForThisRedraw.offsetX) && Number.isFinite(zoomFracForThisRedraw.offsetY)) {
        restoreViewportPoint(stageEl, pageWrap, zoomFracForThisRedraw);
      } else {
        restoreViewportCenter(stageEl, pageWrap, zoomFracForThisRedraw);
      }
    } else {
      stageEl.scrollLeft = 0;
      stageEl.scrollTop = 0;
    }
  } else if (stageSizeChanged) {
    // ウインドウ/ペインのリサイズで availW/H が変わったときはキャンバスを viewport
    // 中央へ寄せ直す。fit ズーム（PDF_FIT_BASE_SCALE=1.1 で約 10% overflow）でも
    // 中央に保たれる。stale な中心 fraction を復元していた旧経路の「位置ずれ」を解消。
    centerCanvasInViewport(stageEl, pageWrap);
  } else if (wasHidden || marginNewlyApplied) {
    // 初回読込・空表示/OOB から復帰したケース、または margin が新たに付いたケースは
    // スクロールが (0,0) のまま padding に乗っているので、キャンバス中央を viewport
    // 中央に合わせる。連続するページ送り（pageWrap が hidden でない）では発動しない。
    centerCanvasInViewport(stageEl, pageWrap);
  }

  if (side === "full") {
    canvas.width = pxW;
    canvas.height = pxH;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, pxW, pxH);
    const task = page.render({ canvasContext: ctx, viewport });
    currentRenderTask = task;
    try {
      await task.promise;
    } catch (e) {
      if (e && e.name === "RenderingCancelledException") return;
      console.error("pdf render:", e);
      return;
    } finally {
      if (currentRenderTask === task) currentRenderTask = null;
    }
    if (myToken !== renderToken) return;
  } else {
    // オフスクリーンに full 描画 → 表示 canvas に片側だけ drawImage
    const off = document.createElement("canvas");
    off.width = pxW;
    off.height = pxH;
    const task = page.render({ canvasContext: off.getContext("2d"), viewport });
    currentRenderTask = task;
    try {
      await task.promise;
    } catch (e) {
      if (e && e.name === "RenderingCancelledException") return;
      console.error("pdf render:", e);
      return;
    } finally {
      if (currentRenderTask === task) currentRenderTask = null;
    }
    if (myToken !== renderToken) return;
    const halfPxW = Math.floor(pxW / 2);
    // 右半分なら src 原点を halfPxW、左半分なら 0。
    const srcX = side === "right" ? halfPxW : 0;
    canvas.width = halfPxW;
    canvas.height = pxH;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, halfPxW, pxH);
    ctx.drawImage(off, -srcX, 0);
  }
  if (resetZoomForThisRedraw) {
    centerCanvasInViewport(stageEl, pageWrap);
    requestAnimationFrame(() => centerCanvasInViewport(stageEl, pageWrap));
    setTimeout(() => centerCanvasInViewport(stageEl, pageWrap), 60);
  }
}
