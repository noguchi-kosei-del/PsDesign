// 環境設定（ショートカット / ページ送り反転）の状態管理 + 永続化 + 購読 API。
// MojiQ の設計を踏襲して localStorage に保存し、変更通知は Set ベースのリスナで実装。
//
// shortcut の照合は keydown event を受けて 1 関数で完結するように matchShortcut を
// 提供する。main.js の keydown ハンドラからは findShortcutMatch(event) で
// 「どのショートカットに該当するか」を一発で問い合わせる。

const STORAGE_KEY = "psdesign_settings";

// デフォルト設定。バージョン番号を持ち、将来の項目追加時に migrate() で穴埋め。
export const DEFAULT_SETTINGS = {
  version: 2,
  // ←/→ 反転。true のとき → が前ページ、← が次ページになる（縦書き右綴じ漫画など）。
  pageDirectionInverted: false,
  // 新規テキストレイヤーの初期値。アプリ起動時 / clearPages 時に state.js へ反映される。
  defaults: {
    textSize: 12,           // pt（実 pt、表示は基準PSD換算）
    textSizeStep: 0.1,      // pt（size +/- ボタンと size-input の step。0.1 / 0.5）
    leadingPct: 125,        // %（autoLeadingAmount）
    strokeWidthPx: 20,      // px（フチの太さ）
    fontPostScriptName: "", // 空文字 = 指定なし（system default）
  },
  shortcuts: {
    save:       { key: "s",          modifiers: ["ctrl"],          description: "上書き保存" },
    saveAs:     { key: "s",          modifiers: ["ctrl", "shift"], description: "別名で保存" },
    pagePrev:   { key: "ArrowLeft",  modifiers: [],                description: "前ページ" },
    pageNext:   { key: "ArrowRight", modifiers: [],                description: "次ページ" },
    pageFirst:  { key: "ArrowLeft",  modifiers: ["ctrl"],          description: "最初のページ" },
    pageLast:   { key: "ArrowRight", modifiers: ["ctrl"],          description: "最後のページ" },
    pageJump:   { key: "j",          modifiers: ["ctrl"],          description: "ページジャンプ" },
    toolSelect: { key: "v",          modifiers: [],                description: "選択ツール" },
    toolTextV:  { key: "t",          modifiers: [],                description: "縦書きツール" },
    toolTextH:  { key: "y",          modifiers: [],                description: "横書きツール" },
    zoomIn:     { key: "=",          modifiers: ["ctrl"],          description: "ズームイン" },
    zoomOut:    { key: "-",          modifiers: ["ctrl"],          description: "ズームアウト" },
    zoomReset:  { key: "0",          modifiers: ["ctrl"],          description: "ズーム 100%" },
    sizeUp:     { key: "]",          modifiers: [],                description: "文字サイズを大きく" },
    sizeDown:   { key: "[",          modifiers: [],                description: "文字サイズを小さく" },
    toggleRulers: { key: "r",        modifiers: ["ctrl"],          description: "定規の表示切替" },
    toggleFrames: { key: "h",        modifiers: ["ctrl"],          description: "テキストフレームの表示切替" },
    viewerMode:   { key: "F1",       modifiers: [],                description: "閲覧モード" },
  },
};

let settings = null;
const listeners = new Set();

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function load() {
  let parsed = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch (e) {
    console.warn("[settings] failed to parse, using defaults:", e);
  }
  settings = parsed ? migrate(parsed) : deepClone(DEFAULT_SETTINGS);
}

// 旧バージョン → 新バージョンへの穴埋め。デフォルトに無いキーは触らない（将来削除した
// 設定を残しておくと衝突検知に変な ID が出続けるため、デフォルトをホワイトリスト扱い）。
function migrate(old) {
  const out = deepClone(DEFAULT_SETTINGS);
  out.version = DEFAULT_SETTINGS.version;
  if (typeof old.pageDirectionInverted === "boolean") {
    out.pageDirectionInverted = old.pageDirectionInverted;
  }
  if (old.defaults && typeof old.defaults === "object") {
    const d = old.defaults;
    if (typeof d.textSize === "number" && Number.isFinite(d.textSize)) {
      out.defaults.textSize = d.textSize;
    }
    if (typeof d.textSizeStep === "number" && (d.textSizeStep === 0.1 || d.textSizeStep === 0.5)) {
      out.defaults.textSizeStep = d.textSizeStep;
    }
    if (typeof d.leadingPct === "number" && Number.isFinite(d.leadingPct)) {
      out.defaults.leadingPct = d.leadingPct;
    }
    if (typeof d.strokeWidthPx === "number" && Number.isFinite(d.strokeWidthPx)) {
      out.defaults.strokeWidthPx = d.strokeWidthPx;
    }
    if (typeof d.fontPostScriptName === "string") {
      out.defaults.fontPostScriptName = d.fontPostScriptName;
    }
  }
  if (old.shortcuts && typeof old.shortcuts === "object") {
    for (const id of Object.keys(out.shortcuts)) {
      const o = old.shortcuts[id];
      if (!o || typeof o !== "object") continue;
      if (typeof o.key === "string") out.shortcuts[id].key = o.key;
      if (Array.isArray(o.modifiers)) {
        out.shortcuts[id].modifiers = o.modifiers.filter(
          (m) => m === "ctrl" || m === "shift" || m === "alt",
        );
      }
      // description はデフォルト側を正とする（ユーザーが弄れない項目なので保存値を信用しない）。
    }
  }
  return out;
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error("[settings] failed to save:", e);
    return false;
  }
  for (const fn of listeners) {
    try { fn(settings); } catch (e) { console.error("[settings] listener error:", e); }
  }
  return true;
}

export function onSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getAllShortcuts() {
  if (!settings) load();
  return settings.shortcuts;
}

export function getShortcut(id) {
  if (!settings) load();
  return settings.shortcuts[id] || DEFAULT_SETTINGS.shortcuts[id] || null;
}

export function setShortcut(id, key, modifiers) {
  if (!settings) load();
  if (!settings.shortcuts[id]) return;
  settings.shortcuts[id].key = key;
  settings.shortcuts[id].modifiers = Array.isArray(modifiers) ? [...modifiers] : [];
  save();
}

export function getPageDirectionInverted() {
  if (!settings) load();
  return !!settings.pageDirectionInverted;
}

export function setPageDirectionInverted(v) {
  if (!settings) load();
  const next = !!v;
  if (settings.pageDirectionInverted === next) return;
  settings.pageDirectionInverted = next;
  save();
}

export function resetShortcuts() {
  if (!settings) load();
  settings.shortcuts = deepClone(DEFAULT_SETTINGS.shortcuts);
  save();
}

// ===== デフォルト値（新規テキストレイヤーの初期値） =====
export function getDefaults() {
  if (!settings) load();
  return { ...settings.defaults };
}

export function getDefault(key) {
  if (!settings) load();
  if (settings.defaults && Object.prototype.hasOwnProperty.call(settings.defaults, key)) {
    return settings.defaults[key];
  }
  return DEFAULT_SETTINGS.defaults[key];
}

export function setDefault(key, value) {
  if (!settings) load();
  if (!settings.defaults) settings.defaults = deepClone(DEFAULT_SETTINGS.defaults);
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS.defaults, key)) return;
  if (settings.defaults[key] === value) return;
  settings.defaults[key] = value;
  save();
}

export function resetDefaults() {
  if (!settings) load();
  settings.defaults = deepClone(DEFAULT_SETTINGS.defaults);
  save();
}

export function resetAll() {
  settings = deepClone(DEFAULT_SETTINGS);
  save();
}

// 同じ key + modifiers の組合せが他 ID に既に割り当てられているかを返す。
// ある場合は { conflict: true, with: <id>, description: <その項目名> }。
export function checkConflict(id, key, modifiers) {
  if (!settings) load();
  const sortedTarget = [...modifiers].sort().join(",");
  for (const [otherId, sc] of Object.entries(settings.shortcuts)) {
    if (otherId === id) continue;
    const sortedOther = [...(sc.modifiers || [])].sort().join(",");
    if (sc.key === key && sortedOther === sortedTarget) {
      return { conflict: true, with: otherId, description: sc.description };
    }
  }
  return { conflict: false };
}

// keydown event のキー名を「shortcut で保持する正規化キー」に変換。
// - 英字は小文字に
// - 矢印 / ファンクションキーはそのまま
// - "+"  は "=" に統一（Shift+= で発生する記号差を吸収）
// - " "  は "Space" として保持
export function normalizeKeyName(rawKey) {
  if (!rawKey) return "";
  if (rawKey === " ") return "Space";
  if (rawKey === "+") return "=";
  if (rawKey === "_") return "-";
  if (rawKey.length === 1 && /[a-zA-Z]/.test(rawKey)) return rawKey.toLowerCase();
  return rawKey;
}

// shortcut.key vs event の照合。物理キー（e.code）も併用してキーボードレイアウト差を吸収。
function keysMatch(event, key) {
  if (!key) return false;
  const norm = normalizeKeyName(event.key);
  if (norm === key) return true;
  // 数値・記号キーの物理キー対応（JIS / US 配列差や Numpad）
  if (key === "=" && (event.code === "Equal" || event.code === "NumpadAdd" || event.key === "+" || event.key === ";")) return true;
  if (key === "-" && (event.code === "Minus" || event.code === "NumpadSubtract")) return true;
  if (key === "0" && (event.code === "Digit0" || event.code === "Numpad0")) return true;
  if (key === "Space" && event.code === "Space") return true;
  return false;
}

export function matchShortcut(event, id) {
  const sc = getShortcut(id);
  if (!sc) return false;
  return matchShortcutObj(event, sc);
}

function matchShortcutObj(event, sc) {
  const mods = new Set(sc.modifiers || []);
  const wantCtrl  = mods.has("ctrl");
  const wantShift = mods.has("shift");
  const wantAlt   = mods.has("alt");
  // PsDesign は macOS の Cmd も Ctrl と等価扱い（既存実装と同じ方針）。
  const hasCtrl = !!(event.ctrlKey || event.metaKey);
  if (hasCtrl !== wantCtrl) return false;
  if (!!event.shiftKey !== wantShift) return false;
  if (!!event.altKey !== wantAlt) return false;
  return keysMatch(event, sc.key);
}

// 渡された keydown event がどの shortcut id にマッチするかを 1 件返す（無ければ null）。
// 衝突は checkConflict で防いでいる前提。万一衝突があれば最初に当たった ID を採用。
export function findShortcutMatch(event) {
  if (!settings) load();
  for (const id of Object.keys(settings.shortcuts)) {
    if (matchShortcutObj(event, settings.shortcuts[id])) return id;
  }
  return null;
}

// "Ctrl + Shift + S" のような表示用文字列。
export function formatShortcutDisplay(sc) {
  if (!sc) return "";
  const parts = [];
  const mods = sc.modifiers || [];
  if (mods.includes("ctrl"))  parts.push("Ctrl");
  if (mods.includes("shift")) parts.push("Shift");
  if (mods.includes("alt"))   parts.push("Alt");
  let k = sc.key;
  if (k === "ArrowLeft")  k = "←";
  else if (k === "ArrowRight") k = "→";
  else if (k === "ArrowUp")    k = "↑";
  else if (k === "ArrowDown")  k = "↓";
  else if (k === "Space")      k = "Space";
  else if (k.length === 1)     k = k.toUpperCase();
  parts.push(k);
  return parts.join(" + ");
}

// 起動時に 1 度だけ読込。明示初期化が無くても getter から自動 load される。
load();
