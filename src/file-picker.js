// カスタムファイル選択ダイアログ。OS ネイティブの open()/save() の代替として、
// アプリ内で完結する中央モーダル UI を提供する。
//
// 単一の export `openFileDialog(opts)` を提供し、opts.mode で動作を切替える:
//   - "open"       : ファイル単一 / 複数選択
//   - "save"       : ファイル名入力欄付き保存
//   - "openFolder" : フォルダ選択（ファイル行は disabled）
//
// 戻り値:
//   - mode:"open"          → multiple:true なら string[]、false なら string
//   - mode:"save"           → 保存パス（ファイル名込み）の string
//   - mode:"openFolder"     → フォルダパス string
//   キャンセル時は null。
//
// ナビゲーション履歴は校正パネル (proofread.js) と同じ navStack/forwardStack 方式。
// 起点パスは defaultPath → localStorage(rememberKey) → home_dir() の優先順で解決。

import { baseName, parentDir } from "./utils/path.js";

const $ = (id) => document.getElementById(id);

const STORAGE_PREFIX = "psdesign_file_picker_last_path__";

// 状態（モーダル単一インスタンスを再利用）
let resolveCurrent = null;
let currentOpts = null;
let currentPath = "";
let navStack = [];
let forwardStack = [];
let entries = []; // 表示中のフィルタ済みエントリ
let selectedPaths = new Set();
let lastClickIndex = -1;
let drives = [];
let isBusy = false;
// outside-click を mousedown→click 経路で見ると一連で誤発火することがあるので、
// 開いた直後の同一イベントループ中の click を無視するフラグ。
let backdropClickArmed = false;

function buildExtRegex(filters) {
  if (!filters || filters.length === 0) return null;
  const exts = filters.flatMap((f) => f.extensions ?? []).filter(Boolean);
  if (exts.length === 0) return null;
  // ドットを許す/許さない両対応
  const escaped = exts.map((e) => e.replace(/^\./, "").toLowerCase());
  return new RegExp(`\\.(?:${escaped.join("|")})$`, "i");
}

function readLastPath(rememberKey) {
  if (!rememberKey) return null;
  try {
    return localStorage.getItem(STORAGE_PREFIX + rememberKey) || null;
  } catch {
    return null;
  }
}

function writeLastPath(rememberKey, dirPath) {
  if (!rememberKey || !dirPath) return;
  try {
    localStorage.setItem(STORAGE_PREFIX + rememberKey, dirPath);
  } catch {}
}

async function getInitialPath(opts) {
  if (opts.defaultPath) return opts.defaultPath;
  const remembered = readLastPath(opts.rememberKey);
  if (remembered) return remembered;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const home = await invoke("home_dir");
    return typeof home === "string" ? home : null;
  } catch {
    return null;
  }
}

async function fetchDrives() {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const list = await invoke("list_drives");
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.error("[file-picker] list_drives failed:", e);
    return [];
  }
}

async function fetchEntries(dirPath) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("list_directory_entries", { path: dirPath });
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isPathRoot(p) {
  if (!p) return true;
  // Windows ドライブルート: "C:\" / "C:/" / "C:"
  if (/^[A-Za-z]:[\\/]?$/.test(p)) return true;
  // POSIX ルート
  if (p === "/") return true;
  return false;
}

function getCurrentDriveLetter(p) {
  if (!p) return null;
  const m = p.match(/^([A-Za-z]):/);
  return m ? `${m[1].toUpperCase()}:` : null;
}

const FOLDER_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
const FILE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

function renderDrives() {
  const host = $("file-picker-drives");
  if (!host) return;
  const currentLetter = getCurrentDriveLetter(currentPath);
  host.innerHTML = "";
  for (const d of drives) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "file-picker-drive-btn";
    btn.textContent = d.letter;
    btn.title = d.path;
    if (d.letter.toUpperCase() === (currentLetter || "")) {
      btn.classList.add("active");
    }
    btn.addEventListener("click", () => {
      void navigateInto(d.path);
    });
    host.appendChild(btn);
  }
}

function renderPath() {
  const el = $("file-picker-path");
  if (el) {
    el.textContent = currentPath || "";
    el.title = currentPath || "";
  }
  const back = $("file-picker-back-btn");
  const fwd = $("file-picker-forward-btn");
  const up = $("file-picker-up-btn");
  if (back) back.disabled = navStack.length === 0;
  if (fwd) fwd.disabled = forwardStack.length === 0;
  if (up) up.disabled = isPathRoot(currentPath);
}

function renderList() {
  const list = $("file-picker-list");
  if (!list) return;
  list.innerHTML = "";
  if (entries.length === 0) {
    list.innerHTML = '<div class="file-picker-empty">このフォルダには表示できる項目がありません</div>';
    return;
  }
  const collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });
  // フォルダ → ファイルの順、それぞれ自然順
  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
  entries = sorted;
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const row = document.createElement("div");
    row.className = "file-picker-row";
    row.classList.add(e.isDirectory ? "folder" : "file");
    row.dataset.index = String(i);
    row.dataset.path = e.path;
    row.tabIndex = -1;

    // mode に応じて disabled 化
    if (currentOpts.mode === "openFolder" && !e.isDirectory) {
      row.classList.add("disabled");
    }
    if (selectedPaths.has(e.path)) row.classList.add("selected");

    const icon = document.createElement("span");
    icon.className = "file-picker-row-icon";
    icon.innerHTML = e.isDirectory ? FOLDER_ICON : FILE_ICON;
    row.appendChild(icon);

    const name = document.createElement("span");
    name.className = "file-picker-row-name";
    name.textContent = e.name;
    row.appendChild(name);

    row.addEventListener("click", (ev) => onRowClick(ev, i, e));
    row.addEventListener("dblclick", (ev) => onRowDblClick(ev, i, e));
    fragment.appendChild(row);
  }
  list.appendChild(fragment);
  syncRowSelectionDom();
}

function syncRowSelectionDom() {
  const list = $("file-picker-list");
  if (!list) return;
  for (const row of list.querySelectorAll(".file-picker-row")) {
    const p = row.dataset.path;
    row.classList.toggle("selected", selectedPaths.has(p));
  }
}

function updateConfirmState() {
  const btn = $("file-picker-confirm-btn");
  const counter = $("file-picker-counter");
  if (!btn) return;
  const mode = currentOpts.mode;
  let canConfirm = false;
  let label = "開く";
  if (mode === "open") {
    label = currentOpts.multiple ? `開く${selectedPaths.size > 0 ? ` (${selectedPaths.size})` : ""}` : "開く";
    canConfirm = selectedPaths.size >= 1;
  } else if (mode === "save") {
    label = "保存";
    const input = $("file-picker-name-input");
    canConfirm = !!input && input.value.trim().length > 0;
  } else if (mode === "openFolder") {
    label = "選択";
    canConfirm = !!currentPath;
  }
  btn.textContent = label;
  btn.disabled = !canConfirm;
  if (counter) {
    if (mode === "open" && currentOpts.multiple) {
      counter.textContent = selectedPaths.size > 0 ? `${selectedPaths.size} 件選択中` : "";
    } else {
      counter.textContent = "";
    }
  }
}

function clearSelection() {
  selectedPaths.clear();
  lastClickIndex = -1;
  syncRowSelectionDom();
  updateConfirmState();
}

function onRowClick(ev, index, entry) {
  if (currentOpts.mode === "openFolder" && !entry.isDirectory) return;

  // フォルダ行のクリック挙動は mode で異なる:
  //   open: クリックで降りる（OS ダイアログ流。dblclick も同等）
  //   save / openFolder: クリックで「現フォルダ」を変えず選択中フォルダとしてハイライト、dblclick で潜る
  if (entry.isDirectory) {
    if (currentOpts.mode === "open") {
      void navigateInto(entry.path);
      return;
    }
    // save / openFolder: 単一選択（フォルダ）
    selectedPaths.clear();
    selectedPaths.add(entry.path);
    lastClickIndex = index;
    syncRowSelectionDom();
    updateConfirmState();
    return;
  }

  // ファイル行
  const additive = ev.ctrlKey || ev.metaKey;
  const range = ev.shiftKey;
  const multi = currentOpts.mode === "open" && currentOpts.multiple;

  if (multi && range && lastClickIndex >= 0) {
    const lo = Math.min(lastClickIndex, index);
    const hi = Math.max(lastClickIndex, index);
    if (!additive) selectedPaths.clear();
    for (let i = lo; i <= hi; i++) {
      const e = entries[i];
      if (!e || e.isDirectory) continue;
      if (currentOpts.mode === "openFolder") continue;
      selectedPaths.add(e.path);
    }
  } else if (multi && additive) {
    if (selectedPaths.has(entry.path)) selectedPaths.delete(entry.path);
    else selectedPaths.add(entry.path);
    lastClickIndex = index;
  } else {
    selectedPaths.clear();
    selectedPaths.add(entry.path);
    lastClickIndex = index;
  }

  // save モードはファイル名入力欄に転送
  if (currentOpts.mode === "save") {
    const input = $("file-picker-name-input");
    if (input) input.value = entry.name;
  }

  syncRowSelectionDom();
  updateConfirmState();
}

function onRowDblClick(_ev, _index, entry) {
  if (currentOpts.mode === "openFolder" && !entry.isDirectory) return;
  if (entry.isDirectory) {
    void navigateInto(entry.path);
    return;
  }
  // ファイル → 即決定（open/save とも）
  if (currentOpts.mode === "open") {
    selectedPaths.clear();
    selectedPaths.add(entry.path);
    confirm();
  } else if (currentOpts.mode === "save") {
    const input = $("file-picker-name-input");
    if (input) input.value = entry.name;
    confirm();
  }
}

async function loadFolder(dirPath) {
  if (!dirPath) return;
  const list = $("file-picker-list");
  if (list) {
    list.innerHTML = '<div class="file-picker-loading">読み込み中…</div>';
  }
  isBusy = true;
  try {
    const raw = await fetchEntries(dirPath);
    const all = Array.isArray(raw) ? raw : [];
    // 隠しファイル（先頭が ".") は既定で非表示（フォルダ／ファイル両方）
    const visible = all.filter((e) => !e.name.startsWith("."));
    // ファイル行のフィルタ（フォルダは常に表示）
    const extRe = currentOpts.__extRegex;
    entries = visible.filter((e) => {
      if (e.isDirectory) return true;
      if (currentOpts.mode === "openFolder") return false; // フォルダ選択モードはファイル隠す
      if (!extRe) return true;
      return extRe.test(e.name);
    });
    currentPath = dirPath;
    selectedPaths.clear();
    lastClickIndex = -1;
    // 階層移動のたびに「最後に開いたフォルダ」を記憶する。確定時だけでなく
    // navigate / 戻る / 進む / 上へ のすべてで更新しておくと、ユーザーがキャンセルで
    // 閉じても最後にいた階層から再開できる。
    if (currentOpts && currentOpts.rememberKey) {
      writeLastPath(currentOpts.rememberKey, dirPath);
    }
    renderDrives();
    renderPath();
    renderList();
    updateConfirmState();
  } catch (e) {
    console.error("[file-picker] list_directory_entries failed:", e);
    if (list) {
      list.innerHTML = `<div class="file-picker-error">読み込みに失敗しました：${escapeHtml(String(e?.message ?? e))}</div>`;
    }
    currentPath = dirPath;
    entries = [];
    renderDrives();
    renderPath();
    updateConfirmState();
  } finally {
    isBusy = false;
  }
}

async function navigateInto(dirPath) {
  if (!dirPath) return;
  if (currentPath) navStack.push(currentPath);
  forwardStack = [];
  await loadFolder(dirPath);
}

async function goBack() {
  if (navStack.length === 0) return;
  if (currentPath) forwardStack.push(currentPath);
  const prev = navStack.pop();
  await loadFolder(prev);
}

async function goForward() {
  if (forwardStack.length === 0) return;
  if (currentPath) navStack.push(currentPath);
  const next = forwardStack.pop();
  await loadFolder(next);
}

async function goUp() {
  if (isPathRoot(currentPath)) return;
  const parent = parentDir(currentPath);
  if (!parent) return;
  // ドライブ直下に来た場合は "C:" を "C:\\" に整える
  let target = parent;
  if (/^[A-Za-z]:$/.test(parent)) target = `${parent}\\`;
  if (currentPath) navStack.push(currentPath);
  forwardStack = [];
  await loadFolder(target);
}

function ensureExtension(name, filters) {
  if (!filters || filters.length === 0) return name;
  const exts = filters.flatMap((f) => f.extensions ?? []).filter(Boolean);
  if (exts.length === 0) return name;
  const re = new RegExp(`\\.(?:${exts.map((e) => e.replace(/^\./, "")).join("|")})$`, "i");
  if (re.test(name)) return name;
  return `${name}.${exts[0].replace(/^\./, "")}`;
}

function joinPathForSave(dir, name) {
  if (!dir) return name;
  // 末尾が既にセパレータならそのまま結合。Windows パスっぽければ "\"、POSIX なら "/"。
  if (/[\\/]$/.test(dir)) return `${dir}${name}`;
  const useBack = /\\/.test(dir) || /^[A-Za-z]:/.test(dir);
  return `${dir}${useBack ? "\\" : "/"}${name}`;
}

function confirm() {
  if (!resolveCurrent || !currentOpts) return;
  const mode = currentOpts.mode;
  let result = null;

  if (mode === "open") {
    if (selectedPaths.size === 0) return;
    const arr = [...selectedPaths];
    result = currentOpts.multiple ? arr : arr[0];
    // 親ディレクトリを記憶
    const parent = parentDir(arr[0]);
    if (parent) writeLastPath(currentOpts.rememberKey, parent);
  } else if (mode === "save") {
    const input = $("file-picker-name-input");
    const raw = input ? input.value.trim() : "";
    if (!raw) return;
    const name = ensureExtension(raw, currentOpts.filters);
    result = joinPathForSave(currentPath, name);
    writeLastPath(currentOpts.rememberKey, currentPath);
  } else if (mode === "openFolder") {
    // フォルダ行が選ばれていればそれ、無ければ現在パス
    if (selectedPaths.size > 0) {
      result = [...selectedPaths][0];
    } else {
      result = currentPath;
    }
    if (result) writeLastPath(currentOpts.rememberKey, result);
  }

  closeAndResolve(result);
}

function cancel() {
  closeAndResolve(null);
}

// CSS の transition と一致させる。閉じるアニメーション完了後に hidden=true とする。
const ANIMATE_MS = 220;

function closeAndResolve(value) {
  const modal = $("file-picker-modal");
  removeKeyListener();
  const r = resolveCurrent;
  resolveCurrent = null;
  // 内部状態は即時リセット（次回の openFileDialog をブロックしないため）。
  // hidden=true は transition 終了後にして、ふわっと縮小・フェードアウトする。
  currentOpts = null;
  currentPath = "";
  navStack = [];
  forwardStack = [];
  entries = [];
  selectedPaths.clear();
  lastClickIndex = -1;
  drives = [];
  if (modal) {
    modal.classList.remove("visible");
    setTimeout(() => {
      // 閉じる途中で次のダイアログが開いた場合は hidden を上書きしない。
      if (modal.classList.contains("visible")) return;
      modal.hidden = true;
    }, ANIMATE_MS);
  }
  if (r) r(value);
}

function onKeyDown(e) {
  if (isBusy) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    cancel();
  } else if (e.key === "Enter") {
    // テキスト入力欄でも Enter は確定
    e.preventDefault();
    e.stopPropagation();
    const btn = $("file-picker-confirm-btn");
    if (btn && !btn.disabled) confirm();
  } else if (e.key === "Backspace") {
    // テキスト入力欄ではキャンセルしない
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (navStack.length > 0) {
      e.preventDefault();
      void goBack();
    }
  } else if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
    // ファイル名入力欄など text input 内では Ctrl+A をテキスト全選択として通す。
    // それ以外（リスト / ナビ等）はブラウザ既定の "ページ全体テキスト全選択" を抑止する
    // — そうしないとダイアログ全体が青く反転してリスト操作が事実上ロックされる。
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    e.preventDefault();
    e.stopPropagation();
  }
}

function addKeyListener() {
  document.addEventListener("keydown", onKeyDown, true);
}

function removeKeyListener() {
  document.removeEventListener("keydown", onKeyDown, true);
}

let bound = false;
function bindUiOnce() {
  if (bound) return;
  bound = true;
  const close = $("file-picker-close-btn");
  const cancelBtn = $("file-picker-cancel-btn");
  const confirmBtn = $("file-picker-confirm-btn");
  const back = $("file-picker-back-btn");
  const fwd = $("file-picker-forward-btn");
  const up = $("file-picker-up-btn");
  const modal = $("file-picker-modal");
  const input = $("file-picker-name-input");

  if (close) close.addEventListener("click", () => cancel());
  if (cancelBtn) cancelBtn.addEventListener("click", () => cancel());
  if (confirmBtn) confirmBtn.addEventListener("click", () => confirm());
  if (back) back.addEventListener("click", () => void goBack());
  if (fwd) fwd.addEventListener("click", () => void goForward());
  if (up) up.addEventListener("click", () => void goUp());
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (!backdropClickArmed) return;
      if (e.target === modal) cancel();
    });
  }
  if (input) {
    input.addEventListener("input", () => updateConfirmState());
    input.addEventListener("keydown", (e) => {
      // Enter は onKeyDown の capture で拾う
      if (e.key === "Enter") return;
    });
  }
}

export async function openFileDialog(opts) {
  const modal = $("file-picker-modal");
  if (!modal) {
    console.error("[file-picker] #file-picker-modal not found");
    return null;
  }
  if (resolveCurrent) {
    // 既に開いている場合は無視（重複呼び出し防止）
    return null;
  }

  // Promise を関数の頭で先に作って resolveCurrent を即時セットしておく。
  // これより後の rAF / await が「open 中かどうか」を resolveCurrent で
  // 判定できるようにする（後段で先に await が入ると rAF が先に発火して
  // resolveCurrent が null のまま .visible が付かない問題があった）。
  const promise = new Promise((resolve) => {
    resolveCurrent = resolve;
  });

  // デフォルト値の整備
  const mode = opts?.mode ?? "open";
  const merged = {
    mode,
    title: opts?.title ?? (mode === "save" ? "保存" : mode === "openFolder" ? "フォルダを選択" : "ファイルを開く"),
    multiple: mode === "open" ? !!opts?.multiple : false,
    filters: opts?.filters ?? null,
    rememberKey: opts?.rememberKey ?? null,
    defaultPath: opts?.defaultPath ?? null,
    defaultName: opts?.defaultName ?? "",
  };
  merged.__extRegex = mode === "openFolder" ? null : buildExtRegex(merged.filters);
  currentOpts = merged;

  bindUiOnce();

  // タイトル
  const titleEl = $("file-picker-title");
  if (titleEl) titleEl.textContent = merged.title;

  // savebar 切替
  const savebar = $("file-picker-savebar");
  if (savebar) savebar.hidden = mode !== "save";
  const input = $("file-picker-name-input");
  if (input) input.value = mode === "save" ? merged.defaultName || "" : "";

  // 初期 list 状態
  const list = $("file-picker-list");
  if (list) list.innerHTML = '<div class="file-picker-loading">読み込み中…</div>';

  modal.hidden = false;
  // 背景クリックを開いた直後に即発火させない
  backdropClickArmed = false;
  setTimeout(() => { backdropClickArmed = true; }, 50);
  // 次フレームで .visible を付けて transition を発火させる（hidden 解除と同フレームに
  // クラスを付けると初期状態が確定する前に終端状態へ飛び、アニメーションが効かない）。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (resolveCurrent) modal.classList.add("visible");
    });
  });

  navStack = [];
  forwardStack = [];
  selectedPaths.clear();
  lastClickIndex = -1;
  entries = [];
  drives = await fetchDrives();
  renderDrives();

  // 起点ディレクトリを解決して読込
  const initial = await getInitialPath(merged);
  let startPath = initial;
  if (!startPath || !(await pathLooksReadable(startPath))) {
    // ホームも取れなければ最初のドライブへ
    startPath = drives.length > 0 ? drives[0].path : (initial || "C:\\");
  }
  await loadFolder(startPath);

  // フォーカス管理
  if (mode === "save" && input) {
    input.focus();
    input.select();
  } else {
    const lst = $("file-picker-list");
    if (lst) lst.focus();
  }

  addKeyListener();

  return promise;
}

async function pathLooksReadable(p) {
  try {
    const arr = await fetchEntries(p);
    return Array.isArray(arr);
  } catch {
    return false;
  }
}
