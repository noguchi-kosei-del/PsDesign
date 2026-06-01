// 閲覧モード — PSD をウインドウいっぱいに表示してページ確認に集中するモード。
// 機能・ロジックは MojiQ ver_2.24 の js/viewer-mode.js を踏襲し、PsDesign の
// state / DOM 構造（ES module + spreads-psd-area / psd-stage）に合わせて移植。
//
// 仕様:
//   - ヘッダーの「閲覧モード」ボタン or Esc で開始/終了
//   - body.viewer-mode クラスでヘッダー・サイドバー・PDF/校正/エディタペインを
//     CSS で fade out。spreads-psd-area が flex で全領域を占有する。
//   - psdZoom を 1 にリセットし、redraw が full-window 領域にフィットさせる。
//     終了時は元の psdZoom に復帰。
//   - 画面右上にフェード式の閉じるボタン、入った直後にナビゲーションヒントを表示。
//   - ページ送りは bindWheelPageNav（既存 wheel ハンドラ）と main.js の
//     keydown shortcut（pagePrev/pageNext/pageFirst/pageLast）にそのまま乗る。

import {
  getPages,
  getPsdZoom,
  setPsdZoom,
  setActivePane,
  onPageIndexChange,
} from "./state.js";
import { capturePdfViewportCenter, schedulePdfStageLayoutRefresh } from "./pdf-view.js";
import { capturePsdViewportCenter, schedulePsdStageLayoutRefresh, setNextPsdZoomAnchorFromClientPoint } from "./spread-view.js";

const HINT_SHOW_DURATION = 3000;

let isActive = false;
let previousZoom = 1;
let previousViewportCenter = null;
let previousPdfViewportCenter = null;

let viewerBtn = null;
let navHint = null;
let closeBtn = null;
let hintHideTimer = null;
let closeBtnHideTimer = null;

const boundHandlers = {
  btnClick: null,
  closeClick: null,
  keydown: null,
  mousemove: null,
  wheel: null,
};

export function bindViewerMode() {
  // 【v2.2.x】viewer-mode-btn は上部バーから撤去 (View ▾ ドロップダウンに統合済み)。
  // 起動経路: View ▾ → toggleViewerMode 直呼び / Esc キー。終了: Esc / × ボタン。

  navHint = document.createElement("div");
  navHint.className = "viewer-nav-hint";
  navHint.textContent = "Esc または × でPSD全画面モードを終了";
  document.body.appendChild(navHint);

  closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "viewer-close-btn";
  closeBtn.title = "PSD全画面モードを終了";
  closeBtn.setAttribute("aria-label", "PSD全画面モードを終了");
  closeBtn.innerHTML =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<line x1="18" y1="6" x2="6" y2="18"/>' +
    '<line x1="6" y1="6" x2="18" y2="18"/>' +
    "</svg>";
  mountCloseBtn();

  boundHandlers.closeClick = () => exit();
  closeBtn.addEventListener("click", boundHandlers.closeClick);

  // PSD 未読込中に viewer-mode が active で残らないように、ページ変化時に確認。
  const sync = () => {
    const enabled = getPages().length > 0;
    if (!enabled && isActive) exit();
  };
  window.addEventListener("psdesign:psd-loaded", sync);
  onPageIndexChange(sync);
  sync();

  // 閲覧モードの表示/非表示ショートカットは Esc 固定。
  // 他のグローバルショートカットより先に capture で拾い、閲覧モード中は必ず終了する。
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (isActive) {
      e.preventDefault();
      e.stopImmediatePropagation();
      exit();
      return;
    }
    if (shouldIgnoreViewerEsc(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    enter();
  }, true);
}

// 閲覧モードのキーボード/ボタン経由のエントリポイント。
// 仕様: ボタン経由は起動のみ。ショートカットでの表示/非表示は Esc 固定。
function toggle() {
  if (!isActive) enter();
  // isActive のときは no-op（Esc / 右上 × ボタンが唯一の終了手段）
}

// runShortcut からも呼べる外部 API。bindViewerMode 未呼出の段階や、
// PSD 未読込時はガードで何もしない（enter 内でも getPages().length === 0 を弾く）。
function isVisibleElement(el) {
  if (!el || el.hidden) return false;
  const style = window.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
}

function hasOpenDialog() {
  const selectors = [
    '[role="dialog"]',
    ".progress-modal",
    ".reference-hidden-modal",
    ".settings-modal",
    ".key-capture-modal",
    ".font-book-modal",
    ".style-palette-modal",
    ".scan-adjust-choice-modal",
  ];
  return selectors.some((selector) =>
    Array.from(document.querySelectorAll(selector)).some(isVisibleElement),
  );
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  return !!target.closest(
    'input, textarea, select, [contenteditable="true"], .text-input-floater, .font-combobox',
  );
}

function shouldIgnoreViewerEsc(e) {
  if (e.defaultPrevented) return true;
  if (getPages().length === 0) return true;
  if (isEditableTarget(e.target)) return true;
  return hasOpenDialog();
}

export function toggleViewerMode() {
  toggle();
}

function enter() {
  if (isActive) return;
  if (getPages().length === 0) return;
  isActive = true;

  // ページナビゲーションが PSD に向くように。
  setActivePane("psd");

  previousZoom = getPsdZoom();
  previousViewportCenter = capturePsdViewportCenter();
  previousPdfViewportCenter = capturePdfViewportCenter();

  document.body.classList.add("viewer-mode");
  if (viewerBtn) viewerBtn.setAttribute("aria-pressed", "true");

  showNavHint();

  // CSS で psd-area が full-window に拡張されるので zoom=1 で fit する。
  setPsdZoom(1);
  schedulePsdStageLayoutRefresh({ durationMs: 460, recenter: true });

  showCloseBtn();

  setupEventListeners();
}

function exit() {
  if (!isActive) return;
  isActive = false;

  document.body.classList.remove("viewer-mode");
  if (viewerBtn) viewerBtn.setAttribute("aria-pressed", "false");

  if (navHint) navHint.classList.remove("show");
  hideCloseBtn();
  clearTimeout(hintHideTimer);
  clearTimeout(closeBtnHideTimer);

  cleanupEventListeners();

  setPsdZoom(previousZoom);
  // PSD は viewer-mode 中も DOM が表示されていたので即時 layout refresh で OK。
  schedulePsdStageLayoutRefresh({
    durationMs: 420,
    recenter: !previousViewportCenter,
    viewportCenter: previousViewportCenter,
  });
  // PDF area は viewer-mode 中に hidden + width:0 になっていたため、body.viewer-mode
  // を外した直後はまだ stage の clientWidth/Height が 0 のまま。ResizeObserver が
  // 走って PDF page DOM が再描画されたあとでないと、capturePdfViewportCenter の
  // 復元が正しく動かない (元の表示位置にずれる)。
  // → CSS reflow + ResizeObserver の発火を待つため複数 rAF + setTimeout で遅延させる。
  const restorePdf = () => {
    schedulePdfStageLayoutRefresh({
      durationMs: 420,
      recenter: !previousPdfViewportCenter,
      viewportCenter: previousPdfViewportCenter,
    });
  };
  requestAnimationFrame(() => requestAnimationFrame(restorePdf));
  setTimeout(restorePdf, 120);
  setTimeout(restorePdf, 320);
  previousViewportCenter = null;
  previousPdfViewportCenter = null;
}

function setupEventListeners() {
  // capture: true で、他の Esc ハンドラ（テキスト入力 floater 等）より先に
  // 拾って閲覧モードを抜ける。閲覧モード中は新しいモーダルが開く動線が無いため
  // Esc を奪っても害はない。
  boundHandlers.keydown = (e) => {
    if (!isActive) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      exit();
    }
  };

  boundHandlers.mousemove = (e) => {
    if (!isActive) return;
    // 右上 150px 圏内に入ったら閉じるボタンを再フェードイン。
    const nearCloseSide = closeButtonShouldBeRight()
      ? e.clientX > window.innerWidth - 150
      : e.clientX < 150;
    if (nearCloseSide && e.clientY < 150) {
      showCloseBtn();
    }
  };

  boundHandlers.wheel = (e) => {
    if (!isActive || !e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
    setNextPsdZoomAnchorFromClientPoint(e.clientX, e.clientY);
    setPsdZoom(getPsdZoom() * factor);
    schedulePsdStageLayoutRefresh({ durationMs: 80, recenter: false });
  };

  document.addEventListener("keydown", boundHandlers.keydown, true);
  document.addEventListener("mousemove", boundHandlers.mousemove);
  document.addEventListener("wheel", boundHandlers.wheel, { capture: true, passive: false });
}

function cleanupEventListeners() {
  if (boundHandlers.keydown) {
    document.removeEventListener("keydown", boundHandlers.keydown, true);
  }
  if (boundHandlers.mousemove) {
    document.removeEventListener("mousemove", boundHandlers.mousemove);
  }
  if (boundHandlers.wheel) {
    document.removeEventListener("wheel", boundHandlers.wheel, true);
  }
}

function showNavHint() {
  if (!navHint) return;
  navHint.classList.add("show");
  clearTimeout(hintHideTimer);
  hintHideTimer = setTimeout(() => {
    if (navHint) navHint.classList.remove("show");
  }, HINT_SHOW_DURATION);
}

function showCloseBtn() {
  if (!closeBtn) return;
  mountCloseBtn();
  closeBtn.classList.add("show");
  requestAnimationFrame(() => {
    if (!closeBtn) return;
    mountCloseBtn();
    closeBtn.classList.add("show");
  });
  clearTimeout(closeBtnHideTimer);
}

function mountCloseBtn() {
  if (!closeBtn) return;
  const parent = document.body;
  if (closeBtn.parentElement !== parent) {
    parent.appendChild(closeBtn);
  }
  syncCloseBtnPlacement();
}

function closeButtonShouldBeRight() {
  return !!document.querySelector(".workspace")?.classList.contains("flipped");
}

function syncCloseBtnPlacement() {
  if (!closeBtn) return;
  const placeRight = closeButtonShouldBeRight();
  closeBtn.classList.toggle("viewer-close-btn-right", placeRight);
  closeBtn.classList.toggle("viewer-close-btn-left", !placeRight);
}

function hideCloseBtn() {
  if (!closeBtn) return;
  closeBtn.classList.remove("show");
}
