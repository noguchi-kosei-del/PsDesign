import {
  getCurrentPageIndex,
  getPages,
  onPageIndexChange,
  setCurrentPageIndex,
} from "./state.js";

const STORAGE_KEY = "psdesign_pagebar_visible";
const HANDLE_LENGTH = 30;

let bar = null;
let track = null;
let handle = null;
let label = null;
let toggleBtn = null;
let dragging = false;

export function initPagebar() {
  bar = document.getElementById("pagebar");
  track = document.getElementById("spread-nav-track");
  handle = document.getElementById("spread-nav-handle");
  label = document.getElementById("spread-nav-label");
  toggleBtn = document.getElementById("toggle-pagebar-btn");
  if (!bar || !track || !handle || !label || !toggleBtn) return;

  const savedCollapsed = localStorage.getItem(STORAGE_KEY) === "hidden";
  applyCollapsed(savedCollapsed);

  toggleBtn.addEventListener("click", () => {
    const nextCollapsed = !bar.classList.contains("collapsed");
    applyCollapsed(nextCollapsed);
    localStorage.setItem(STORAGE_KEY, nextCollapsed ? "hidden" : "visible");
    if (!nextCollapsed) updateHandle();
  });

  track.addEventListener("mousedown", onTrackMouseDown);
  handle.addEventListener("mousedown", onHandleMouseDown);

  onPageIndexChange(() => updateHandle());
}

function applyCollapsed(collapsed) {
  if (!bar || !toggleBtn) return;
  bar.classList.toggle("collapsed", collapsed);
  toggleBtn.title = collapsed ? "ページバーを展開" : "ページバーを折り畳む";
  toggleBtn.setAttribute("aria-label", toggleBtn.title);
}

export function renderPagebar() {
  updateHandle();
}

function updateHandle() {
  if (!bar || !handle || !label) return;
  const total = getPages().length;
  if (total === 0) {
    handle.style.display = "none";
    label.textContent = "";
    return;
  }
  handle.style.display = "flex";
  const idx = Math.max(0, Math.min(total - 1, getCurrentPageIndex()));
  const ratio = total <= 1 ? 0 : idx / (total - 1);
  handle.style.top = `calc(${ratio * 100}% - ${ratio * HANDLE_LENGTH}px)`;
  label.textContent = `${idx + 1} / ${total}`;
}

function pageFromClientY(clientY) {
  if (!track) return 0;
  const rect = track.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  const total = getPages().length;
  if (total === 0) return 0;
  return Math.round(ratio * (total - 1));
}

function onTrackMouseDown(e) {
  if (handle && (e.target === handle || handle.contains(e.target))) return;
  e.preventDefault();
  setCurrentPageIndex(pageFromClientY(e.clientY));
  startDrag();
}

function onHandleMouseDown(e) {
  e.preventDefault();
  e.stopPropagation();
  startDrag();
}

function startDrag() {
  if (dragging) return;
  dragging = true;
  handle.classList.add("dragging");
  const onMove = (ev) => {
    if (!dragging) return;
    setCurrentPageIndex(pageFromClientY(ev.clientY));
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}
