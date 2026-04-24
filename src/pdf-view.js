import {
  getCurrentPageIndex,
  getPdfDoc,
  getPdfPageCount,
  getPdfPath,
  getPdfRotation,
  getZoom,
  onPageIndexChange,
  onPdfChange,
  onPdfRotationChange,
  onZoomChange,
} from "./state.js";

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
  onPageIndexChange(() => schedule());
  onZoomChange(() => schedule());
  onPdfRotationChange(() => schedule());

  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => schedule());
    ro.observe(rootEl);
  }

  schedule();
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

function showCanvas(pageNum) {
  emptyEl.hidden = true;
  outOfRangeEl.hidden = true;
  pageWrap.hidden = false;
  if (labelEl) {
    labelEl.textContent = `#${pageNum}  ${basename(getPdfPath())}`;
  }
}

async function redraw() {
  if (!mounted) return;
  const doc = getPdfDoc();
  if (!doc) {
    showEmpty();
    return;
  }
  const pageIndex = getCurrentPageIndex();
  const pageNum = pageIndex + 1;
  const total = getPdfPageCount() || doc.numPages || 0;
  if (pageNum > total) {
    showOutOfRange(pageNum, total);
    return;
  }

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
  const pageAR = viewport0.width / viewport0.height;
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
  const zoom = getZoom();
  cssW *= zoom;
  cssH *= zoom;

  let dpr = window.devicePixelRatio || 1;
  const maxDpr = Math.min(
    MAX_CANVAS_SIDE / Math.max(1, cssW),
    MAX_CANVAS_SIDE / Math.max(1, cssH),
  );
  if (dpr > maxDpr) dpr = Math.max(1, maxDpr);

  const renderScale = (cssW / viewport0.width) * dpr;
  const viewport = page.getViewport({ scale: renderScale, rotation: totalRotation });
  const pxW = Math.max(1, Math.round(viewport.width));
  const pxH = Math.max(1, Math.round(viewport.height));

  showCanvas(pageNum);
  canvas.width = pxW;
  canvas.height = pxH;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;

  const myToken = ++renderToken;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, pxW, pxH);

  try {
    const task = page.render({ canvasContext: ctx, viewport });
    await task.promise;
  } catch (e) {
    if (e && e.name === "RenderingCancelledException") return;
    console.error("pdf render:", e);
    return;
  }
  if (myToken !== renderToken) {
    // 古い結果なので破棄（後続 redraw が上書きするはず）
  }
}
