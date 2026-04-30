// AI セリフ抽出 (mokuro OCR)
//
// 開いている PDF (state.pdfPath) または、ユーザーが選択した PDF/画像から
// mokuro OCR を実行し、結果を normalize.js で整形して TXT パネルに流し込む。
//
// 依存: @tauri-apps/api/core (invoke), @tauri-apps/api/event (listen),
//       @tauri-apps/plugin-dialog (open)
// イベント仕様 (Rust 側 ocr.rs):
//   - ai_ocr:start    (payload: volume name 文字列)
//   - ai_ocr:log      (payload: { line, stream })
//   - ai_ocr:progress (payload: { phase: "pdf"|"ocr", current, total, eta? })

import {
  showProgress,
  updateProgress,
  hideProgress,
  notifyDialog,
  toast,
} from "./ui-feedback.js";
import { setAiOcrDoc, getPdfPaths } from "./state.js";
import { loadTxtFromContent } from "./txt-source.js";
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
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: true,
    title: "テキストスキャンする見本画像を選択",
    filters: [
      { name: "PDF / 画像", extensions: ["pdf", ...IMAGE_EXTS] },
    ],
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

async function runAiOcr(files, { notifyOnComplete = false } = {}) {
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

  showProgress({
    title: "画像スキャン",
    detail: `${baseName(files[0])} ほか ${files.length} 件`,
    current: 0,
    total: 1,
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
      detail: "OCR エンジンを起動中…",
      current: null,
      total: null,
    });
  });

  const unsubProgress = await listen("ai_ocr:progress", (e) => {
    const p = e.payload || {};
    if (p.phase === "pdf") {
      phase = "pdf";
      updateProgress({
        detail: `PDF 展開中… (${p.current}/${p.total})`,
        current: p.current,
        total: p.total,
      });
    } else if (p.phase === "ocr") {
      phase = "ocr";
      // tqdm の初期出力 "0/5 [00:00<?, ?it/s]" は残り時間が未確定（"?" を含む）。
      // 残り時間が解析できる正常値になるまではカウントもバーも出さず indeterminate 表示。
      const formattedEta = formatEta(p.eta);
      const hasValidEta = !!formattedEta;
      if (!hasValidEta) {
        updateProgress({
          detail: "OCR 実行中…",
          current: null,
          total: null,
        });
      } else {
        updateProgress({
          detail: `OCR 実行中… ${p.current}/${p.total} (残り ${formattedEta})`,
          current: p.current,
          total: p.total,
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
        detail: marker,
        current: null,
        total: null,
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
    // ai-place からの自動トリガー時はそのまま確認モーダルへ遷移するので案内は出さない。
    await notifyDialog({
      title: "画像スキャン完了",
      message: "テキスト抽出が完了しました。\n自動配置を行ってください。",
      kind: "success",
    });
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
export async function runAiOcrForFiles(files) {
  await runAiOcr(files);
}

export function bindAiOcrButton() {
  const btn = $("ai-ocr-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (runningOcr) return;
    // 読込済み見本（PDF / 画像）があればそれを優先して OCR にかける。
    // 未読込のときだけファイル選択ダイアログを出す。
    const loaded = getPdfPaths();
    if (loaded.length > 0) {
      await runAiOcr(loaded, { notifyOnComplete: true });
      return;
    }
    let files;
    try { files = await pickInputFiles(); }
    catch (e) {
      console.error(e);
      toast(`ファイル選択失敗: ${e?.message ?? e}`, { kind: "error" });
      return;
    }
    if (!files || files.length === 0) return; // ユーザーがキャンセル
    await runAiOcr(files, { notifyOnComplete: true });
  });

  btn.disabled = false;
  btn.title = "読込済み見本を AI でスキャン（未読込ならファイル選択）";
}
