import * as pdfjsLib from "pdfjs-dist";
import { getPdfVirtualPageAt } from "./pdf-pages.js";
import { loadPsdFromPath } from "./psd-loader.js";
import {
  getParallelViewMode,
  getPdfDoc,
  getPdfPageIndex,
  getPdfPath,
  getPdfRotation,
  getPdfZoom,
  onParallelViewModeChange,
  onPdfChange,
  onPdfPageIndexChange,
  onPdfRotationChange,
  onPdfSkipFirstBlankChange,
  onPdfSplitModeChange,
  onPdfZoomChange,
} from "./state.js";
import { applyOverscrollMargin, centerCanvasInViewport } from "./overscroll.js";
import { toast } from "./ui-feedback.js";

const VIEWER_EXTENSIONS = ["jpg", "jpeg", "png", "pdf", "psd"];
const IMAGE_RE = /\.(jpe?g|png)$/i;
const PDF_RE = /\.pdf$/i;
const PSD_RE = /\.psd$/i;
const MAX_CANVAS_SIDE = 4096;
const VIEWER_FIT_BASE_SCALE = 1.1;

const state = {
  layers: [null, null],
  activeSlot: 0,
  loading: false,
  referenceToken: 0,
};

let initialized = false;
let workerConfigured = false;
let renderRaf = 0;
let resizeObserver = null;

const $ = (id) => document.getElementById(id);

function ensureWorker() {
  if (workerConfigured) return;
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  workerConfigured = true;
}

function basename(path) {
  const norm = String(path || "").replace(/\\/g, "/");
  return norm.split("/").filter(Boolean).pop() || "";
}

async function readFileBytes(path) {
  const { invoke } = await import("@tauri-apps/api/core");
  const bytes = await invoke("read_binary_file", { path });
  return new Uint8Array(bytes);
}

function makeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

async function loadImageCanvas(path) {
  const bytes = await readFileBytes(path);
  const bitmap = await createImageBitmap(new Blob([bytes]));
  try {
    const canvas = makeCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0);
    return canvas;
  } finally {
    try { if (typeof bitmap.close === "function") bitmap.close(); } catch (_) {}
  }
}

async function loadPdfCanvas(path) {
  ensureWorker();
  const bytes = await readFileBytes(path);
  const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
  try {
    const page = await doc.getPage(1);
    return await renderPdfPageToCanvas(page, { side: "full" });
  } finally {
    try { if (typeof doc.destroy === "function") doc.destroy(); } catch (_) {}
  }
}

async function loadPsdCanvas(path) {
  const page = await loadPsdFromPath(path);
  const canvas = makeCanvas(page?.width || page?.canvas?.width || 1, page?.height || page?.canvas?.height || 1);
  const ctx = canvas.getContext("2d");
  if (page?.canvas) ctx.drawImage(page.canvas, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function loadViewerCanvas(path) {
  if (IMAGE_RE.test(path)) return loadImageCanvas(path);
  if (PDF_RE.test(path)) return loadPdfCanvas(path);
  if (PSD_RE.test(path)) return loadPsdCanvas(path);
  throw new Error("対応していないファイル形式です");
}

async function renderPdfPageToCanvas(page, { side = "full" } = {}) {
  const rotation = (((typeof page.rotate === "number" ? page.rotate : 0) + getPdfRotation()) % 360 + 360) % 360;
  const base = page.getViewport({ scale: 1, rotation });
  const scale = Math.min(2, MAX_CANVAS_SIDE / Math.max(1, base.width, base.height));
  const viewport = page.getViewport({ scale, rotation });

  if ((side === "left" || side === "right") && viewport.width > viewport.height) {
    const fullCanvas = makeCanvas(viewport.width, viewport.height);
    const task = page.render({ canvasContext: fullCanvas.getContext("2d"), viewport });
    await task.promise;
    const halfW = Math.floor(fullCanvas.width / 2);
    const srcX = side === "right" ? halfW : 0;
    const canvas = makeCanvas(halfW, fullCanvas.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(fullCanvas, srcX, 0, halfW, fullCanvas.height, 0, 0, halfW, fullCanvas.height);
    return canvas;
  }

  const canvas = makeCanvas(viewport.width, viewport.height);
  const task = page.render({ canvasContext: canvas.getContext("2d"), viewport });
  await task.promise;
  return canvas;
}

async function renderCurrentReferenceCanvas() {
  const doc = getPdfDoc();
  if (!doc) return null;
  const virtual = getPdfVirtualPageAt(getPdfPageIndex());
  if (!virtual) return null;
  const page = await doc.getPage(virtual.pageNum);
  return renderPdfPageToCanvas(page, { side: virtual.side });
}

async function syncReferenceIntoA({ activate = false, notify = false } = {}) {
  const token = ++state.referenceToken;
  try {
    const canvas = await renderCurrentReferenceCanvas();
    if (token !== state.referenceToken) return;
    if (!canvas) {
      state.layers[0] = null;
      if (notify) toast("見本画像が読み込まれていません", { kind: "info", duration: 2400 });
      render();
      return;
    }
    state.layers[0] = {
      path: getPdfPath(),
      name: basename(getPdfPath()) || "見本画像",
      canvas,
      width: canvas.width,
      height: canvas.height,
      source: "reference",
    };
    if (activate || !state.layers[state.activeSlot]) state.activeSlot = 0;
    render();
  } catch (e) {
    console.error("[left-viewer] reference sync failed:", e);
    if (token === state.referenceToken) {
      state.layers[0] = null;
      if (state.activeSlot === 0 && state.layers[1]) state.activeSlot = 1;
      render();
    }
    if (notify) toast("見本画像をAに反映できませんでした", { kind: "error", duration: 3600 });
  }
}

async function pickViewerFile() {
  const { openFileDialog } = await import("./file-picker.js");
  const picked = await openFileDialog({
    mode: "open",
    multiple: false,
    title: "ビューアー画像を開く",
    filters: [{ name: "ビューアー (JPG / PNG / PDF / PSD)", extensions: VIEWER_EXTENSIONS }],
    rememberKey: "left-viewer-open",
  });
  return typeof picked === "string" ? picked : picked?.path ?? null;
}

function setBusy(loading) {
  state.loading = !!loading;
  ["left-viewer-load-a-btn", "left-viewer-load-b-btn", "left-viewer-show-a-btn", "left-viewer-show-b-btn"]
    .forEach((id) => {
      const el = $(id);
      if (el) el.disabled = state.loading;
    });
  updateSelectButtons();
  updateLoadButtonLabels();
}

function updateLoadButtonLabels() {
  const aBtn = $("left-viewer-load-a-btn");
  const bBtn = $("left-viewer-load-b-btn");
  if (aBtn) aBtn.textContent = "Aを更新";
  if (bBtn) bBtn.textContent = state.layers[1] ? "Bを更新" : "Bを開く";
}

async function loadSlot(slot) {
  if (state.loading) return;
  if (slot === 0) {
    await syncReferenceIntoA({ activate: true, notify: true });
    return;
  }

  const path = await pickViewerFile();
  if (!path) return;
  setBusy(true);
  try {
    const canvas = await loadViewerCanvas(path);
    state.layers[slot] = {
      path,
      name: basename(path),
      canvas,
      width: canvas.width,
      height: canvas.height,
    };
    state.activeSlot = slot;
    render();
  } catch (e) {
    console.error("[left-viewer] load failed:", path, e);
    toast(`ビューアーに読み込めませんでした: ${basename(path)}`, { kind: "error", duration: 4500 });
  } finally {
    setBusy(false);
  }
}

function setActiveSlot(slot) {
  if (state.loading) return;
  if (!state.layers[slot]) {
    toast(`${slot === 0 ? "A" : "B"}にファイルが読み込まれていません`, { kind: "info", duration: 2200 });
    return;
  }
  state.activeSlot = slot;
  render();
}

function updateSelectButtons() {
  [
    [$("left-viewer-show-a-btn"), 0],
    [$("left-viewer-show-b-btn"), 1],
  ].forEach(([btn, slot]) => {
    if (!btn) return;
    const active = state.activeSlot === slot;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
    btn.disabled = state.loading || !state.layers[slot];
  });
  updateLoadButtonLabels();
}

function scheduleRender() {
  if (renderRaf) return;
  renderRaf = requestAnimationFrame(() => {
    renderRaf = 0;
    render();
  });
}

function displaySizeForLayer(layer) {
  const stage = $("left-viewer-stage");
  const box = stage?.getBoundingClientRect?.();
  const availW = Math.max(1, (box?.width || 0) - 32);
  const availH = Math.max(1, (box?.height || 0) - 32);
  const pageAR = Math.max(1, layer.width) / Math.max(1, layer.height);
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
  return {
    availW,
    availH,
    cssW: cssW * VIEWER_FIT_BASE_SCALE * zoom,
    cssH: cssH * VIEWER_FIT_BASE_SCALE * zoom,
  };
}

function cloneLayerCanvas(layer, cssW, cssH) {
  const canvas = makeCanvas(layer.width, layer.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(layer.canvas, 0, 0);
  canvas.className = "left-viewer-canvas";
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  return canvas;
}

function makeEmpty() {
  const el = document.createElement("div");
  el.className = "left-viewer-empty";
  el.innerHTML = `
    <svg class="left-viewer-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="14" height="14" rx="1.5"/>
      <path d="m6.5 15 3-3 2.2 2.2 1.4-1.4 3.4 3.4"/>
      <path d="M15 3h4a2 2 0 0 1 2 2v4"/>
      <path d="M19 7v10a2 2 0 0 1-2 2H7"/>
    </svg>
    <div>見本画像を読み込むとAに表示されます。Bには比較用ファイルを読み込めます。</div>
  `;
  return el;
}

function render() {
  const stage = $("left-viewer-stage");
  if (!stage) return;
  stage.innerHTML = "";

  const layers = state.layers.filter(Boolean);
  if (layers.length === 0) {
    updateSelectButtons();
    stage.appendChild(makeEmpty());
    return;
  }

  if (!state.layers[state.activeSlot]) {
    state.activeSlot = state.layers[0] ? 0 : 1;
  }
  updateSelectButtons();

  const layer = state.layers[state.activeSlot];
  const { availW, availH, cssW, cssH } = displaySizeForLayer(layer);
  const wrap = document.createElement("div");
  wrap.className = "left-viewer-stack-wrap";

  const stack = document.createElement("div");
  stack.className = "left-viewer-stack";
  stack.style.width = `${cssW}px`;
  stack.style.height = `${cssH}px`;
  stack.appendChild(cloneLayerCanvas(layer, cssW, cssH));

  wrap.appendChild(stack);
  stage.appendChild(wrap);
  applyOverscrollMargin(stage, wrap, cssW, cssH, availW, availH);
  centerCanvasInViewport(stage, wrap);
}

export function initLeftViewerPanel() {
  if (initialized) return;
  initialized = true;
  $("left-viewer-load-a-btn")?.addEventListener("click", () => { void loadSlot(0); });
  $("left-viewer-load-b-btn")?.addEventListener("click", () => { void loadSlot(1); });
  $("left-viewer-show-a-btn")?.addEventListener("click", () => setActiveSlot(0));
  $("left-viewer-show-b-btn")?.addEventListener("click", () => setActiveSlot(1));

  const syncIfVisible = () => {
    if (getParallelViewMode() !== "imageViewer") return;
    void syncReferenceIntoA({ activate: !state.layers[1] });
  };
  onParallelViewModeChange(syncIfVisible);
  onPdfChange(syncIfVisible);
  onPdfPageIndexChange(syncIfVisible);
  onPdfRotationChange(syncIfVisible);
  onPdfSplitModeChange(syncIfVisible);
  onPdfSkipFirstBlankChange(syncIfVisible);
  onPdfZoomChange(() => {
    if (getParallelViewMode() !== "imageViewer") return;
    scheduleRender();
  });

  const stage = $("left-viewer-stage");
  if (stage && typeof ResizeObserver === "function") {
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(() => {
      if (getParallelViewMode() !== "imageViewer") return;
      scheduleRender();
    });
    resizeObserver.observe(stage);
  }

  void syncReferenceIntoA({ activate: true });
  render();
}
