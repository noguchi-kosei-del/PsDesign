import {
  clearScanExtractDoc,
  clearPages,
  clearPdf,
  clearTxtSource,
  setActivePane,
  setAppMode,
  setFolder,
  setFontPickerStuck,
  setParallelSyncMode,
  setPdfPageIndex,
  setPdfRotation,
  setPdfSkipFirstBlank,
  setPdfSplitMode,
  setPdfZoom,
  setPsdRotation,
  setPsdZoom,
} from "./state.js";
import { renderAllSpreads } from "./spread-view.js";
import { rebuildLayerList } from "./text-editor.js";
import { renderTxtSourceViewer } from "./txt-source.js";
import { confirmDialog } from "./ui-feedback.js";
import { openSettingsModal } from "./settings-ui.js";
import { clearAllGuides, setGuidesLocked } from "./rulers.js";
import { resetAutoPlaceState } from "./auto-place.js";
import { resetStylePaletteState } from "./style-palette.js";
import { runTestMode } from "./test-mode.js";
import { clearLeftViewer } from "./left-viewer.js";

const FLIPPED_KEY = "psdesign_layout_flipped";
const HOME_RETURN_ANIMATION_MS = 360;

const $ = (id) => document.getElementById(id);

let menuOpen = false;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applyFlipped(flipped) {
  const ws = document.querySelector(".workspace");
  if (!ws) return;
  ws.classList.toggle("flipped", flipped);
  const btn = $("workspace-flip-btn");
  if (btn) btn.classList.toggle("flipped", flipped);
}

function loadFlipped() {
  const saved = localStorage.getItem(FLIPPED_KEY) === "1";
  applyFlipped(saved);
  return saved;
}

function toggleFlipped() {
  const ws = document.querySelector(".workspace");
  if (!ws) return;
  const nextFlipped = !ws.classList.contains("flipped");
  applyFlipped(nextFlipped);
  localStorage.setItem(FLIPPED_KEY, nextFlipped ? "1" : "0");
}

function openMenu() {
  const menu = $("hamburger-menu");
  const overlay = $("hamburger-overlay");
  if (!menu || !overlay) return;
  menuOpen = true;
  overlay.hidden = false;
  menu.hidden = false;
  requestAnimationFrame(() => {
    overlay.classList.add("open");
    menu.classList.add("open");
  });
}

function closeMenu() {
  const menu = $("hamburger-menu");
  const overlay = $("hamburger-overlay");
  if (!menu || !overlay) return;
  menuOpen = false;
  overlay.classList.remove("open");
  menu.classList.remove("open");
  setTimeout(() => {
    if (menuOpen) return;
    overlay.hidden = true;
    menu.hidden = true;
  }, 280);
}

function toggleMenu() {
  if (menuOpen) closeMenu();
  else openMenu();
}

async function goHome() {
  const ok = await confirmDialog({
    title: "ホームに戻る",
    message: "読み込んだpsd、テキスト、PDF、ビューアー画像がリセットされます。よろしいですか？",
    confirmLabel: "戻る",
  });
  if (!ok) return;
  setFolder(null);
  // 写植再利用モードを解除して通常モードに戻す。
  setAppMode("normal");
  clearPages();
  clearTxtSource();
  clearScanExtractDoc();
  setFontPickerStuck(false);
  setGuidesLocked(false);
  clearAllGuides();
  resetAutoPlaceState();
  resetStylePaletteState();
  clearLeftViewer();
  clearPdf();
  setPdfRotation(0);
  setPsdRotation(0);
  setPdfSplitMode(false);
  setPdfSkipFirstBlank(false);
  setParallelSyncMode(true);
  setActivePane("psd");
  setPdfPageIndex(0);
  setPdfZoom(1);
  setPsdZoom(1);
  renderAllSpreads();
  rebuildLayerList();
  renderTxtSourceViewer();
  // main.js が購読している統合シグナルを発火し、
  // ステージラベルバーのボタン (回転 / ガイドロック / ガイド反映) を再評価させる。
  window.dispatchEvent(new CustomEvent("psdesign:psd-loaded"));
  document.body.classList.add("home-returning");
  await wait(HOME_RETURN_ANIMATION_MS);
  document.body.classList.add("home-mode");
  document.body.classList.remove("home-returning");
  closeMenu();
}

export function initHamburgerMenu() {
  loadFlipped();

  const trigger = $("hamburger-btn");
  const closeBtn = $("hamburger-close-btn");
  const overlay = $("hamburger-overlay");
  const flipBtn = $("workspace-flip-btn");
  const settings = $("settings-btn");
  const home = $("home-btn");
  const testMode = $("test-mode-btn");

  if (trigger) trigger.addEventListener("click", toggleMenu);
  if (closeBtn) closeBtn.addEventListener("click", closeMenu);
  if (overlay) overlay.addEventListener("click", closeMenu);
  if (flipBtn) flipBtn.addEventListener("click", toggleFlipped);
  if (settings) settings.addEventListener("click", () => {
    // ハンバーガーは閉じてから設定モーダルを出す（同時表示は両方とも z-index 200 系で重なるため）。
    closeMenu();
    openSettingsModal();
  });
  if (home) home.addEventListener("click", goHome);
  if (testMode) testMode.addEventListener("click", async () => {
    const started = await runTestMode();
    if (started === false) return; // 破棄キャンセル時は現状維持
    // ホーム画面で開かれていることが多いので home 系クラスを外してエディタを表示
    // （project.js leaveHomeScreen と同じ一行）。
    document.body.classList.remove("home-mode", "home-starting", "home-returning");
    closeMenu();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menuOpen) {
      e.preventDefault();
      closeMenu();
    }
  });
}
