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

const container = () => document.getElementById("psd-stage");
const pageResizeObservers = new Set();
const pageRedraws = new Set();
let zoomSubscribed = false;
let rotationSubscribed = false;

const MAX_CANVAS_SIDE = 16384;

export function renderAllSpreads() {
  const root = container();
  if (!root) return;
  if (!zoomSubscribed) {
    zoomSubscribed = true;
    onPsdZoomChange(() => {
      for (const fn of pageRedraws) fn();
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
        <path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/>
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
