import { clearPages, clearTxtSource, setFolder } from "./state.js";
import { renderAllSpreads } from "./spread-view.js";
import { renderPagebar } from "./pagebar.js";
import { rebuildLayerList } from "./text-editor.js";
import { confirmDialog } from "./ui-feedback.js";

const THEME_KEY = "psdesign_theme";
const SIDEBAR_KEY = "psdesign_sidebar_hidden";

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

function applySidebar(hidden) {
  const ws = document.querySelector(".workspace");
  if (!ws) return;
  ws.classList.toggle("hide-sidebar", hidden);
  const btn = $("sidebar-toggle-btn");
  if (btn) btn.classList.toggle("active", hidden);
}

function loadSidebar() {
  const saved = localStorage.getItem(SIDEBAR_KEY) === "1";
  applySidebar(saved);
  return saved;
}

function toggleSidebar() {
  const ws = document.querySelector(".workspace");
  if (!ws) return;
  const nextHidden = !ws.classList.contains("hide-sidebar");
  applySidebar(nextHidden);
  localStorage.setItem(SIDEBAR_KEY, nextHidden ? "1" : "0");
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
  loadSidebar();

  const trigger = $("hamburger-btn");
  const closeBtn = $("hamburger-close-btn");
  const overlay = $("hamburger-overlay");
  const sidebar = $("sidebar-toggle-btn");
  const theme = $("theme-toggle-btn");
  const home = $("home-btn");

  if (trigger) trigger.addEventListener("click", toggleMenu);
  if (closeBtn) closeBtn.addEventListener("click", closeMenu);
  if (overlay) overlay.addEventListener("click", closeMenu);
  if (sidebar) sidebar.addEventListener("click", toggleSidebar);
  if (theme) theme.addEventListener("click", toggleTheme);
  if (home) home.addEventListener("click", goHome);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menuOpen) {
      e.preventDefault();
      closeMenu();
    }
  });
}
