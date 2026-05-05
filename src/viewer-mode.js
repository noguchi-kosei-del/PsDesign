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
import { matchShortcut } from "./settings.js";

const HINT_SHOW_DURATION = 3000;
const CLOSE_BTN_FADE_DELAY = 3000;

let isActive = false;
let previousZoom = 1;

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
};

export function bindViewerMode() {
  viewerBtn = document.getElementById("viewer-mode-btn");
  if (!viewerBtn) return;

  navHint = document.createElement("div");
  navHint.className = "viewer-nav-hint";
  navHint.textContent = "Esc または × で閲覧モードを終了";
  document.body.appendChild(navHint);

  closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "viewer-close-btn";
  closeBtn.title = "閲覧モードを終了";
  closeBtn.setAttribute("aria-label", "閲覧モードを終了");
  closeBtn.innerHTML =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<line x1="18" y1="6" x2="6" y2="18"/>' +
    '<line x1="6" y1="6" x2="18" y2="18"/>' +
    "</svg>";
  document.body.appendChild(closeBtn);

  boundHandlers.btnClick = () => toggle();
  boundHandlers.closeClick = () => exit();
  viewerBtn.addEventListener("click", boundHandlers.btnClick);
  closeBtn.addEventListener("click", boundHandlers.closeClick);

  // PSD 未読込時はボタンを disabled。
  // psdesign:psd-loaded（読込完了時）と onPageIndexChange（ホームに戻る等で
  // ページインデックスが変わるタイミング）の両方で再評価する。
  const sync = () => {
    const enabled = getPages().length > 0;
    viewerBtn.disabled = !enabled;
    if (!enabled && isActive) exit();
  };
  window.addEventListener("psdesign:psd-loaded", sync);
  onPageIndexChange(sync);
  sync();

  // F1 はブラウザ既定で「ヘルプ」を開くため、capture フェーズで先取り。
  // 入力欄にいても preventDefault は必ず行い、ヘルプ呼び出しを抑止する。
  // toggle() は内部で getPages().length === 0 を弾くので PSD 未読込時も安全。
  window.addEventListener(
    "keydown",
    (e) => {
      if (matchShortcut(e, "viewerMode")) {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }
    },
    { capture: true },
  );
}

// 閲覧モードのキーボード/ボタン経由のエントリポイント。
// 仕様: 起動のみ。終了は Esc に固定（F1 等のショートカット連打で意図せず抜けるのを防ぐ）。
function toggle() {
  if (!isActive) enter();
  // isActive のときは no-op（Esc / 右上 × ボタンが唯一の終了手段）
}

// runShortcut からも呼べる外部 API。bindViewerMode 未呼出の段階や、
// PSD 未読込時はガードで何もしない（enter 内でも getPages().length === 0 を弾く）。
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

  document.body.classList.add("viewer-mode");
  if (viewerBtn) viewerBtn.setAttribute("aria-pressed", "true");

  showNavHint();
  showCloseBtn();

  // CSS で psd-area が full-window に拡張されるので zoom=1 で fit する。
  setPsdZoom(1);

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
    if (e.clientX > window.innerWidth - 150 && e.clientY < 150) {
      showCloseBtn();
    }
  };

  document.addEventListener("keydown", boundHandlers.keydown, true);
  document.addEventListener("mousemove", boundHandlers.mousemove);
}

function cleanupEventListeners() {
  if (boundHandlers.keydown) {
    document.removeEventListener("keydown", boundHandlers.keydown, true);
  }
  if (boundHandlers.mousemove) {
    document.removeEventListener("mousemove", boundHandlers.mousemove);
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
  closeBtn.classList.add("show");
  clearTimeout(closeBtnHideTimer);
  closeBtnHideTimer = setTimeout(() => {
    if (closeBtn) closeBtn.classList.remove("show");
  }, CLOSE_BTN_FADE_DELAY);
}

function hideCloseBtn() {
  if (!closeBtn) return;
  closeBtn.classList.remove("show");
}

export function isViewerActive() {
  return isActive;
}
