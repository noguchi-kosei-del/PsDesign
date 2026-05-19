// 環境設定（ショートカット / ページ送り反転）の状態管理 + 永続化 + 購読 API。
// MojiQ の設計を踏襲して localStorage に保存し、変更通知は Set ベースのリスナで実装。
//
// shortcut の照合は keydown event を受けて 1 関数で完結するように matchShortcut を
// 提供する。main.js の keydown ハンドラからは findShortcutMatch(event) で
// 「どのショートカットに該当するか」を一発で問い合わせる。

const STORAGE_KEY = "psdesign_settings";
const LEGACY_SYMBOL_FONT_PS = "KozGoPr6N-Regular";
const DEFAULT_SYMBOL_FONT_PS = "KozGoPro-Heavy";

// デフォルト設定。バージョン番号を持ち、将来の項目追加時に migrate() で穴埋め。
export const DEFAULT_SETTINGS = {
  // v8: 中丸ゴシック自動切替の閾値を 0.5 (50%) に設定 + UI 側で 10% 刻みの
  //     6 段階バケット (50-59 / 60-69 / 70-79 / 80-89 / 90-99 / 100) で色分け。
  //     旧 v7 以前 (デフォルト閾値 0.9 だった想定) の保存値を破棄して新デフォルト 0.5 を強制反映。
  version: 14,
  // ←/→ 反転。true のとき → が前ページ、← が次ページになる（縦書き右綴じ漫画など）。
  pageDirectionInverted: false,
  arrowKeyMoveDistance: 1,
  // 新規テキストレイヤーの初期値 / レイアウト設定。
  //
  // 各キーに scope: タグを併記している。これは「設定変更時にどこへ反映されるか」を
  // 開発者向けに明示するもの（ユーザー UI 文言ではない）。意味:
  //   - creation-only : 新規テキストレイヤー作成時のみ参照。既存レイヤーは触らない。
  //                     設定変更でも過去のレイヤーは旧値のまま。
  //   - render-all    : canvas-tools.js の onSettingsChange(refreshAllOverlays) 経由で
  //                     全 layer-box が再描画される。プレビュー反映あり。
  //   - save-only     : Photoshop 保存時 (jsx_gen.rs) のみ参照。プレビューに変化なし。
  //                     ※ render-all との二重指定もある（プレビュー + 保存両方）。
  //
  // 設計判断: 「既存レイヤーへの即時反映」は scope を引き上げる将来拡張余地あり。
  // 現状の挙動を変えずに分類のみ明示している。
  defaults: {
    // pt（実 pt、表示は基準PSD換算）。scope: creation-only
    textSize: 12,
    // pt（size +/- ボタンと size-input の step。0.1 / 0.5）。scope: render-all
    // ※ tool 状態 (setTextSize の step 属性) に即時反映するため applyToolDefaults 経由
    textSizeStep: 0.1,
    // %（autoLeadingAmount）。scope: creation-only
    leadingPct: 125,
    // 【v1.29.0】ルビ適用時、自動でその行の行間を上書きする % 値。
    //   ユーザーが文字選択 → ルビ適用すると、対象 range が乗る行の
    //   lineLeadings[lineIndex] が rubyLeadingPct で書き換わる。
    //   またプレビューのルビ位置 (--ruby-row-leading-pct CSS variable) もこの値で
    //   駆動され、「親文字行と前の行のちょうど中間」にルビが配置される。
    //   scope: render-all (CSS variable 経由でルビ位置が即時更新) + ルビ適用時に lineLeadings 上書き
    rubyLeadingPct: 150,
    // 【v1.29.x】ルビ位置の微調整値。ビューアー (UI) と Photoshop 書き出し時の位置を別々に
    // 制御できる。ユーザーの好みで紙面写植に近い位置にチューニング可能。
    //   rubyParentOffsetEm  : UI 上のルビを行間中央から動かす em 量
    //   rubyPhotoshopOffsetEm: Photoshop 書き出し時の追加 em 補正
    //   rubyPhotoshopBiasPx : Photoshop 書き出し時の追加 px 補正
    //   デフォルトはいずれも 0。親文字行と前の行のちょうど中間を基準にする。
    //   scope: render-all (CSS) + save (JSX 経由で Photoshop 反映)
    rubyParentOffsetEm: 0,
    rubyPhotoshopOffsetEm: 0,
    rubyPhotoshopBiasPx: 0,
    // px（フチの太さ）。scope: creation-only
    strokeWidthPx: 20,
    // 空文字 = 指定なし（system default）。scope: creation-only
    fontPostScriptName: "",
    // 選択中レイヤー下部のフォント名 + サイズバッジ（true: 表示 / false: 非表示）。
    // scope: render-all（refreshAllOverlays で全 layer-box の badge 有無が即時切替）
    showBadge: true,
    // ‰（千分率）。連続記号のツメ量を group 別に保持。0 = OFF、負値（または絶対値）で詰まる。
    // 連続ランの最後の 1 文字は常に 0 のまま（後続文字との字間が詰まりすぎないように）。
    // scope: render-all + save（プレビューと Photoshop 保存両方に反映）
    dashTrackingMille: -100,   // legacy: old UI key; no longer used by preview/save paths.
    tildeTrackingMille: -300,  // legacy: old UI key; no longer used by preview/save paths.
    dashRunTrackingMille: -100,   // ダッシュ系（— ― – ‒ ‐ ‑ ー －）の連続詰め
    tildeRunTrackingMille: -300,  // legacy: old tilde tracking key.
    tildeRunKerningMille: -300,  // チルダ系（〜 ～）の連続カーニング
    // 縦書きの新規レイヤーで半角 !! / !? を自動的に「縦中横」(text-combine-upright) に
    // するか。Photoshop 書き戻しでも textStyleRange の tcy 属性を立てる。
    // scope: render-all + save
    tateChuYokoEnabled: true,
    // 記号類（♡♥★☆♪♫♬♩♯♭→←↑↓〇○●△▲▽▼□■◇◆♠♣♦◎ など）を別フォントで自動置換するか。
    // ON のときプレビュー / Photoshop 書き戻し両方で symbolFontPostScriptName に置換される。
    // ユーザーが per-char で手動指定したフォントは尊重（自動置換 skip）。
    // scope: render-all + save
    symbolFontReplaceEnabled: true,
    symbolFontPostScriptName: DEFAULT_SYMBOL_FONT_PS, // 小塚ゴシック Pro H / scope: render-all + save
    // 句読点「、」(U+3001) と「。」(U+3002) を Photoshop 保存時にツメ N% で組む。
    // 0 で OFF。v1.24.0 でプレビュー / bbox / 自動配置にも反映済み（render-all + save）。
    // scope: render-all + save
    punctuationTsumePercent: 50,
    // 縦書きレイヤーで半角の英数字 (0-9 / a-z / A-Z) を全角 (０-９ / ａ-ｚ / Ａ-Ｚ) に
    // 自動変換するか。サイドバー / エディタモードの新規入力、自動配置の contents 生成、
    // 自動配置済みレイヤーの TXT 追従同期に共通適用される（横書きと既存レイヤーには無影響）。
    // scope: creation-only（設定 ON でも過去に半角で配置されたレイヤーはそのまま）
    verticalHalfToFullEnabled: true,

    // 【v1.26.0 移植 (PsDesign-main v1.24.0)】自動配置で吹き出し外周の白率が低い
    // (= フキダシ外 / フキダシ内に絵柄あり) 場合に白フチを自動付与するか。Rust 側
    // (ocr.rs analyze_doc_in_place) が各 block の周辺白率 (0..1) を計算済み。
    // ユーザーが手動で別の strokeColor を選んでいる場合は上書きせず尊重。
    // scope: creation-only (自動配置で新規作成されるレイヤーにのみ反映)
    autoStrokeEnabled: true,
    autoStrokeWhiteRatioThreshold: 0.7,   // 周辺白率がこの値未満なら白フチ付与

    // 【v1.26.0 移植】自動配置で「背景上 (フキダシ無し)」または「ウニフラッシュ吹き出し」
    // を検出したら指定フォントに切り替えるか (デフォルト ON)。
    // ai-place.js で 0..1 の合成スコアを算出し、cloudShapeScoreThreshold 以上で切替。
    //   背景スコア = 1 - white_ratio                        (周囲が黒いほど高い)
    //   ウニスコア = min(min_seg_edge_changes / 6, 1.0)     (全周分布の凹凸ほど高い)
    //   max(背景, ウニ) >= 閾値 (デフォルト 0.5 = 50%) で発火。
    // UI では bucket = floor((score - 0.5) / 0.1) で 10% 刻みの 6 段階に分類して色分け。
    // scope: creation-only
    cloudShapeFontEnabled: true,
    cloudShapeScoreThreshold: 0.5,        // 0..1 (50% = 0.5)
    cloudShapeFontPostScriptName: "DFGMaruGothic-Md", // 中丸ゴシック (環境依存。空ならフォント差し替えしない)
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
    zoomIn:     { key: "=",          modifiers: ["ctrl"],          description: "ズームイン" },
    zoomOut:    { key: "-",          modifiers: ["ctrl"],          description: "ズームアウト" },
    zoomReset:  { key: "0",          modifiers: ["ctrl"],          description: "ズーム 100%" },
    sizeUp:     { key: "]",          modifiers: [],                description: "文字サイズを大きく" },
    sizeDown:   { key: "[",          modifiers: [],                description: "文字サイズを小さく" },
    toggleRulers: { key: "r",        modifiers: ["ctrl"],          description: "定規の表示切替" },
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
  if (typeof old.arrowKeyMoveDistance === "number" && Number.isFinite(old.arrowKeyMoveDistance)) {
    out.arrowKeyMoveDistance = Math.max(0.1, Math.min(100, Math.round(old.arrowKeyMoveDistance * 100) / 100));
  }
  if (old.defaults && typeof old.defaults === "object") {
    const d = old.defaults;
    if (typeof d.textSize === "number" && Number.isFinite(d.textSize)) {
      out.defaults.textSize = d.textSize;
    }
    if (typeof d.textSizeStep === "number" && (d.textSizeStep === 0.1 || d.textSizeStep === 0.25 || d.textSizeStep === 0.5)) {
      out.defaults.textSizeStep = d.textSizeStep;
    }
    if (typeof d.leadingPct === "number" && Number.isFinite(d.leadingPct)) {
      out.defaults.leadingPct = d.leadingPct;
    }
    // 【v1.29.0】ルビあり行間（50-500% にクランプ）
    if (typeof d.rubyLeadingPct === "number" && Number.isFinite(d.rubyLeadingPct)) {
      out.defaults.rubyLeadingPct = Math.max(50, Math.min(500, d.rubyLeadingPct));
    }
    // 【v1.31.1】ルビ位置は行間中央をデフォルトに戻す。version 11 以前の親寄せ補正は
    // 自動移行で破棄し、version 12 以降にユーザーが明示保存した値だけ尊重する。
    const oldVersionForRubyOffset = Number.isFinite(old.version) ? old.version : 0;
    if (oldVersionForRubyOffset >= 12) {
      if (typeof d.rubyParentOffsetEm === "number" && Number.isFinite(d.rubyParentOffsetEm)) {
        out.defaults.rubyParentOffsetEm = Math.max(-2, Math.min(2, d.rubyParentOffsetEm));
      }
      if (typeof d.rubyPhotoshopOffsetEm === "number" && Number.isFinite(d.rubyPhotoshopOffsetEm)) {
        out.defaults.rubyPhotoshopOffsetEm = Math.max(-2, Math.min(2, d.rubyPhotoshopOffsetEm));
      }
      if (typeof d.rubyPhotoshopBiasPx === "number" && Number.isFinite(d.rubyPhotoshopBiasPx)) {
        out.defaults.rubyPhotoshopBiasPx = Math.max(-100, Math.min(100, d.rubyPhotoshopBiasPx));
      }
    }
    if (typeof d.strokeWidthPx === "number" && Number.isFinite(d.strokeWidthPx)) {
      out.defaults.strokeWidthPx = d.strokeWidthPx;
    }
    if (typeof d.fontPostScriptName === "string") {
      out.defaults.fontPostScriptName = d.fontPostScriptName;
    }
    if (typeof d.showBadge === "boolean") {
      out.defaults.showBadge = d.showBadge;
    }
    // 【v1.30.2 リセット】version 9 以前で保存された dashTrackingMille / tildeTrackingMille は
    // バグで両方が同じ値 (例: 両方 -300) になっているケースがあるため強制リセット。
    // version 10 以降の保存値のみ尊重する (= ユーザーが意図的に変えた値は保持)。
    const oldVer = Number.isFinite(old.version) ? old.version : 0;
    if (oldVer >= 10) {
      if (typeof d.dashTrackingMille === "number" && Number.isFinite(d.dashTrackingMille)) {
        out.defaults.dashTrackingMille = d.dashTrackingMille;
      }
      if (typeof d.tildeTrackingMille === "number" && Number.isFinite(d.tildeTrackingMille)) {
        out.defaults.tildeTrackingMille = d.tildeTrackingMille;
      }
    }
    if (typeof d.dashRunTrackingMille === "number" && Number.isFinite(d.dashRunTrackingMille)) {
      out.defaults.dashRunTrackingMille = d.dashRunTrackingMille;
    }
    if (typeof d.tildeRunTrackingMille === "number" && Number.isFinite(d.tildeRunTrackingMille)) {
      out.defaults.tildeRunTrackingMille = d.tildeRunTrackingMille;
      out.defaults.tildeRunKerningMille = d.tildeRunTrackingMille;
    }
    if (typeof d.tildeRunKerningMille === "number" && Number.isFinite(d.tildeRunKerningMille)) {
      out.defaults.tildeRunKerningMille = d.tildeRunKerningMille;
    }
    // version 9 以前: dashTrackingMille / tildeTrackingMille は DEFAULT_SETTINGS の値
    // (-100 / -300) のまま (== ここで何もしないので out.defaults の初期値が維持される)
    if (typeof d.tateChuYokoEnabled === "boolean") {
      out.defaults.tateChuYokoEnabled = d.tateChuYokoEnabled;
    }
    if (typeof d.symbolFontReplaceEnabled === "boolean") {
      out.defaults.symbolFontReplaceEnabled = d.symbolFontReplaceEnabled;
    }
    if (typeof d.symbolFontPostScriptName === "string") {
      out.defaults.symbolFontPostScriptName = d.symbolFontPostScriptName === LEGACY_SYMBOL_FONT_PS
        ? DEFAULT_SYMBOL_FONT_PS
        : d.symbolFontPostScriptName;
    }
    if (typeof d.punctuationTsumePercent === "number" && Number.isFinite(d.punctuationTsumePercent)) {
      // 0-100 にクランプ
      out.defaults.punctuationTsumePercent = Math.max(0, Math.min(100, d.punctuationTsumePercent));
    }
    if (typeof d.verticalHalfToFullEnabled === "boolean") {
      out.defaults.verticalHalfToFullEnabled = d.verticalHalfToFullEnabled;
    }
    // 【v1.26.0 移植】白フチ自動付与
    if (typeof d.autoStrokeEnabled === "boolean") {
      out.defaults.autoStrokeEnabled = d.autoStrokeEnabled;
    }
    if (typeof d.autoStrokeWhiteRatioThreshold === "number"
        && Number.isFinite(d.autoStrokeWhiteRatioThreshold)) {
      out.defaults.autoStrokeWhiteRatioThreshold = Math.max(0, Math.min(1, d.autoStrokeWhiteRatioThreshold));
    }
    // 【v1.26.0 移植】中丸ゴシック自動切替。v8 以降のみ cloudShape* の保存値を尊重する。
    // v7 以前の保存値は破棄して新デフォルト 0.5 を強制反映。
    const oldVersion = Number.isFinite(old.version) ? old.version : 0;
    if (typeof d.cloudShapeFontEnabled === "boolean" && oldVersion >= 8) {
      out.defaults.cloudShapeFontEnabled = d.cloudShapeFontEnabled;
    }
    if (typeof d.cloudShapeScoreThreshold === "number"
        && Number.isFinite(d.cloudShapeScoreThreshold)
        && oldVersion >= 8) {
      out.defaults.cloudShapeScoreThreshold = Math.max(0, Math.min(1, d.cloudShapeScoreThreshold));
    }
    if (typeof d.cloudShapeFontPostScriptName === "string") {
      out.defaults.cloudShapeFontPostScriptName = d.cloudShapeFontPostScriptName;
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

export function getArrowKeyMoveDistance() {
  if (!settings) load();
  const n = Number(settings.arrowKeyMoveDistance);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS.arrowKeyMoveDistance;
}

export function setArrowKeyMoveDistance(v) {
  if (!settings) load();
  const n = Number(v);
  if (!Number.isFinite(n)) return;
  const next = Math.max(0.1, Math.min(100, Math.round(n * 100) / 100));
  if (settings.arrowKeyMoveDistance === next) return;
  settings.arrowKeyMoveDistance = next;
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
