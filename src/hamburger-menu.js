import { clearPages, clearTxtSource, setFolder } from "./state.js";
import { renderAllSpreads } from "./spread-view.js";
import { renderPagebar } from "./pagebar.js";
import { rebuildLayerList } from "./text-editor.js";
import { confirmDialog } from "./ui-feedback.js";

const THEME_KEY = "psdesign_theme";
const FLIPPED_KEY = "psdesign_layout_flipped";

const $ = (id) => document.getElementById(id);

let menuOpen = false;

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

function loadTheme() {
  const saved = localStorage.getItem(THEME_KEY) || "dark";
  applyTheme(saved);
  return saved;
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  localStorage.setItem(THEME_KEY, next);
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
    message: "読み込んだpsd、テキストがリセットされます。よろしいですか？",
    confirmLabel: "戻る",
  });
  if (!ok) return;
  setFolder(null);
  clearPages();
  clearTxtSource();
  renderAllSpreads();
  renderPagebar();
  rebuildLayerList();
  const saveBtn = document.getElementById("save-btn");
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.setAttribute("aria-expanded", "false");
  }
  const saveMenu = document.getElementById("save-menu");
  if (saveMenu) saveMenu.hidden = true;
  closeMenu();
}

export function initHamburgerMenu() {
  loadTheme();
  loadFlipped();

  const trigger = $("hamburger-btn");
  const closeBtn = $("hamburger-close-btn");
  const overlay = $("hamburger-overlay");
  const flipBtn = $("workspace-flip-btn");
  const theme = $("theme-toggle-btn");
  const home = $("home-btn");

  if (trigger) trigger.addEventListener("click", toggleMenu);
  if (closeBtn) closeBtn.addEventListener("click", closeMenu);
  if (overlay) overlay.addEventListener("click", closeMenu);
  if (flipBtn) flipBtn.addEventListener("click", toggleFlipped);
  if (theme) theme.addEventListener("click", toggleTheme);
  if (home) home.addEventListener("click", goHome);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menuOpen) {
      e.preventDefault();
      closeMenu();
    }
  });
}
