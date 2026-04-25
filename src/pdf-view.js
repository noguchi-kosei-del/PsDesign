import {
  getPdfDoc,
  getPdfPageIndex,
  getPdfPath,
  getPdfRotation,
  getPdfZoom,
  getTool,
  onPdfChange,
  onPdfPageIndexChange,
  onPdfRotationChange,
  onPdfSkipFirstBlankChange,
  onPdfSplitModeChange,
  onPdfZoomChange,
  onToolChange,
} from "./state.js";
import {
  getPdfVirtualPageAt,
  getPdfVirtualPageCount,
} from "./pdf-pages.js";

const MAX_CANVAS_SIDE = 16384;

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

  labelEl = document.createElement("div");
  labelEl.className = "page-label";
  pageWrap.appendChild(labelEl);

  canvas = document.createElement("canvas");
  canvas.className = "pdf-canvas";
  pageWrap.appendChild(canvas);

  stageEl.appendChild(pageWrap);

  emptyEl = document.createElement("div");
  emptyEl.className = "pdf-empty";
  emptyEl.innerHTML = `
    <svg class="pdf-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"/>
      <polyline points="14 2 14 8 20 8"/>
      <text x="12" y="19" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" style="font-family: sans-serif; font-weight: 700;">PDF</text>
    </svg>
    <p class="pdf-empty-text">「PDF を開く」で参照 PDF を選択、またはこのウィンドウにドロップしてください。</p>
  `;
  stageEl.appendChild(emptyEl);

  outOfRangeEl = document.createElement("div");
  outOfRangeEl.className = "pdf-empty pdf-empty-out";
  outOfRangeEl.hidden = true;
  stageEl.appendChild(outOfRangeEl);

  onPdfChange(() => schedule());
  onPdfPageIndexChange(() => schedule());
  onPdfZoomChange(() => schedule());
  onPdfRotationChange(() => schedule());
  onPdfSplitModeChange(() => schedule());
  onPdfSkipFirstBlankChange(() => schedule());

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
    const ro = new ResizeObserver(() => schedule());
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

function schedule() {
  if (!mounted) return;
  if (pendingRaf) cancelAnimationFrame(pendingRaf);
  pendingRaf = requestAnimationFrame(() => {
    pendingRaf = 0;
    redraw().catch((e) => console.error("pdf redraw:", e));
  });
}

function showEmpty() {
  pageWrap.hidden = true;
  outOfRangeEl.hidden = true;
  emptyEl.hidden = false;
}

function showOutOfRange(requested, total) {
  pageWrap.hidden = true;
  emptyEl.hidden = true;
  outOfRangeEl.innerHTML = `
    <svg class="pdf-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
    <p class="pdf-empty-text">PDF にこのページはありません (${requested} / ${total})</p>
  `;
  outOfRangeEl.hidden = false;
}

function showCanvas(pageNum, side) {
  emptyEl.hidden = true;
  outOfRangeEl.hidden = true;
  pageWrap.hidden = false;
  if (labelEl) {
    const sideLabel = side === "right" ? "右" : side === "left" ? "左" : "";
    labelEl.textContent = sideLabel
      ? `#${pageNum}${sideLabel}  ${basename(getPdfPath())}`
      : `#${pageNum}  ${basename(getPdfPath())}`;
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
  const availAR = availW / availH;
  let cssW;
  let cssH;
  if (pageAR >= availAR) {
    cssW = availW;
    cssH = availW / pageAR;
  } else {
    cssH = availH;
    cssW = availH * pageAR;
  }
  const zoom = getPdfZoom();
  cssW *= zoom;
  cssH *= zoom;

  let dpr = window.devicePixelRatio || 1;
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
  showCanvas(pageNum, side);

  if (side === "full") {
    canvas.width = pxW;
    canvas.height = pxH;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, pxW, pxH);
    try {
      await page.render({ canvasContext: ctx, viewport }).promise;
    } catch (e) {
      if (e && e.name === "RenderingCancelledException") return;
      console.error("pdf render:", e);
      return;
    }
    if (myToken !== renderToken) return;
  } else {
    // オフスクリーンに full 描画 → 表示 canvas に片側だけ drawImage
    const off = document.createElement("canvas");
    off.width = pxW;
    off.height = pxH;
    try {
      await page.render({ canvasContext: off.getContext("2d"), viewport }).promise;
    } catch (e) {
      if (e && e.name === "RenderingCancelledException") return;
      console.error("pdf render:", e);
      return;
    }
    if (myToken !== renderToken) return;
    const halfPxW = Math.floor(pxW / 2);
    // 右半分なら src 原点を halfPxW、左半分なら 0。
    const srcX = side === "right" ? halfPxW : 0;
    canvas.width = halfPxW;
    canvas.height = pxH;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, halfPxW, pxH);
    ctx.drawImage(off, -srcX, 0);
  }
}
