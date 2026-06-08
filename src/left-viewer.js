import * as pdfjsLib from "pdfjs-dist";
import { loadPsdFromPath } from "./psd-loader.js";
import {
  getParallelViewMode,
  getPdfRotation,
  getPdfZoom,
  onParallelViewModeChange,
  onPdfZoomChange,
} from "./state.js";
import { applyOverscrollMargin, centerCanvasInViewport } from "./overscroll.js";
import { toast } from "./ui-feedback.js";

const VIEWER_EXTENSIONS = ["jpg", "jpeg", "png", "pdf", "psd"];
const VIEWER_RE = /\.(jpe?g|png|pdf|psd)$/i;
const IMAGE_RE = /\.(jpe?g|png)$/i;
const PDF_RE = /\.pdf$/i;
const PSD_RE = /\.psd$/i;
const MAX_CANVAS_SIDE = 16384;
const PDF_RENDER_SCALE = 4;
const VIEWER_FIT_BASE_SCALE = 1.1;

const state = {
  pages: [],
  currentIndex: 0,
  loading: false,
  dragOver: false,
  progress: null,
  docs: [],
  renderToken: 0,
  loadToken: 0,
};

let initialized = false;
let workerConfigured = false;
let renderRaf = 0;
let resizeObserver = null;
let progressTimer = 0;
let progressOverlayEl = null;

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

function isViewerPath(path) {
  return typeof path === "string" && VIEWER_RE.test(path);
}

function viewerPaths(paths) {
  return (Array.isArray(paths) ? paths : [paths]).filter(isViewerPath);
}

function firstViewerPath(paths) {
  return viewerPaths(paths)[0] || null;
}

function currentPage() {
  return state.pages[state.currentIndex] || null;
}

function emitViewerPageChange(reason = "page") {
  window.dispatchEvent(new CustomEvent("psdesign:left-viewer-page-change", {
    detail: {
      currentIndex: state.currentIndex,
      total: state.pages.length,
      reason,
    },
  }));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[ch]));
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

function updateProgressDom() {
  if (!state.progress) return;
  ensureProgressOverlay();
  const pct = Math.max(0, Math.min(100, Math.round(state.progress.value)));
  const fill = $("left-viewer-progress-fill");
  const percent = $("left-viewer-progress-percent");
  const detail = $("left-viewer-progress-detail");
  const name = $("left-viewer-progress-name");
  if (fill) fill.style.width = `${pct}%`;
  if (percent) percent.textContent = `${pct}%`;
  if (detail) detail.textContent = state.progress.detail || "";
  if (name) name.textContent = state.progress.name || "";
  syncProgressOverlayRect();
}

function setViewerProgress(target, detail) {
  if (!state.progress) return;
  state.progress.target = Math.max(0, Math.min(100, Number(target) || 0));
  if (detail) state.progress.detail = detail;
  updateProgressDom();
}

function startProgressTicker() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = window.setInterval(() => {
    if (!state.loading || !state.progress) return;
    const diff = state.progress.target - state.progress.value;
    if (diff <= 0.1) return;
    state.progress.value = Math.min(
      state.progress.target,
      state.progress.value + Math.max(0.4, diff * 0.16),
    );
    updateProgressDom();
  }, 80);
}

function beginViewerProgress(name, detail = "読み込み準備中") {
  state.progress = {
    value: 0,
    target: 8,
    detail,
    name,
  };
  setBusy(true);
  startProgressTicker();
  render();
}

function endViewerProgress() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = 0;
  state.progress = null;
  removeProgressOverlay();
  setBusy(false);
}

function waitForNextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

async function loadImageCanvas(path, onProgress = () => {}) {
  onProgress(18, "ファイルを読み込み中");
  const bytes = await readFileBytes(path);
  onProgress(52, "画像を展開中");
  const bitmap = await createImageBitmap(new Blob([bytes]));
  try {
    onProgress(82, "表示を準備中");
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

async function renderPdfPageToCanvas(pdfPage, onProgress = () => {}) {
  const rotation = (((typeof pdfPage.rotate === "number" ? pdfPage.rotate : 0) + getPdfRotation()) % 360 + 360) % 360;
  const base = pdfPage.getViewport({ scale: 1, rotation });
  const scale = Math.min(PDF_RENDER_SCALE, MAX_CANVAS_SIDE / Math.max(1, base.width, base.height));
  const viewport = pdfPage.getViewport({ scale, rotation });
  onProgress(0, "ページを描画中");
  const canvas = makeCanvas(viewport.width, viewport.height);
  const task = pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport });
  await task.promise;
  onProgress(100, "表示を準備中");
  return canvas;
}

async function loadPdfPages(path, onProgress = () => {}) {
  ensureWorker();
  onProgress(12, "PDFを読み込み中");
  const bytes = await readFileBytes(path);
  onProgress(30, "PDFを解析中");
  const task = pdfjsLib.getDocument({ data: bytes });
  task.onProgress = ({ loaded, total }) => {
    if (!(total > 0)) return;
    const ratio = Math.max(0, Math.min(1, loaded / total));
    onProgress(30 + ratio * 30, "PDFを解析中");
  };
  const doc = await task.promise;
  try {
    const pages = [];
    const total = Math.max(1, doc.numPages || 1);
    const renderBase = 62;
    const renderSpan = 34;
    for (let pageNum = 1; pageNum <= total; pageNum += 1) {
      const pageStart = renderBase + ((pageNum - 1) / total) * renderSpan;
      const pageSpan = renderSpan / total;
      onProgress(pageStart, "ページを描画中");
      const pdfPage = await doc.getPage(pageNum);
      const canvas = await renderPdfPageToCanvas(pdfPage, (pct, detail) => {
        onProgress(pageStart + (Math.max(0, Math.min(100, pct)) / 100) * pageSpan, detail);
      });
      pages.push({
        kind: "pdf",
        path,
        name: basename(path),
        pageNum,
        pageLabel: `${basename(path)}  ${pageNum} / ${total}`,
        width: canvas.width,
        height: canvas.height,
        canvas,
      });
      if (pageNum === 1 || pageNum === total || pageNum % 4 === 0) {
        await waitForNextPaint();
      }
    }
    onProgress(96, "表示を準備中");
    return { pages, docs: [] };
  } finally {
    try {
      const result = typeof doc.destroy === "function" ? doc.destroy() : null;
      if (result?.catch) result.catch(() => {});
    } catch (_) {}
  }
}

async function loadPsdCanvas(path, onProgress = () => {}) {
  onProgress(18, "PSDを解析中");
  const page = await loadPsdFromPath(path);
  onProgress(82, "表示を準備中");
  const canvas = makeCanvas(page?.width || page?.canvas?.width || 1, page?.height || page?.canvas?.height || 1);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (page?.canvas) ctx.drawImage(page.canvas, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function loadViewerPagesForPath(path, onProgress = () => {}) {
  if (IMAGE_RE.test(path)) {
    const canvas = await loadImageCanvas(path, onProgress);
    return {
      pages: [{
        kind: "image",
        path,
        name: basename(path),
        canvas,
        width: canvas.width,
        height: canvas.height,
      }],
      docs: [],
    };
  }
  if (PDF_RE.test(path)) return loadPdfPages(path, onProgress);
  if (PSD_RE.test(path)) {
    const canvas = await loadPsdCanvas(path, onProgress);
    return {
      pages: [{
        kind: "psd",
        path,
        name: basename(path),
        canvas,
        width: canvas.width,
        height: canvas.height,
      }],
      docs: [],
    };
  }
  throw new Error("対応していないファイル形式です");
}

async function pickViewerFiles() {
  const { openFileDialog } = await import("./file-picker.js");
  const picked = await openFileDialog({
    mode: "open",
    multiple: true,
    title: "見本ビューアーを開く",
    filters: [{ name: "見本ビューアー (JPG / PNG / PDF / PSD)", extensions: VIEWER_EXTENSIONS }],
    rememberKey: "left-viewer-open",
  });
  if (Array.isArray(picked)) return picked.filter((path) => typeof path === "string");
  if (typeof picked === "string") return [picked];
  if (picked?.path) return [picked.path];
  return [];
}

function destroyDocs(docs) {
  (docs || []).forEach((doc) => {
    try {
      const result = typeof doc?.destroy === "function" ? doc.destroy() : null;
      if (result?.catch) result.catch(() => {});
    } catch (_) {}
  });
}

function setBusy(loading) {
  state.loading = !!loading;
  const btn = $("left-viewer-load-b-btn");
  if (btn) btn.disabled = state.loading;
  updateLoadButtonLabel();
  updatePageControls();
}

function updateLoadButtonLabel() {
  const btn = $("left-viewer-load-b-btn");
  if (btn) btn.textContent = state.pages.length ? "見本を変更" : "見本を開く";
}

function updateStageLabel() {
  const label = $("left-viewer-stage-label");
  const page = currentPage();
  if (!label) return;
  if (!page) {
    label.textContent = "見本ビューアー";
    return;
  }
  label.textContent = `P${String(state.currentIndex + 1).padStart(2, "0")}  ${page.pageLabel || page.name}`;
}

function updatePageControls() {
  const total = state.pages.length;
  const current = total ? state.currentIndex + 1 : 0;
  const prev = $("left-viewer-prev-btn");
  const next = $("left-viewer-next-btn");
  const label = $("left-viewer-page-label");
  if (prev) prev.disabled = state.loading || current <= 1;
  if (next) next.disabled = state.loading || current >= total;
  if (label) {
    label.textContent = total ? `${current} / ${total}` : "- / -";
    label.hidden = false;
  }
}

export function getLeftViewerPageCount() {
  return state.pages.length;
}

export function getLeftViewerPageIndex() {
  return state.currentIndex;
}

export function setLeftViewerPageIndex(index) {
  setViewerPageIndex(index);
}

export function moveLeftViewerPage(delta) {
  moveViewerPage(delta);
}

export function clearLeftViewer() {
  state.loadToken += 1;
  state.renderToken += 1;
  state.pages = [];
  state.currentIndex = 0;
  state.loading = false;
  state.dragOver = false;
  state.progress = null;
  destroyDocs(state.docs);
  state.docs = [];
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = 0;
  removeProgressOverlay();
  setDragOver(false);
  render();
  emitViewerPageChange("clear");
}

async function loadViewerPaths(paths, { notify = true } = {}) {
  const validPaths = viewerPaths(paths);
  if (!validPaths.length) return false;
  if (state.loading) {
    toast("読み込み中です。完了までお待ちください", { kind: "info", duration: 2200 });
    return true;
  }

  const newPages = [];
  const newDocs = [];
  const loadName = validPaths.length === 1 ? basename(validPaths[0]) : `${validPaths.length}件の見本`;
  const token = state.loadToken + 1;
  let loaded = false;
  state.loadToken = token;
  beginViewerProgress(loadName);
  await waitForNextPaint();
  try {
    for (let index = 0; index < validPaths.length; index += 1) {
      if (token !== state.loadToken) return true;
      const path = validPaths[index];
      const spanStart = (index / validPaths.length) * 96;
      const spanSize = 96 / validPaths.length;
      const result = await loadViewerPagesForPath(path, (pct, detail) => {
        if (token !== state.loadToken) return;
        setViewerProgress(spanStart + (Math.max(0, Math.min(100, pct)) / 100) * spanSize, detail);
      });
      if (token !== state.loadToken) {
        destroyDocs(result.docs);
        return true;
      }
      newPages.push(...result.pages);
      newDocs.push(...result.docs);
    }
    if (!newPages.length) throw new Error("読み込めるページがありません");
    setViewerProgress(100, "表示準備完了");
    destroyDocs(state.docs);
    state.docs = newDocs;
    state.pages = newPages;
    state.currentIndex = 0;
    state.renderToken += 1;
    loaded = true;
    if (notify) {
      toast(`見本ビューアーに ${newPages.length} ページ読み込みました`, { kind: "success", duration: 2800 });
    }
    return true;
  } catch (e) {
    destroyDocs(newDocs);
    console.error("[left-viewer] load failed:", validPaths, e);
    toast("見本ビューアーに読み込めませんでした", { kind: "error", duration: 4500 });
    return true;
  } finally {
    if (token === state.loadToken) {
      endViewerProgress();
      render();
      if (loaded) emitViewerPageChange("load");
    }
  }
}

async function loadPickedViewerFiles() {
  const paths = await pickViewerFiles();
  if (!paths.length) return;
  await loadViewerPaths(paths);
}

function scheduleRender() {
  if (renderRaf) return;
  renderRaf = requestAnimationFrame(() => {
    renderRaf = 0;
    render();
  });
}

function displaySizeForPage(page, host) {
  const box = host?.getBoundingClientRect?.();
  const availW = Math.max(1, (box?.width || 0) - 32);
  const availH = Math.max(1, (box?.height || 0) - 32);
  const pageAR = Math.max(1, page.width) / Math.max(1, page.height);
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
  cssW *= VIEWER_FIT_BASE_SCALE * zoom;
  cssH *= VIEWER_FIT_BASE_SCALE * zoom;
  let dpr = window.devicePixelRatio || 1;
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
  };
}

function displayHostForStage(stage) {
  // 写植見本/PDF 側はペイン全体を基準に fit サイズを算出する。
  // 内側 stage 基準にすると、ペイン padding 分だけ画像の表示領域が狭くなる。
  return $("spreads-viewer-area") || stage;
}

function makeEmpty() {
  const el = document.createElement("div");
  el.className = "pdf-empty left-viewer-empty";
  el.innerHTML = `
    <svg class="left-viewer-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="14" height="14" rx="1.5"/>
      <path d="m6.5 15 3-3 2.2 2.2 1.4-1.4 3.4 3.4"/>
      <path d="M15 3h4a2 2 0 0 1 2 2v4"/>
      <path d="M19 7v10a2 2 0 0 1-2 2H7"/>
    </svg>
    <p class="pdf-empty-text">JPG / PNG / PDF / PSD をここにドロップ、またはボタンから開けます</p>
  `;
  return el;
}

function makePagePlaceholder() {
  const el = document.createElement("div");
  el.className = "pdf-empty left-viewer-empty";
  el.innerHTML = `<p class="pdf-empty-text">ページを準備中です</p>`;
  return el;
}

function makeProgressOverlay() {
  const progress = state.progress || { value: 0, detail: "", name: "" };
  const pct = Math.max(0, Math.min(100, Math.round(progress.value)));
  const name = escapeHtml(progress.name);
  const detail = escapeHtml(progress.detail);
  const el = document.createElement("div");
  el.className = "left-viewer-progress-overlay";
  el.innerHTML = `
    <div class="left-viewer-progress-card" role="status" aria-live="polite">
      <div class="left-viewer-progress-head">
        <span class="left-viewer-progress-title">見本を読み込み中</span>
        <span class="left-viewer-progress-percent" id="left-viewer-progress-percent">${pct}%</span>
      </div>
      <div class="left-viewer-progress-name" id="left-viewer-progress-name">${name}</div>
      <div class="left-viewer-progress-track">
        <div class="left-viewer-progress-fill" id="left-viewer-progress-fill" style="width: ${pct}%"></div>
      </div>
      <div class="left-viewer-progress-detail" id="left-viewer-progress-detail">${detail}</div>
    </div>
  `;
  return el;
}

function syncProgressOverlayRect() {
  if (!progressOverlayEl) return;
  const stage = $("left-viewer-stage");
  const rect = stage?.getBoundingClientRect?.();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    progressOverlayEl.hidden = true;
    return;
  }
  progressOverlayEl.hidden = false;
  progressOverlayEl.style.left = `${rect.left}px`;
  progressOverlayEl.style.top = `${rect.top}px`;
  progressOverlayEl.style.width = `${rect.width}px`;
  progressOverlayEl.style.height = `${rect.height}px`;
}

function ensureProgressOverlay() {
  if (!state.loading || !state.progress) {
    removeProgressOverlay();
    return null;
  }
  if (!progressOverlayEl) {
    progressOverlayEl = makeProgressOverlay();
    progressOverlayEl.classList.add("left-viewer-progress-overlay-portal");
    document.body.appendChild(progressOverlayEl);
  }
  syncProgressOverlayRect();
  return progressOverlayEl;
}

function removeProgressOverlay() {
  if (!progressOverlayEl) return;
  progressOverlayEl.remove();
  progressOverlayEl = null;
}

function renderPage(stage, page) {
  const displayHost = displayHostForStage(stage);
  const { availW, availH, cssW, cssH, pxW, pxH } = displaySizeForPage(page, displayHost);
  const pageEl = document.createElement("div");
  pageEl.className = "page left-viewer-page";
  pageEl.style.width = `${cssW}px`;
  pageEl.style.height = `${cssH}px`;

  const canvas = makeCanvas(pxW, pxH);
  canvas.className = "left-viewer-canvas";
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.style.imageRendering = "auto";
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(page.canvas, 0, 0, pxW, pxH);

  pageEl.appendChild(canvas);
  stage.appendChild(pageEl);
  applyOverscrollMargin(stage, pageEl, cssW, cssH, availW, availH);
  centerCanvasInViewport(stage, pageEl);
}

async function ensureCurrentPageRendered() {
  const page = currentPage();
  if (!page || page.canvas || page.kind !== "pdf" || state.loading) return;
  const token = state.renderToken + 1;
  state.renderToken = token;
  beginViewerProgress(page.pageLabel || page.name, "ページを描画中");
  try {
    const pdfPage = await page.doc.getPage(page.pageNum);
    if (token !== state.renderToken) return;
    const canvas = await renderPdfPageToCanvas(pdfPage, setViewerProgress);
    if (token !== state.renderToken) return;
    page.canvas = canvas;
    page.width = canvas.width;
    page.height = canvas.height;
    setViewerProgress(100, "表示準備完了");
  } catch (e) {
    console.error("[left-viewer] pdf page render failed:", page, e);
    toast("見本ページを描画できませんでした", { kind: "error", duration: 3600 });
  } finally {
    if (token === state.renderToken) {
      endViewerProgress();
      render();
    }
  }
}

function setViewerPageIndex(index) {
  if (!state.pages.length || state.loading) return;
  const next = Math.max(0, Math.min(state.pages.length - 1, index));
  if (next === state.currentIndex) return;
  state.currentIndex = next;
  state.renderToken += 1;
  render();
  emitViewerPageChange("page");
}

function moveViewerPage(delta) {
  setViewerPageIndex(state.currentIndex + delta);
}

function setDragOver(value) {
  state.dragOver = !!value;
  const area = $("spreads-viewer-area");
  const stage = $("left-viewer-stage");
  area?.classList.toggle("left-viewer-drop-active", state.dragOver);
  stage?.classList.toggle("drag-over", state.dragOver);
}

export function setLeftViewerDropHighlight(value) {
  setDragOver(value);
}

function render() {
  const stage = $("left-viewer-stage");
  if (!stage) return;
  stage.innerHTML = "";
  stage.classList.toggle("drag-over", state.dragOver);
  updateLoadButtonLabel();
  updateStageLabel();
  updatePageControls();

  const page = currentPage();
  if (!page) {
    stage.appendChild(makeEmpty());
  } else if (page.canvas) {
    renderPage(stage, page);
  } else {
    stage.appendChild(makePagePlaceholder());
    void ensureCurrentPageRendered();
  }
  if (state.loading) ensureProgressOverlay();
  else removeProgressOverlay();
  updateProgressDom();
}

function pointsFromDropPayload(payload) {
  const dpr = window.devicePixelRatio || 1;
  const values = [
    payload?.logicalPosition,
    payload?.position,
    payload?.physicalPosition,
  ].filter(Boolean);
  const points = [];
  values.forEach((pos, index) => {
    const x = Number(pos.x);
    const y = Number(pos.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    points.push({ x, y });
    if (index === 2 || dpr !== 1) points.push({ x: x / dpr, y: y / dpr });
  });
  return points;
}

function pointHitsViewer(point) {
  if (!point) return false;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const el = document.elementFromPoint(x, y);
  if (el?.closest?.("#spreads-viewer-area")) return true;
  const area = $("spreads-viewer-area");
  const rect = area?.getBoundingClientRect?.();
  return !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export function isLeftViewerDropPayload(payload) {
  if (getParallelViewMode() !== "imageViewer") return false;
  return pointsFromDropPayload(payload).some(pointHitsViewer);
}

export async function loadLeftViewerExtraFromPaths(paths, { notify = true } = {}) {
  return loadViewerPaths(paths, { notify });
}

export async function handleLeftViewerDrop(paths, payload) {
  if (!isLeftViewerDropPayload(payload)) return false;
  return loadLeftViewerExtraFromPaths(paths);
}

function bindNativeDrop(stage) {
  const pathsFromEvent = (e) => Array.from(e.dataTransfer?.files || [])
    .map((file) => file.path || file.webkitRelativePath || "")
    .filter(Boolean);

  stage.addEventListener("dragenter", (e) => {
    if (!firstViewerPath(pathsFromEvent(e))) return;
    e.preventDefault();
    setDragOver(true);
  });
  stage.addEventListener("dragover", (e) => {
    if (!firstViewerPath(pathsFromEvent(e))) return;
    e.preventDefault();
    setDragOver(true);
  });
  stage.addEventListener("dragleave", (e) => {
    if (stage.contains(e.relatedTarget)) return;
    setDragOver(false);
  });
  stage.addEventListener("drop", (e) => {
    const paths = pathsFromEvent(e);
    if (!firstViewerPath(paths)) return;
    e.preventDefault();
    setDragOver(false);
    void loadLeftViewerExtraFromPaths(paths);
  });
}

function bindWheelPageNav(stage) {
  let lastWheelMs = 0;
  const throttleMs = 120;
  stage.addEventListener("wheel", (e) => {
    if (getParallelViewMode() !== "imageViewer") return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (state.pages.length <= 1) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastWheelMs < throttleMs) return;
    lastWheelMs = now;
    moveViewerPage(e.deltaY > 0 ? +1 : -1);
  }, { passive: false });
}

export function initLeftViewerPanel() {
  if (initialized) return;
  initialized = true;
  $("left-viewer-load-b-btn")?.addEventListener("click", () => { void loadPickedViewerFiles(); });
  $("left-viewer-prev-btn")?.addEventListener("click", () => { moveViewerPage(-1); });
  $("left-viewer-next-btn")?.addEventListener("click", () => { moveViewerPage(1); });

  onParallelViewModeChange(() => {
    if (getParallelViewMode() !== "imageViewer") return;
    scheduleRender();
  });
  onPdfZoomChange(() => {
    if (getParallelViewMode() !== "imageViewer") return;
    scheduleRender();
  });

  const stage = $("left-viewer-stage");
  if (stage) bindNativeDrop(stage);
  if (stage) bindWheelPageNav(stage);
  if (stage && typeof ResizeObserver === "function") {
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(() => {
      if (getParallelViewMode() !== "imageViewer") return;
      syncProgressOverlayRect();
      scheduleRender();
    });
    resizeObserver.observe(stage);
  }
  window.addEventListener("resize", syncProgressOverlayRect);

  render();
}
