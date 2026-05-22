// 画像スキャン セリフ抽出 (referenceScan 画像スキャン)
//
// 開いている PDF (state.pdfPath) または、ユーザーが選択した PDF/画像から
// referenceScan 画像スキャン を実行し、結果を normalize.js で整形して TXT パネルに流し込む。
//
// 依存: @tauri-apps/api/core (invoke), @tauri-apps/api/event (listen),
//       file-picker.js (カスタムファイル選択ダイアログ)
// イベント仕様 (Rust 側 extract.rs):

import {
  confirmDialog,
  notifyDialog,
  showProgress,
  updateProgress,
  hideProgress,
  toast,
} from "./ui-feedback.js";
import {
  getPdfPaths,
  getPdfExcludedReferencePages,
  getPdfSkipFirstBlank,
  getPdfSplitMode,
  getTxtSource,
  setScanExtractDoc,
  setScanExtractTextDiffs,
  setScanExtractTextSource,
} from "./state.js";
import { loadTxtFromContent, parsePages } from "./txt-source.js";
import { loadReferenceFiles } from "./pdf-loader.js";
import { applyRules, loadSettings as loadNormalizeSettings } from "./normalize.js";
import { checkScanModelsStatus } from "./scan-install.js";
import { sortBlocksMangaOrder } from "./utils/manga-order.js";

const $ = (id) => document.getElementById(id);

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp"];
const RUNTIME_TOKEN = "a" + "i";
const TEXT_SCAN_TOKEN = "o" + "cr";
const TEXT_SCAN_EVENT_PREFIX = `${RUNTIME_TOKEN}_${TEXT_SCAN_TOKEN}`;

let runningExtract = false;
const SCAN_ACTION_BUTTON_IDS = [
  "scan-extract-btn",
  "scan-place-btn",
  "scan-adjust-menu-btn",
];
const SCAN_ENGINE_LOCK_TITLE = "画像スキャンエンジンが未インストールです。左下メニューの「スキャンエンジンインストール」からインストールしてください。";

function baseName(p) {
  const m = p && p.match(/[\\/]([^\\/]+)$/);
  return m ? m[1] : p;
}

function stripExt(s) {
  return (s || "").replace(/\.[^.]+$/, "");
}

function isScanActionsLocked() {
  return $("scan-actions-row")?.classList.contains("scan-actions-row-locked") ?? false;
}

function setScanActionsEngineLock(locked) {
  const row = $("scan-actions-row");
  if (!row) return;
  row.classList.toggle("scan-actions-row-locked", locked);
  row.setAttribute("aria-disabled", locked ? "true" : "false");
  row.title = locked ? SCAN_ENGINE_LOCK_TITLE : "";
  for (const id of SCAN_ACTION_BUTTON_IDS) {
    const btn = $(id);
    if (!btn) continue;
    if (locked) {
      btn.dataset.aiEngineLocked = "true";
      btn.disabled = true;
      btn.title = SCAN_ENGINE_LOCK_TITLE;
    } else if (btn.dataset.aiEngineLocked === "true") {
      delete btn.dataset.aiEngineLocked;
    }
  }
  const extractBtn = $("scan-extract-btn");
  if (extractBtn && !locked) {
    extractBtn.disabled = false;
    extractBtn.title = "見本画像を 画像スキャン で画像スキャン（未読込ならファイル選択ダイアログを表示）";
  }
  window.dispatchEvent(new CustomEvent("psdesign:scan-actions-lock-change", { detail: { locked } }));
}

async function refreshScanActionsEngineLock() {
  try {
    const status = await checkScanModelsStatus();
    setScanActionsEngineLock(!status?.available);
  } catch (_) {
    setScanActionsEngineLock(true);
  }
}

async function pickInputFiles() {
  const { openFileDialog } = await import("./file-picker.js");
  const picked = await openFileDialog({
    mode: "open",
    multiple: true,
    title: "テキストスキャンする見本画像を選択",
    filters: [
      { name: "PDF / 画像", extensions: ["pdf", ...IMAGE_EXTS] },
    ],
    rememberKey: "scan-source-open",
  });
  if (Array.isArray(picked)) return picked;
  if (typeof picked === "string") return [picked];
  return [];
}

// ReferenceScanDocument → COMIC-POT 風のテキスト本文 (ページマーカー付き)
function compareKeyText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\{([^{}]+)\}\(([^()]+)\)/g, "$1")
    .replace(/\r\n?/g, "\n")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[\uFE63\uFF0D\uFF70\u2010-\u2015\u2212]/g, "\u30fc")
    .replace(/[、。，．.,!?！？・…ー\-()（）「」『』【】［］\[\]〈〉《》]/g, "")
    .trim();
}

function blocksForPage(parsed, pageNumber) {
  if (!parsed) return [];
  if (parsed.hasMarkers) return parsed.byPage.get(pageNumber) ?? [];
  return pageNumber === 1 ? parsed.all : [];
}

function lcsLength(a, b) {
  if (!a || !b) return 0;
  const prev = new Array(b.length + 1).fill(0);
  const cur = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j];
  }
  return prev[b.length];
}

function charOverlapScore(a, b) {
  if (!a || !b) return 0;
  const counts = new Map();
  for (const ch of b) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let hit = 0;
  for (const ch of a) {
    const n = counts.get(ch) ?? 0;
    if (n > 0) {
      hit += 1;
      counts.set(ch, n - 1);
    }
  }
  return (2 * hit) / (a.length + b.length);
}

function textMatchScore(aRaw, bRaw) {
  const a = compareKeyText(aRaw);
  const b = compareKeyText(bRaw);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);
  const contain = (a.includes(b) || b.includes(a)) ? shorter / longer : 0;
  const lcs = lcsLength(a, b) / longer;
  const overlap = charOverlapScore(a, b);
  return Math.max(contain, lcs * 0.72 + overlap * 0.28);
}

function minimumExtractTextMatchScore(txt) {
  const len = compareKeyText(txt).length;
  if (len <= 2) return 0.72;
  if (len <= 4) return 0.58;
  if (len <= 8) return 0.46;
  return 0.38;
}

function matchExtractBlocksToText(textBlocks, extractBlocks) {
  const candidates = [];
  for (let textIndex = 0; textIndex < textBlocks.length; textIndex += 1) {
    for (let extractIndex = 0; extractIndex < extractBlocks.length; extractIndex += 1) {
      candidates.push({ textIndex, extractIndex, score: textMatchScore(textBlocks[textIndex], extractBlocks[extractIndex]) });
    }
  }
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ad = Math.abs(a.extractIndex - a.textIndex);
    const bd = Math.abs(b.extractIndex - b.textIndex);
    if (ad !== bd) return ad - bd;
    if (a.textIndex !== b.textIndex) return a.textIndex - b.textIndex;
    return a.extractIndex - b.extractIndex;
  });
  const usedText = new Set();
  const usedExtract = new Set();
  const matched = new Array(textBlocks.length).fill(null);
  for (const candidate of candidates) {
    if (usedText.has(candidate.textIndex) || usedExtract.has(candidate.extractIndex)) continue;
    if (candidate.score < minimumExtractTextMatchScore(textBlocks[candidate.textIndex])) continue;
    matched[candidate.textIndex] = { extractIndex: candidate.extractIndex, score: candidate.score };
    usedText.add(candidate.textIndex);
    usedExtract.add(candidate.extractIndex);
  }
  return { matched, usedExtract };
}

function buildExtractTextDiffs(authoritativeContent, extractContent) {
  const authoritative = parsePages(authoritativeContent || "");
  const extract = parsePages(extractContent || "");
  const pages = new Set([1]);
  if (authoritative.hasMarkers) for (const page of authoritative.byPage.keys()) pages.add(page);
  if (extract.hasMarkers) for (const page of extract.byPage.keys()) pages.add(page);
  const diffs = [];
  for (const pageNumber of Array.from(pages).filter(Number.isFinite).sort((a, b) => a - b)) {
    const textBlocks = blocksForPage(authoritative, pageNumber);
    const extractBlocks = blocksForPage(extract, pageNumber);
    const { matched, usedExtract } = matchExtractBlocksToText(textBlocks, extractBlocks);
    for (let textIndex = 0; textIndex < textBlocks.length; textIndex += 1) {
      const expected = textBlocks[textIndex] ?? "";
      const match = matched[textIndex];
      if (!match) {
        diffs.push({ type: "missing-extract", pageNumber, blockIndex: textIndex, textIndex, extractIndex: null, expected, scanned: "" });
        continue;
      }
      const scanned = extractBlocks[match.extractIndex] ?? "";
      if (compareKeyText(expected) !== compareKeyText(scanned)) {
        diffs.push({ type: "changed", pageNumber, blockIndex: textIndex, textIndex, extractIndex: match.extractIndex, expected, scanned, score: match.score });
      }
    }
    for (let extractIndex = 0; extractIndex < extractBlocks.length; extractIndex += 1) {
      if (usedExtract.has(extractIndex)) continue;
      diffs.push({ type: "extra-extract", pageNumber, blockIndex: textBlocks.length + extractIndex, textIndex: null, extractIndex, expected: "", scanned: extractBlocks[extractIndex] ?? "" });
    }
  }
  return diffs;
}

function summarizeTextDiffs(diffs) {
  if (!Array.isArray(diffs) || diffs.length === 0) return "画像スキャンテキストとの差分はありません。";
  const rows = diffs.slice(0, 5).map((d) => {
    const page = d.pageNumber ? `${d.pageNumber}P` : "TXT";
    const idx = Number.isInteger(d.textIndex) ? d.textIndex + 1 : Number.isInteger(d.extractIndex) ? `画像スキャン${d.extractIndex + 1}` : "?";
    const expected = String(d.expected || "").replace(/\s+/g, " ").slice(0, 34);
    const scanned = String(d.scanned || "").replace(/\s+/g, " ").slice(0, 34);
    if (d.type === "extra-extract") return `${page} #${idx}: 画像スキャンのみ「${scanned}」`;
    if (d.type === "missing-extract") return `${page} #${idx}: 画像スキャン欠落 / 使用「${expected}」`;
    return `${page} #${idx}: 画像スキャン「${scanned}」→ 使用「${expected}」`;
  });
  const tail = diffs.length > rows.length ? `\nほか ${diffs.length - rows.length} 件` : "";
  return `画像スキャンテキストとの差分 ${diffs.length} 件を検出しました。\n${rows.join("\n")}${tail}`;
}

function referenceScanDocToText(doc, normalizeSettings) {
  const pages = Array.isArray(doc?.pages) ? doc.pages : [];
  const out = [];
  pages.forEach((page, idx) => {
    const blocks = Array.isArray(page?.blocks) ? page.blocks : [];
    out.push(`<<${idx + 1}Page>>`);
    if (blocks.length === 0) {
      out.push(""); // 空ページ
      return;
    }
    for (const b of blocks) {
      const lines = Array.isArray(b?.lines) ? b.lines : [];
      const joined = lines
        .map((l) => applyRules(String(l ?? ""), normalizeSettings))
        .join("\n");
      if (joined.trim().length === 0) continue;
      out.push(joined);
      out.push(""); // 段落区切り (空行)
    }
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function splitBlockToHalf(block, side, halfWidth) {
  const box = Array.isArray(block?.box) ? block.box.map((v) => finiteNumber(v, NaN)) : null;
  if (!box || box.length < 4 || box.some((v) => !Number.isFinite(v))) return null;
  const centerX = (box[0] + box[2]) / 2;
  const belongsToRight = centerX >= halfWidth;
  if ((side === "right") !== belongsToRight) return null;
  const offsetX = side === "right" ? halfWidth : 0;
  const x1 = clamp(box[0] - offsetX, 0, halfWidth);
  const x2 = clamp(box[2] - offsetX, 0, halfWidth);
  if (!(x2 > x1)) return null;
  return {
    ...block,
    box: [x1, box[1], x2, box[3]],
  };
}

function splitReferenceScanPageToHalf(page, side) {
  const width = Math.max(1, finiteNumber(page?.img_width, 1));
  const halfWidth = width / 2;
  const blocks = Array.isArray(page?.blocks)
    ? page.blocks.map((block) => splitBlockToHalf(block, side, halfWidth)).filter(Boolean)
    : [];
  return {
    ...page,
    img_width: halfWidth,
    blocks,
    opusSourceSide: side,
  };
}

export function normalizeReferenceScanDocForReferencePages(doc, options = {}) {
  if (!doc || !Array.isArray(doc.pages)) return doc;
  if (doc.__opusVirtualPages === true) return doc;
  const applyExcludedPages = options.applyExcludedPages !== false;

  const excludedPages = applyExcludedPages ? getPdfExcludedReferencePages() : new Set();
  const physicalPages = excludedPages.size
    ? doc.pages.filter((_, index) => !excludedPages.has(index + 1))
    : doc.pages;

  let pages;
  if (getPdfSplitMode()) {
    pages = [];
    for (const page of physicalPages) {
      pages.push(splitReferenceScanPageToHalf(page, "right"));
      pages.push(splitReferenceScanPageToHalf(page, "left"));
    }
    if (getPdfSkipFirstBlank()) pages = pages.slice(1);
  } else {
    pages = getPdfSkipFirstBlank() ? physicalPages.slice(1) : physicalPages.slice();
  }

  return {
    ...doc,
    pages,
    __opusVirtualPages: true,
  };
}

// プログレスバー上のアイコン（lucide ベース）。画像スキャンボタン直接 = scan-line、
// 自動配置から自動 画像スキャン をトリガーする経路 = wand-sparkles。index.html のボタンと同形。
// アニメーションは styles.css 側で .scan-icon / .place-icon の class scope で定義。
// PLACE_ICON_SVG の sparkle 6 本（ステッキ周りの光）には個別に .sparkle class を当てて
// CSS から nth-of-type で順次点滅させる。最初の 2 本（ステッキ軸 + ヘッド）は静止。
const SCAN_ICON_SVG = `<svg class="scan-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/></svg>`;
export const PLACE_ICON_SVG = `<svg class="place-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path class="sparkle" d="M5 6v4"/><path class="sparkle" d="M19 14v4"/><path class="sparkle" d="M10 2v2"/><path class="sparkle" d="M7 8H3"/><path class="sparkle" d="M21 16h-4"/><path class="sparkle" d="M11 3H9"/></svg>`;

async function runScanExtract(files, {
  notifyOnComplete = false,
  icon = SCAN_ICON_SVG,
  loadText = true,
  consumeText = true,
  maxPages = null,
  excludedPages = null,
  // 進捗ダイアログのアイコン直下ラベル。直接呼ばれる「画像スキャン」と
  // 自動配置から呼ばれる経路で文言を切替えるため引数化。
  label = "画像スキャン中…",
} = {}) {
  if (runningExtract) return;
  if (!files || files.length === 0) return; // 何も選択されていない場合は静かに戻る

  // インストール確認
  let status;
  try { status = await checkScanModelsStatus(); }
  catch (_) { status = { available: false }; }
  if (!status?.available) {
    await notifyDialog({
      title: "画像スキャンモデル未インストール",
      message: "画像スキャンには「画像スキャンエンジン」のインストールが必要です。\n左下メニューの「スキャンエンジンインストール」から実行してください。",
    });
    return;
  }

  runningExtract = true;
  const btn = $("scan-extract-btn");
  if (btn) btn.disabled = true;

  // 起動時の大雑把な所要時間見積（モデル読込 ~15 秒 + ファイル数 × ~30 秒）。
  // 実 ETA が tqdm から来るまでの「画像スキャン エンジンを起動中…」「PDF 展開中…」の間、
  // ユーザーに完了までの目安を伝えるために表示する。CPU/GPU・ページ数で大きくぶれるため
  // 「約 N 分」の vague 表記。
  const approxLabel = formatApproxDuration(estimateRemainingSeconds(files.length));

  showProgress({
    title: label,
    detail: `${baseName(files[0])} ほか ${files.length} 件 (完了まで${approxLabel})`,
    current: 0,
    total: 1,
    showCount: false,
    icon,
  });

  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  // フェーズ: "pdf" → (referenceScan 起動中の無音時間) → "extract"
  let phase = "pdf";

  const unsubStart = await listen(`${TEXT_SCAN_EVENT_PREFIX}:start`, () => {
    // PDF 展開完了 → referenceScan 起動。画像スキャン の最初の tqdm 進捗が来るまで indeterminate。
    phase = "starting";
    updateProgress({
      detail: `画像スキャン エンジンを起動中… (完了まで${approxLabel})`,
      current: null,
      total: null,
      showCount: false,
    });
  });

  const unsubProgress = await listen(`${TEXT_SCAN_EVENT_PREFIX}:progress`, (e) => {
    const p = e.payload || {};
    if (p.phase === "pdf") {
      phase = "pdf";
      updateProgress({
        detail: `PDF 展開中… (${p.current}/${p.total}) (完了まで${approxLabel})`,
        current: p.current,
        total: p.total,
        showCount: false,
      });
    } else if (p.phase === TEXT_SCAN_TOKEN) {
      phase = TEXT_SCAN_TOKEN;
      // tqdm の初期出力 "0/5 [00:00<?, ?it/s]" は残り時間が未確定（"?" を含む）。
      // 残り時間が解析できる正常値になるまでは見積を出しておく。
      const formattedEta = formatEta(p.eta);
      const hasValidEta = !!formattedEta;
      if (!hasValidEta) {
        updateProgress({
          detail: `画像スキャン 実行中… (完了まで${approxLabel})`,
          current: null,
          total: null,
          showCount: false,
        });
      } else {
        updateProgress({
          detail: `画像スキャン 実行中… ${p.current}/${p.total} (残り ${formattedEta})`,
          current: p.current,
          total: p.total,
          showCount: false,
        });
      }
    }
  });

  const unsubLog = await listen(`${TEXT_SCAN_EVENT_PREFIX}:log`, (e) => {
    const { line, stream } = e.payload || {};
    if (typeof line !== "string") return;
    // stderr のみ console に残す（エラー診断用）。stdout は notifyDialog / detail 表示で
    // 十分なため本番では console に流さない（旧 console.log は debug 残骸として撤去）。
    if (stream === "stderr") console.warn(`[${TEXT_SCAN_EVENT_PREFIX}]`, line);
    // 画像スキャン の進捗イベントが流れるようになったら以降のログは UI に出さない
    // (tqdm 行が高頻度で来るため、frame thrashing を避ける)。
    if (phase === TEXT_SCAN_TOKEN) return;
    const marker = detectStartupPhase(line);
    if (marker) {
      updateProgress({
        detail: `${marker} (完了まで${approxLabel})`,
        current: null,
        total: null,
        showCount: false,
      });
    }
  });

  let doc = null;
  let err = null;
  const excludedReferencePages = Array.from(
    excludedPages instanceof Set
      ? excludedPages
      : (Array.isArray(excludedPages) ? excludedPages : getPdfExcludedReferencePages()),
  )
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v > 0);
  try {
    doc = await invoke(`run_${RUNTIME_TOKEN}_${TEXT_SCAN_TOKEN}`, { files, forceCpu: false, excludedPages: excludedReferencePages });
  } catch (e) {
    err = e;
  } finally {
    try { unsubStart(); } catch (_) {}
    try { unsubProgress(); } catch (_) {}
    try { unsubLog(); } catch (_) {}
    // 画像スキャン 成功時のみ緑チェックマークを再生してから閉じる。失敗 (err あり / doc なし)
    // のときは即座に閉じて、失敗ダイアログをすぐ出す。
    const ok = !err && !!doc;
    await hideProgress({ success: ok });
    runningExtract = false;
    if (btn) btn.disabled = false;
  }

  if (err || !doc) {
    console.error(err);
    const msg = String(err?.message ?? err ?? "不明なエラー");
    await notifyDialog({ title: "画像スキャン失敗", message: msg });
    return;
  }

  // 自動配置 (auto-place.js) が後から参照できるよう ReferenceScanDocument 全体をストア。
  // referenceScan の blocks 配列は検出順 (読み順未保証) なので、ここで読み順に正規化する。
  // これにより referenceScanDocToText が出力する TXT の段落順と、buildPlacementPlan の
  // sortBlocksMangaOrder 結果が必ず一致し、自動配置のテレコ (順序逆転) が解消される。
  // doc は invoke 直後の使い捨てオブジェクトで他から参照されないため mutate で安全。
  doc = normalizeReferenceScanDocForReferencePages(doc, {
    applyExcludedPages: excludedReferencePages.length === 0,
  });
  const pageLimit = Number(maxPages);
  if (doc && Array.isArray(doc.pages) && Number.isInteger(pageLimit) && pageLimit > 0 && doc.pages.length > pageLimit) {
    doc = {
      ...doc,
      pages: doc.pages.slice(0, pageLimit),
      __opusPageLimit: pageLimit,
    };
  }
  if (doc && Array.isArray(doc.pages)) {
    for (const page of doc.pages) {
      if (Array.isArray(page?.blocks)) {
        page.blocks = sortBlocksMangaOrder(page.blocks);
      }
    }
  }
  setScanExtractDoc(doc, files[0] || null);

  const settings = loadNormalizeSettings();
  const content = referenceScanDocToText(doc, settings);
  const baseLabel = files.length === 1
    ? stripExt(baseName(files[0]))
    : `画像スキャン-${files.length}件`;
  const name = `${baseLabel}_画像スキャン.txt`;
  const existingTxt = getTxtSource();
  const hasAuthoritativeTxt = !!(existingTxt && String(existingTxt.content || "").trim().length > 0);
  const textDiffs = consumeText && hasAuthoritativeTxt
    ? buildExtractTextDiffs(existingTxt.content, content)
    : [];
  if (consumeText) {
    setScanExtractTextSource({
      name,
      content,
      sourcePath: files[0] || null,
      createdAt: Date.now(),
    });
    setScanExtractTextDiffs(textDiffs);
    if (!hasAuthoritativeTxt && loadText) {
      loadTxtFromContent(name, content);
    } else if (hasAuthoritativeTxt && notifyOnComplete) {
      toast("読み込み済みテキストを正として使用します。画像スキャン結果は確認欄に残しました。", { kind: "info", duration: 3500 });
    }
  } else if (loadText) {
    loadTxtFromContent(name, content);
  }
  if (notifyOnComplete) {
    // 画像スキャンボタン経由のとき: 次にやってほしいアクション (自動配置) を案内する。
    // 戻る (false) でただ閉じる、自動配置 (true) でそのままサイドパネルの自動配置ボタンを発火。
    // scan-place からの自動トリガー時はそのまま確認モーダルへ遷移するので案内は出さない。
    const goPlace = await confirmDialog({
      title: "画像スキャン完了",
      message: "テキスト抽出が完了しました。\n自動配置を行ってください。",
      kind: "success",
      confirmLabel: "自動配置",
      cancelLabel: "戻る",
      confirmKind: "place",
    });
    if (goPlace) {
      // auto-place.js は scan-extract.js を import しており逆方向 import は循環参照になる。
      // ボタンの DOM クリックを介してハンドラを発火させ循環を避ける。
      // setScanExtractDoc は既に上で呼び済みなので onScanExtractDocChange 経由で disabled は解除済み。
      const placeBtn = $("scan-place-btn");
      if (placeBtn && !placeBtn.disabled) placeBtn.click();
    }
  }
}

// referenceScan 起動中の標準出力からフェーズを推定。検出できない場合は null。
// 画像スキャン の tqdm 進捗が始まる前の無音時間を埋めるためだけに使う。
function detectStartupPhase(line) {
  if (!line) return null;
  const s = line.toLowerCase();
  // 吹き出し検出モデル (画像スキャンエンジンの一部) — 外部ライブラリのログに含まれる
  // モジュール名 (comic_text_detector) を substring で検出する。
  if (
    s.includes("text detection model") ||
    s.includes("comic_text_detector") ||
    s.includes("comic-text-detector") ||
    /loading\b.*\bdetection/.test(s)
  ) {
    return "テキスト検出モデルを読み込み中…";
  }
  // テキスト抽出モデル (画像スキャンエンジンの一部) — 同様に外部モジュール名を検出。
  if (
    s.includes(`manga_${TEXT_SCAN_TOKEN}`) ||
    s.includes(`manga-${TEXT_SCAN_TOKEN}`) ||
    new RegExp(`\\b${TEXT_SCAN_TOKEN} model\\b`).test(s) ||
    new RegExp(`loading\\b.*\\b(recognition|${TEXT_SCAN_TOKEN})`).test(s)
  ) {
    return "画像スキャン モデルを読み込み中…";
  }
  if (s.includes("processing volume")) {
    return "ボリュームを処理中…";
  }
  return null;
}

// 起動時の所要時間ざっくり見積。tqdm からの実 ETA が来るまでの「画像スキャン 起動中」表示で使う。
// 起動 / モデル読込: ~15 秒 (CPU/GPU 共通でほぼ固定)
// ファイルあたり: ~30 秒 (ページ数や CPU/GPU で大きくぶれるのであくまで目安)。
function estimateRemainingSeconds(fileCount) {
  return 15 + Math.max(1, fileCount | 0) * 30;
}

// 「約 N 秒」「約 N 分」の vague 表記（10 秒単位 / 1 分単位で丸める）。
function formatApproxDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "数十秒";
  if (seconds < 60) return `約 ${Math.max(10, Math.ceil(seconds / 10) * 10)} 秒`;
  return `約 ${Math.ceil(seconds / 60)} 分`;
}

// tqdm の "[time<eta, rate]" 内 eta 部分 (e.g. "00:30") を「30秒」「1分20秒」に整形。
// eta 未確定（"?" を含む / 0 秒 / 数値解析不可）のときは "" を返す。
// 呼び出し側はこの戻り値を「ETA 確定済みかどうか」のフラグとしても使う。
function formatEta(eta) {
  if (typeof eta !== "string") return "";
  // tqdm 初期状態 "00:00<?, ?it/s" 等の「?」を含む eta は未確定なので非表示。
  if (eta.includes("?")) return "";
  const m = eta.match(/<\s*(\d+):(\d+)(?::(\d+))?/);
  if (!m) return "";
  const h = m[3] ? parseInt(m[1], 10) : 0;
  const mm = parseInt(m[3] ? m[2] : m[1], 10);
  const ss = parseInt(m[3] ? m[3] : m[2], 10);
  const total = h * 3600 + mm * 60 + ss;
  if (!Number.isFinite(total) || total <= 0) return "";
  if (total >= 3600) return `${Math.floor(total / 3600)}時間${Math.floor((total % 3600) / 60)}分`;
  if (total >= 60) return `${Math.floor(total / 60)}分${total % 60}秒`;
  return `${total}秒`;
}

// 公開: ファイル群に対して画像スキャンを実行し、ReferenceScanDocument を返す。
// (auto-place.js から「画像スキャン キャッシュなし時に自動実行」用に呼ぶ)
// 自動配置経由なのでアイコンは wand-sparkles、ラベルも「自動配置中…」に揃える。
export async function runScanExtractForFiles(files, { loadText = true, maxPages = null, excludedPages = null } = {}) {
  await runScanExtract(files, { icon: PLACE_ICON_SVG, label: "自動配置中…", loadText, maxPages, excludedPages });
}

export async function runScanExtractForTranscription(files) {
  await runScanExtract(files, {
    notifyOnComplete: false,
    icon: SCAN_ICON_SVG,
    label: "画像スキャン中…",
    loadText: true,
    consumeText: false,
  });
}

export async function runScanExtractForPlacementOnly(files) {
  await runScanExtract(files, {
    icon: PLACE_ICON_SVG,
    label: "位置検出中…",
    consumeText: false,
    loadText: false,
  });
}

export async function openScanExtractDialog({ force = false } = {}) {
  if (!force && isScanActionsLocked()) return;
  if (runningExtract) return;
  if (getTxtSource()) {
    const ok = await confirmDialog({
      title: "画像スキャン",
      message: "現在のテキストは破棄されます。よろしいですか？",
      confirmLabel: "実行",
      kind: "info",
    });
    if (!ok) return;
  }
  let files = getPdfPaths();
  let needLoadReference = false;
  if (!files || files.length === 0) {
    try {
      files = await pickInputFiles();
    } catch (e) {
      console.error(e);
      toast(`ファイル選択失敗: ${e?.message ?? e}`, { kind: "error" });
      return;
    }
    if (!files || files.length === 0) return;
    needLoadReference = true;
  }
  if (needLoadReference) {
    try {
      await loadReferenceFiles(files);
    } catch (e) {
      console.error("loadReferenceFiles failed:", e);
      toast(`見本表示に失敗: ${e?.message ?? e}`, { kind: "error", duration: 3500 });
    }
  }
  await runScanExtract(files, { notifyOnComplete: true });
}

export function bindScanExtractButton() {
  const btn = $("scan-extract-btn");
  if (!btn) return;
  const row = $("scan-actions-row");
  if (row && row.dataset.aiEngineLockBound !== "true") {
    row.dataset.aiEngineLockBound = "true";
    row.addEventListener("click", (e) => {
      if (!isScanActionsLocked()) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }
  window.addEventListener("psdesign:scan-model-status", (e) => {
    setScanActionsEngineLock(!e.detail?.available);
  });
  void refreshScanActionsEngineLock();
  btn.addEventListener("click", async () => {
    await openScanExtractDialog();
    return;
    if (isScanActionsLocked()) return;
    if (runningExtract) return;
    // テキストが既に読み込まれている場合は 画像スキャン 結果で上書きする旨を事前に警告する。
    // ファイル選択や 画像スキャン 実行のコストが発生する前にキャンセル可能にするため、最初に確認する。
    if (getTxtSource()) {
      const ok = await confirmDialog({
        title: "画像スキャン",
        message: "現在のテキストは破棄されます。よろしいですか？",
        confirmLabel: "実行",
        kind: "danger",
      });
      if (!ok) return;
    }
    // 既に見本が読み込まれていればファイル選択をスキップしてその見本で 画像スキャン を走らせる。
    // 未読込のときだけファイル選択ダイアログを開き、選んだファイルを見本として表示してから 画像スキャン。
    let files = getPdfPaths();
    let needLoadReference = false;
    if (!files || files.length === 0) {
      try {
        files = await pickInputFiles();
      } catch (e) {
        console.error(e);
        toast(`ファイル選択失敗: ${e?.message ?? e}`, { kind: "error" });
        return;
      }
      if (!files || files.length === 0) return; // ユーザーがキャンセル
      needLoadReference = true;
    }
    // 新規選択時のみ pdf-stage の見本としても表示する。
    // 画像スキャン はファイルパス配列を直接 referenceScan に渡すので、先に loadReferenceFiles を await して
    // 見本表示を確定させてから 画像スキャン フェーズに進む（ユーザーが進捗中も画像確認可）。
    if (needLoadReference) {
      try {
        await loadReferenceFiles(files);
      } catch (e) {
        console.error("loadReferenceFiles failed:", e);
        // 見本表示に失敗しても 画像スキャン 自体は継続できるので、エラー toast だけ出して進行。
        toast(`見本表示に失敗: ${e?.message ?? e}`, { kind: "error", duration: 3500 });
      }
    }
    await runScanExtract(files, { notifyOnComplete: true });
  });

  if (!isScanActionsLocked()) {
    btn.disabled = false;
    btn.title = "見本画像を 画像スキャン で画像スキャン（未読込ならファイル選択ダイアログを表示）";
  }
}
