// AI セリフ抽出 (mokuro OCR)
//
// 開いている PDF (state.pdfPath) または、ユーザーが選択した PDF/画像から
// mokuro OCR を実行し、結果を normalize.js で整形して TXT パネルに流し込む。
//
// 依存: @tauri-apps/api/core (invoke), @tauri-apps/api/event (listen),
//       file-picker.js (カスタムファイル選択ダイアログ)
// イベント仕様 (Rust 側 ocr.rs):
//   - ai_ocr:start    (payload: volume name 文字列)
//   - ai_ocr:log      (payload: { line, stream })
//   - ai_ocr:progress (payload: { phase: "pdf"|"ocr", current, total, eta? })

import {
  confirmDialog,
  showProgress,
  updateProgress,
  hideProgress,
  toast,
} from "./ui-feedback.js";
import { getTxtSource, setAiOcrDoc } from "./state.js";
import { loadTxtFromContent } from "./txt-source.js";
import { loadReferenceFiles } from "./pdf-loader.js";
import { applyRules, loadSettings as loadNormalizeSettings } from "./normalize.js";
import { checkAiModelsStatus } from "./ai-install.js";

const $ = (id) => document.getElementById(id);

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp"];

let runningOcr = false;

function baseName(p) {
  const m = p && p.match(/[\\/]([^\\/]+)$/);
  return m ? m[1] : p;
}

function stripExt(s) {
  return (s || "").replace(/\.[^.]+$/, "");
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
    rememberKey: "ai-ocr-open",
  });
  if (Array.isArray(picked)) return picked;
  if (typeof picked === "string") return [picked];
  return [];
}

// MokuroDocument → COMIC-POT 風のテキスト本文 (ページマーカー付き)
function mokuroDocToText(doc, normalizeSettings) {
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

// プログレスバー上のアイコン（lucide ベース）。画像スキャンボタン直接 = scan-line、
// 自動配置から自動 OCR をトリガーする経路 = wand-sparkles。index.html のボタンと同形。
// アニメーションは styles.css 側で .scan-icon / .place-icon の class scope で定義。
// PLACE_ICON_SVG の sparkle 6 本（ステッキ周りの光）には個別に .sparkle class を当てて
// CSS から nth-of-type で順次点滅させる。最初の 2 本（ステッキ軸 + ヘッド）は静止。
const SCAN_ICON_SVG = `<svg class="scan-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/></svg>`;
export const PLACE_ICON_SVG = `<svg class="place-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path class="sparkle" d="M5 6v4"/><path class="sparkle" d="M19 14v4"/><path class="sparkle" d="M10 2v2"/><path class="sparkle" d="M7 8H3"/><path class="sparkle" d="M21 16h-4"/><path class="sparkle" d="M11 3H9"/></svg>`;

async function runAiOcr(files, {
  notifyOnComplete = false,
  icon = SCAN_ICON_SVG,
  // 進捗ダイアログのアイコン直下ラベル。直接呼ばれる「画像スキャン」と
  // 自動配置から呼ばれる経路で文言を切替えるため引数化。
  label = "画像スキャン中…",
} = {}) {
  if (runningOcr) return;
  if (!files || files.length === 0) return; // 何も選択されていない場合は静かに戻る

  // インストール確認
  let status;
  try { status = await checkAiModelsStatus(); }
  catch (_) { status = { available: false }; }
  if (!status?.available) {
    await notifyDialog({
      title: "AIモデル未インストール",
      message: "画像スキャンには manga-ocr / comic-text-detector のインストールが必要です。\n左下メニューの「AIインストール」から実行してください。",
    });
    return;
  }

  runningOcr = true;
  const btn = $("ai-ocr-btn");
  if (btn) btn.disabled = true;

  // 起動時の大雑把な所要時間見積（モデル読込 ~15 秒 + ファイル数 × ~30 秒）。
  // 実 ETA が tqdm から来るまでの「OCR エンジンを起動中…」「PDF 展開中…」の間、
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

  // フェーズ: "pdf" → (mokuro 起動中の無音時間) → "ocr"
  // 無音時間中は ai_ocr:log の行から既知マーカーを拾って detail に反映する。
  let phase = "pdf";

  const unsubStart = await listen("ai_ocr:start", () => {
    // PDF 展開完了 → mokuro 起動。OCR の最初の tqdm 進捗が来るまで indeterminate。
    phase = "starting";
    updateProgress({
      detail: `OCR エンジンを起動中… (完了まで${approxLabel})`,
      current: null,
      total: null,
      showCount: false,
    });
  });

  const unsubProgress = await listen("ai_ocr:progress", (e) => {
    const p = e.payload || {};
    if (p.phase === "pdf") {
      phase = "pdf";
      updateProgress({
        detail: `PDF 展開中… (${p.current}/${p.total}) (完了まで${approxLabel})`,
        current: p.current,
        total: p.total,
        showCount: false,
      });
    } else if (p.phase === "ocr") {
      phase = "ocr";
      // tqdm の初期出力 "0/5 [00:00<?, ?it/s]" は残り時間が未確定（"?" を含む）。
      // 残り時間が解析できる正常値になるまでは見積を出しておく。
      const formattedEta = formatEta(p.eta);
      const hasValidEta = !!formattedEta;
      if (!hasValidEta) {
        updateProgress({
          detail: `OCR 実行中… (完了まで${approxLabel})`,
          current: null,
          total: null,
          showCount: false,
        });
      } else {
        updateProgress({
          detail: `OCR 実行中… ${p.current}/${p.total} (残り ${formattedEta})`,
          current: p.current,
          total: p.total,
          showCount: false,
        });
      }
    }
  });

  const unsubLog = await listen("ai_ocr:log", (e) => {
    const { line, stream } = e.payload || {};
    if (typeof line !== "string") return;
    if (stream === "stderr") console.warn("[ai_ocr]", line);
    else console.log("[ai_ocr]", line);
    // OCR の進捗イベントが流れるようになったら以降のログは UI に出さない
    // (tqdm 行が高頻度で来るため、frame thrashing を避ける)。
    if (phase === "ocr") return;
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
  try {
    doc = await invoke("run_ai_ocr", { files, forceCpu: false });
  } catch (e) {
    err = e;
  } finally {
    try { unsubStart(); } catch (_) {}
    try { unsubProgress(); } catch (_) {}
    try { unsubLog(); } catch (_) {}
    hideProgress();
    runningOcr = false;
    if (btn) btn.disabled = false;
  }

  if (err || !doc) {
    console.error(err);
    const msg = String(err?.message ?? err ?? "不明なエラー");
    await notifyDialog({ title: "画像スキャン失敗", message: msg });
    return;
  }

  // 自動配置 (ai-place.js) が後から参照できるよう MokuroDocument 全体をストア。
  setAiOcrDoc(doc, files[0] || null);

  const settings = loadNormalizeSettings();
  const content = mokuroDocToText(doc, settings);
  const baseLabel = files.length === 1
    ? stripExt(baseName(files[0]))
    : `OCR-${files.length}件`;
  const name = `${baseLabel}_AI.txt`;
  loadTxtFromContent(name, content);
  if (notifyOnComplete) {
    // 画像スキャンボタン経由のとき: 次にやってほしいアクション (自動配置) を案内する。
    // 戻る (false) でただ閉じる、自動配置 (true) でそのままサイドパネルの自動配置ボタンを発火。
    // ai-place からの自動トリガー時はそのまま確認モーダルへ遷移するので案内は出さない。
    const goPlace = await confirmDialog({
      title: "画像スキャン完了",
      message: "テキスト抽出が完了しました。\n自動配置を行ってください。",
      kind: "success",
      confirmLabel: "自動配置",
      cancelLabel: "戻る",
      confirmKind: "place",
    });
    if (goPlace) {
      // ai-place.js は ai-ocr.js を import しており逆方向 import は循環参照になる。
      // ボタンの DOM クリックを介してハンドラを発火させ循環を避ける。
      // setAiOcrDoc は既に上で呼び済みなので onAiOcrDocChange 経由で disabled は解除済み。
      const placeBtn = $("ai-place-btn");
      if (placeBtn && !placeBtn.disabled) placeBtn.click();
    }
  }
}

// mokuro 起動中の標準出力からフェーズを推定。検出できない場合は null。
// OCR の tqdm 進捗が始まる前の無音時間を埋めるためだけに使う。
function detectStartupPhase(line) {
  if (!line) return null;
  const s = line.toLowerCase();
  // text detection model (comic-text-detector)
  if (
    s.includes("text detection model") ||
    s.includes("comic_text_detector") ||
    s.includes("comic-text-detector") ||
    /loading\b.*\bdetection/.test(s)
  ) {
    return "テキスト検出モデルを読み込み中…";
  }
  // OCR / recognition model (manga-ocr)
  if (
    s.includes("manga_ocr") ||
    s.includes("manga-ocr") ||
    /\bocr model\b/.test(s) ||
    /loading\b.*\b(recognition|ocr)/.test(s)
  ) {
    return "OCR モデルを読み込み中…";
  }
  if (s.includes("processing volume")) {
    return "ボリュームを処理中…";
  }
  return null;
}

// 起動時の所要時間ざっくり見積。tqdm からの実 ETA が来るまでの「OCR 起動中」表示で使う。
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

// 公開: ファイル群に対して画像スキャンを実行し、MokuroDocument を返す。
// (ai-place.js から「OCR キャッシュなし時に自動実行」用に呼ぶ)
// 自動配置経由なのでアイコンは wand-sparkles、ラベルも「自動配置中…」に揃える。
export async function runAiOcrForFiles(files) {
  await runAiOcr(files, { icon: PLACE_ICON_SVG, label: "自動配置中…" });
}

export function bindAiOcrButton() {
  const btn = $("ai-ocr-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (runningOcr) return;
    // テキストが既に読み込まれている場合は OCR 結果で上書きする旨を事前に警告する。
    // ファイル選択や OCR 実行のコストが発生する前にキャンセル可能にするため、最初に確認する。
    if (getTxtSource()) {
      const ok = await confirmDialog({
        title: "画像スキャン",
        message: "現在のテキストは破棄されます。よろしいですか？",
        confirmLabel: "実行",
        kind: "danger",
      });
      if (!ok) return;
    }
    // 画像スキャンは毎回ファイル選択からやり直す。読込済み見本があれば
    // loadReferenceFiles で上書き破棄され、選び直した新しい見本で OCR が走る。
    let files;
    try { files = await pickInputFiles(); }
    catch (e) {
      console.error(e);
      toast(`ファイル選択失敗: ${e?.message ?? e}`, { kind: "error" });
      return;
    }
    if (!files || files.length === 0) return; // ユーザーがキャンセル
    // 選択した PDF / 画像を pdf-stage の見本としても表示する。
    // OCR はファイルパス配列を直接 mokuro に渡すので、先に loadReferenceFiles を await して
    // 見本表示を確定させてから OCR フェーズに進む（ユーザーが進捗中も画像確認可）。
    try {
      await loadReferenceFiles(files);
    } catch (e) {
      console.error("loadReferenceFiles failed:", e);
      // 見本表示に失敗しても OCR 自体は継続できるので、エラー toast だけ出して進行。
      toast(`見本表示に失敗: ${e?.message ?? e}`, { kind: "error", duration: 3500 });
    }
    await runAiOcr(files, { notifyOnComplete: true });
  });

  btn.disabled = false;
  btn.title = "ファイルを選択して AI で画像スキャン";
}
