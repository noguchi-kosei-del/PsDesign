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
import { getFileDialogMode } from "./settings.js";

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
let nativeDialogInflight = false;
// 【セキュリティ Phase 2】Rust 側 picker セッション ID（open_picker で発行）。
// browse_* / confirm_* はこの ID を必須とする。renderer は実パス文字列を登録に使わず、
// browse で得た token を confirm に渡して Rust 側に実パスを解決・登録させる。
let pickerSessionId = null;
// 表示パス → Rust 候補 token のマップ（現在表示中フォルダの entries 分のみ保持）。
let pathToToken = new Map();
// ユーザーデータ直下（%USERPROFILE%）。ここより上へは移動させない（上ボタン抑止に使う）。
let userHomePath = null;

function samePathLoose(a, b) {
  if (!a || !b) return false;
  const norm = (s) => String(s).replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
  return norm(a) === norm(b);
}
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

function isWindowsShortcutPath(path) {
  return /\.lnk$/i.test(String(path ?? ""));
}

function pathMatchesOpenFilter(path) {
  if (currentOpts?.mode !== "open") return true;
  const extRe = currentOpts.__extRegex;
  if (!extRe) return true;
  if (isWindowsShortcutPath(path)) return true;
  return extRe.test(baseName(path)) || extRe.test(path);
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

// ダイアログを開かない経路（D&D 等）からも前回フォルダ記憶を更新するための公開ヘルパー。
// 写植フローでファイルをドロップしたとき、その親フォルダを共有 rememberKey に書き込み、
// 次に「選択」を押したときダイアログが同じフォルダから開くようにする。
export function rememberPickerDir(rememberKey, dirPath) {
  writeLastPath(rememberKey, dirPath);
}

async function getInitialPath(opts) {
  if (opts.defaultPath) return opts.defaultPath;
  const remembered = readLastPath(opts.rememberKey);
  if (remembered) return remembered;
  // 既定起点はデスクトップ。取得失敗時はホームへフォールバック。
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      const desk = await invoke("desktop_dir");
      if (typeof desk === "string" && desk.length > 0) return desk;
    } catch {}
    const home = await invoke("home_dir");
    return typeof home === "string" ? home : null;
  } catch {
    return null;
  }
}

async function getInvoke() {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke;
}

async function openNativeFileDialog(opts) {
  if (nativeDialogInflight) return null;
  nativeDialogInflight = true;
  try {
    const invoke = await getInvoke();
    const initialPath = await getInitialPath(opts);
    const raw = await invoke("native_file_dialog", {
      options: {
        mode: opts.mode,
        title: opts.title,
        multiple: !!opts.multiple,
        filters: opts.filters ?? [],
        defaultPath: initialPath,
        defaultName: opts.defaultName ?? "",
      },
    });
    const arr = Array.isArray(raw) ? raw.filter((p) => typeof p === "string" && p.length > 0) : [];
    if (arr.length === 0) return null;

    if (opts.mode === "save") {
      let result = arr[0];
      const name = baseName(result);
      const ensuredName = ensureExtension(name, opts.filters);
      if (ensuredName !== name) {
        const parent = parentDir(result);
        result = parent ? joinPathForSave(parent, ensuredName) : ensuredName;
      }
      const parent = parentDir(result);
      if (parent) writeLastPath(opts.rememberKey, parent);
      return result;
    }

    if (opts.mode === "openFolder") {
      writeLastPath(opts.rememberKey, arr[0]);
      return arr[0];
    }

    const parent = parentDir(arr[0]);
    if (parent) writeLastPath(opts.rememberKey, parent);
    return opts.multiple ? arr : arr[0];
  } catch (e) {
    console.error("[file-picker] native dialog failed:", e);
    return null;
  } finally {
    nativeDialogInflight = false;
  }
}

// Rust 側 picker セッションを開く（二重起動は Rust 側で picker already open 拒否）。
async function openPickerSession() {
  const invoke = await getInvoke();
  const tryOpen = async () => {
    const res = await invoke("open_picker");
    pickerSessionId = (res && res.pickerSessionId) || (typeof res === "string" ? res : null);
  };
  try {
    await tryOpen();
  } catch (e) {
    // 万一前のセッションが残っていれば閉じてから再試行する。
    if (pickerSessionId) {
      try { await invoke("close_picker", { pickerSessionId }); } catch {}
    }
    try {
      await tryOpen();
    } catch (e2) {
      console.error("[file-picker] open_picker failed:", e2);
      pickerSessionId = null;
    }
  }
}

async function closePickerSession() {
  const id = pickerSessionId;
  pickerSessionId = null;
  pathToToken = new Map();
  if (!id) return;
  try {
    const invoke = await getInvoke();
    await invoke("close_picker", { pickerSessionId: id });
  } catch {}
}

// 上部のドライブ/フォルダ ボタン行は撤去済み（#file-picker-drives なし）。
// 起点フォルダへは「上へ」ボタンでユーザーデータ直下まで戻り、そこから選ぶ運用にする。
async function fetchDrives() {
  return [];
}

async function fetchEntries(dirPath) {
  if (!pickerSessionId) throw new Error("picker session not open");
  const invoke = await getInvoke();
  // フォルダ列挙のたびに候補 token を作り直す。
  pathToToken = new Map();
  const raw = await invoke("browse_directory_entries", { pickerSessionId, path: dirPath });
  const list = Array.isArray(raw) ? raw : [];
  // 子要素の実パスは返らないので、表示用パスを dir + name で局所再構成する
  // （ナビゲーション/表示用。確定は token 経由で Rust 側が実パスを解決・登録する）。
  return list.map((e) => {
    const path = joinPathForSave(dirPath, e.name);
    if (e.token) pathToToken.set(path, e.token);
    return {
      name: e.name,
      isDirectory: !!e.isDirectory,
      isFile: !!e.isFile,
      token: e.token,
      path,
    };
  });
}

async function fetchPathInfo(path) {
  if (!pickerSessionId) throw new Error("picker session not open");
  const invoke = await getInvoke();
  const info = await invoke("browse_path_info", { pickerSessionId, path });
  if (info && info.token) pathToToken.set(path, info.token);
  // 互換のため path も補完（呼び出し側が info.path / info.name を参照する箇所のため）。
  return { ...(info || {}), path };
}

function normalizePathInput(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return "";

  // Markdown / HTML / Explorer の「リンクのコピー」系を普通のパスに寄せる。
  const md = s.match(/^\[[^\]]*]\((.+)\)$/);
  if (md) s = md[1].trim();
  const href = s.match(/\bhref\s*=\s*["']([^"']+)["']/i);
  if (href) s = href[1].trim();

  for (let i = 0; i < 2; i++) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === "`" && last === "`")) {
      s = s.slice(1, -1).trim();
      continue;
    }
    if (first === "<" && last === ">") {
      s = s.slice(1, -1).trim();
      continue;
    }
    break;
  }

  if (/^file:/i.test(s)) {
    try {
      const url = new URL(s);
      let p = decodeURIComponent(url.pathname || "");
      if (url.host) p = `//${url.host}${p}`;
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      s = p.replace(/\//g, "\\");
    } catch {
      s = s.replace(/^file:\/+/i, "");
      if (/^[A-Za-z]:/.test(s)) s = s.replace(/\//g, "\\");
    }
  }

  return s.trim();
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
// デスクトップへのショートカット用 (lucide monitor)。
const DESKTOP_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>';

async function navigateToDesktop() {
  if (isBusy) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    let desk = null;
    try { desk = await invoke("desktop_dir"); } catch {}
    if (typeof desk !== "string" || desk.length === 0) {
      desk = await invoke("home_dir");
    }
    if (typeof desk === "string" && desk.length > 0) {
      await navigateInto(desk);
    }
  } catch (e) {
    console.error("[file-picker] navigate to desktop failed:", e);
  }
}

function renderDrives() {
  const host = $("file-picker-drives");
  if (!host) return;
  const currentLetter = getCurrentDriveLetter(currentPath);
  host.innerHTML = "";

  // 旧: C: ドライブのクイックアクセス → 新: デスクトップへのショートカット。
  // C: ドライブ自体はパス欄に "C:\" と入力 → Enter で移動できるので、
  // クイックアクセスはより使用頻度の高いデスクトップに置き換える。
  const deskBtn = document.createElement("button");
  deskBtn.type = "button";
  deskBtn.className = "file-picker-drive-btn file-picker-desktop-btn";
  deskBtn.innerHTML = DESKTOP_ICON;
  deskBtn.title = "デスクトップ";
  deskBtn.setAttribute("aria-label", "デスクトップ");
  deskBtn.addEventListener("click", () => { void navigateToDesktop(); });
  host.appendChild(deskBtn);

  // 残りのドライブ (C: 以外)
  for (const d of drives) {
    if (d.letter.toUpperCase() === "C:") continue;
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
    // input 化したので value で更新。フォーカス中はユーザーの入力中なので上書きしない。
    if (document.activeElement !== el) {
      el.value = currentPath || "";
    }
    el.title = currentPath || "";
  }
  const back = $("file-picker-back-btn");
  const fwd = $("file-picker-forward-btn");
  const up = $("file-picker-up-btn");
  if (back) back.disabled = navStack.length === 0;
  if (fwd) fwd.disabled = forwardStack.length === 0;
  // ユーザーデータ直下（%USERPROFILE%）が上限。これより上へは移動させない。
  if (up) up.disabled = isPathRoot(currentPath) || samePathLoose(currentPath, userHomePath);
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
  } else if (multi) {
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
      if (currentOpts.mode === "open" && isWindowsShortcutPath(e.path || e.name)) return true;
      return extRe.test(e.name) || extRe.test(e.path);
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
  if (isBusy) return;
  if (!dirPath) return;
  if (currentPath) navStack.push(currentPath);
  forwardStack = [];
  await loadFolder(dirPath);
}

async function navigateFromPathInput(rawPath) {
  const target = normalizePathInput(rawPath);
  if (!target) return;
  try {
    const info = await fetchPathInfo(target);
    if (info?.isDirectory) {
      if (target !== currentPath) await navigateInto(target);
      return;
    }

    if (info?.isFile) {
      if (!pathMatchesOpenFilter(target)) {
        throw new Error("この種類のファイルは選択できません");
      }
      const parent = parentDir(target);
      if (parent && parent !== currentPath) {
        await navigateInto(parent);
      }
      if (currentOpts?.mode === "save") {
        const input = $("file-picker-name-input");
        if (input) input.value = info.name || baseName(target);
      } else if (currentOpts?.mode === "open") {
        const selectedPath = entries.find((entry) => (
          entry?.isFile
          && (
            samePathLoose(entry.path, target)
            || (info.name && entry.name === info.name)
            || entry.name === baseName(target)
          )
        ))?.path ?? target;
        if (info.token && !pathToToken.has(selectedPath)) {
          pathToToken.set(selectedPath, info.token);
        }
        selectedPaths.clear();
        selectedPaths.add(selectedPath);
        lastClickIndex = entries.findIndex((entry) => entry?.path === selectedPath);
        syncRowSelectionDom();
      }
      updateConfirmState();
    }
  } catch (e) {
    console.error("[file-picker] path input failed:", e);
    const list = $("file-picker-list");
    if (list) {
      list.innerHTML = `<div class="file-picker-error">パスを開けません：${escapeHtml(String(e?.message ?? e))}</div>`;
    }
    renderPath();
  }
}

async function tokenForSelectedPath(path) {
  const existing = pathToToken.get(path);
  if (existing) return existing;
  const info = await fetchPathInfo(path);
  if (!info?.token) return null;
  pathToToken.set(path, info.token);
  return info.token;
}

async function goBack() {
  if (isBusy) return;
  if (navStack.length === 0) return;
  if (currentPath) forwardStack.push(currentPath);
  const prev = navStack.pop();
  await loadFolder(prev);
}

async function goForward() {
  if (isBusy) return;
  if (forwardStack.length === 0) return;
  if (currentPath) navStack.push(currentPath);
  const next = forwardStack.pop();
  await loadFolder(next);
}

async function goUp() {
  if (isBusy) return;
  if (isPathRoot(currentPath)) return;
  // ユーザーデータ直下より上へは行かせない。
  if (samePathLoose(currentPath, userHomePath)) return;
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

// 【セキュリティ Phase 2】確定は token 経由のみ。renderer から実パス文字列を登録に送らない。
// Rust 側が session 内 token から実パスを解決・canonical 検証してから許可リストへ登録する。
async function confirm() {
  if (!resolveCurrent || !currentOpts) return;
  const mode = currentOpts.mode;
  let result = null;
  const invoke = await getInvoke();

  try {
    if (mode === "open") {
      if (selectedPaths.size === 0) return;
      const selected = [...selectedPaths].filter(pathMatchesOpenFilter);
      const tokens = [];
      for (const path of selected) {
        const token = await tokenForSelectedPath(path);
        if (token) tokens.push(token);
      }
      if (tokens.length !== selected.length || tokens.length === 0) {
        throw new Error("選択ファイルを確定できません");
      }
      const reals = await invoke("confirm_file_picker_selection", {
        pickerSessionId,
        tokens,
      });
      const arr = Array.isArray(reals) ? reals : [reals];
      result = currentOpts.multiple ? arr : arr[0];
      const parent = parentDir(arr[0]);
      if (parent) writeLastPath(currentOpts.rememberKey, parent);
    } else if (mode === "save") {
      const input = $("file-picker-name-input");
      const raw = input ? input.value.trim() : "";
      if (!raw) return;
      const name = ensureExtension(raw, currentOpts.filters);
      // 現在フォルダの directory token を取得してから保存先を確定する。
      const dirInfo = await invoke("browse_path_info", {
        pickerSessionId,
        path: currentPath,
      });
      const directoryToken = dirInfo && dirInfo.token;
      if (!directoryToken) throw new Error("保存先フォルダを確定できません");
      result = await invoke("confirm_file_picker_save_path", {
        pickerSessionId,
        directoryToken,
        fileName: name,
      });
      writeLastPath(currentOpts.rememberKey, currentPath);
    } else if (mode === "openFolder") {
      let token = null;
      if (selectedPaths.size > 0) {
        token = pathToToken.get([...selectedPaths][0]);
      }
      if (!token && currentPath) {
        const info = await invoke("browse_path_info", {
          pickerSessionId,
          path: currentPath,
        });
        token = info && info.token;
      }
      if (!token) return;
      const reals = await invoke("confirm_file_picker_selection", {
        pickerSessionId,
        tokens: [token],
      });
      result = Array.isArray(reals) ? reals[0] : reals;
      if (result) writeLastPath(currentOpts.rememberKey, result);
    }
  } catch (e) {
    console.error("[file-picker] confirm failed:", e);
    const list = $("file-picker-list");
    if (list) {
      list.innerHTML = `<div class="file-picker-error">確定に失敗しました：${escapeHtml(String(e?.message ?? e))}</div>`;
    }
    return;
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
  // picker セッションを破棄（候補 token も Rust 側で破棄される）。
  void closePickerSession();
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
  if (e.key === "Enter" && e.target && e.target.id === "file-picker-path") {
    e.preventDefault();
    e.stopPropagation();
    const pathEl = e.target;
    void navigateFromPathInput(pathEl.value).finally(() => {
      pathEl.blur();
    });
    return;
  }
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
    if (currentOpts?.mode === "open" && currentOpts?.multiple) {
      selectedPaths.clear();
      for (const entry of entries) {
        if (!entry || entry.isDirectory) continue;
        selectedPaths.add(entry.path);
      }
      lastClickIndex = entries.findIndex((entry) => entry && !entry.isDirectory);
      syncRowSelectionDom();
      updateConfirmState();
    }
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
  const cancelBtn = $("file-picker-cancel-btn");
  const confirmBtn = $("file-picker-confirm-btn");
  const back = $("file-picker-back-btn");
  const fwd = $("file-picker-forward-btn");
  const up = $("file-picker-up-btn");
  const modal = $("file-picker-modal");
  const input = $("file-picker-name-input");

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

  // パス表示欄: コピー可能 + 直接編集してパス移動可能
  const pathEl = $("file-picker-path");
  if (pathEl) {
    // フォーカス時にテキストを全選択して Ctrl+C / 上書き貼付しやすくする
    pathEl.addEventListener("focus", () => {
      try { pathEl.select(); } catch {}
    });
    pathEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const target = normalizePathInput(pathEl.value);
        if (target && target !== currentPath) {
          void navigateFromPathInput(target);
        }
        // 移動成否に関わらずフォーカスを外す（選択ハイライトを外す）
        pathEl.blur();
      } else if (e.key === "Escape") {
        // 編集を取りやめて現在パスを再表示
        e.preventDefault();
        e.stopPropagation();
        pathEl.value = currentPath || "";
        pathEl.blur();
      }
    });
    // フォーカスが外れたら、ユーザー編集途中の値を破棄して現在パスへ戻す
    pathEl.addEventListener("blur", () => {
      pathEl.value = currentPath || "";
    });
  }
}

export async function openFileDialog(opts) {
  if (resolveCurrent) {
    // 既に開いている場合は無視（重複呼び出し防止）
    return null;
  }

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

  if (getFileDialogMode() === "native") {
    return openNativeFileDialog(merged);
  }

  const modal = $("file-picker-modal");
  if (!modal) {
    console.error("[file-picker] #file-picker-modal not found");
    return null;
  }

  // Promise を関数の頭で先に作って resolveCurrent を即時セットしておく。
  // これより後の rAF / await が「open 中かどうか」を resolveCurrent で
  // 判定できるようにする（後段で先に await が入ると rAF が先に発火して
  // resolveCurrent が null のまま .visible が付かない問題があった）。
  const promise = new Promise((resolve) => {
    resolveCurrent = resolve;
  });
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
  pathToToken = new Map();
  // Rust 側 picker セッションを開いてから browse/confirm を行う。
  await openPickerSession();
  drives = await fetchDrives();
  renderDrives();

  // ユーザーデータ直下（%USERPROFILE%）を控える（上へボタンの上限 + 起点フォールバック）。
  try {
    userHomePath = await (await getInvoke())("home_dir");
  } catch {
    userHomePath = null;
  }

  // 起点ディレクトリを解決して読込
  const initial = await getInitialPath(merged);
  let startPath = initial;
  if (!startPath || !(await pathLooksReadable(startPath))) {
    // 読めなければユーザーデータ直下へ（既知フォルダのみ表示）。
    startPath = userHomePath || initial || null;
  }
  if (startPath) await loadFolder(startPath);

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
