import { getFonts } from "./state.js";

// psName ごとに一度だけファイルを読んで FontFace を登録する。
// 登録済みフォントは document.fonts に常駐するので以後は CSS font-family でヒットする。
const loaded = new Set();
const inflight = new Map();
let refreshTimer = null;
const changeListeners = new Set();

// 同時に走る FontFace ロードを制限。スクロール時の大量発火や PSD 初期レンダ時の
// 多数同時ロードで WebView がハングする事故を防ぐ。
const MAX_CONCURRENT = 3;
let activeLoads = 0;
const waiters = [];
function acquireSlot() {
  return new Promise((resolve) => {
    const grant = () => { activeLoads++; resolve(); };
    if (activeLoads < MAX_CONCURRENT) grant();
    else waiters.push(grant);
  });
}
function releaseSlot() {
  activeLoads--;
  const next = waiters.shift();
  if (next) next();
}

export function onFontsRegistered(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function scheduleNotify() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    for (const fn of changeListeners) {
      try { fn(); } catch (_) {}
    }
  }, 80);
}

export function ensureFontLoaded(psName) {
  if (!psName || loaded.has(psName)) return null;
  if (inflight.has(psName)) return inflight.get(psName);
  const p = (async () => {
    await acquireSlot();
    try {
      await loadFontInternal(psName);
    } finally {
      releaseSlot();
    }
  })().finally(() => inflight.delete(psName));
  inflight.set(psName, p);
  return p;
}

async function loadFontInternal(psName) {
  const font = (getFonts() ?? []).find((f) => f?.postScriptName === psName);
  if (!font || !font.path) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    // 【v1.16.0】TTC face 抽出: read_font_face_bytes を最優先で呼び、Rust 側で
    // TTC の該当 face を切り出した単独 TTF bytes を取得する。faceIndex == 0 の
    // 場合 Rust 側は元 bytes をそのまま返すので、単独 TTF/OTF も同じ経路で動く。
    // - 旧 read_binary_file 単体 → TTC 第 2 face 以降が登録できない（Yu Gothic Bold 等）
    // - read_font_face_bytes → 該当 face を抜き出した単独 TTF として登録可能
    // 失敗時は read_binary_file にフォールバックして旧挙動を保証する。
    const faceIndex = Number.isFinite(font.faceIndex) ? font.faceIndex : 0;
    let rawBytes;
    try {
      rawBytes = await invoke("read_font_face_bytes", { path: font.path, faceIndex });
    } catch (_) {
      rawBytes = await invoke("read_binary_file", { path: font.path });
    }
    // FontFace は buffer を消費するので名前ごとに新しいコピーを渡す必要がある。
    const makeBuffer = () => new Uint8Array(rawBytes).buffer;
    // family 名と PS 名の両方で登録し、cssFontFamily の "Family", "PS", sans-serif どちらでもヒットさせる。
    const names = new Set();
    if (font.name) names.add(font.name);
    if (psName) names.add(psName);
    let registered = false;
    for (const familyName of names) {
      // 既に登録済みならスキップ（HMR 等）
      try {
        const ff = new FontFace(familyName, makeBuffer(), { display: "swap" });
        await ff.load();
        document.fonts.add(ff);
        registered = true;
      } catch (e) {
        // TTC の第 2 face 以降など、FontFace が扱えないケースは暫定的にスキップ
        console.warn(`FontFace 登録失敗 (${familyName})`, e);
      }
    }
    // 【v1.16.0】最終フォールバック: 上の試行が全て失敗していたら、
    // 元の TTC bytes 全体で再挑戦する。FontFace は TTC を渡されると先頭 face を
    // 採用するため、抽出済み TTF が壊れていた場合でも何かしら登録できる可能性がある。
    if (!registered) {
      try {
        const fallbackBytes = await invoke("read_binary_file", { path: font.path });
        for (const familyName of names) {
          try {
            const ff = new FontFace(familyName, new Uint8Array(fallbackBytes).buffer, { display: "swap" });
            await ff.load();
            document.fonts.add(ff);
            registered = true;
          } catch (_) {}
        }
      } catch (_) {}
    }
    if (registered) {
      loaded.add(psName);
      scheduleNotify();
    }
  } catch (e) {
    console.warn(`フォントファイル読込失敗 ${psName}:`, e);
  }
}
