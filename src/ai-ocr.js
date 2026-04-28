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
//   - ai_ocr:progress (payload: { phase: "pdf"|"ocr", current, total })

import {
  showProgress,
  updateProgress,
  hideProgress,
  notifyDialog,
  toast,
} from "./ui-feedback.js";
import { getPdfPath, setAiOcrDoc } from "./state.js";
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
    title: "OCR する PDF / 画像を選択",
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

async function runAiOcr(files) {
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

  let lastPhase = "pdf";
  const unsubProgress = await listen("ai_ocr:progress", (e) => {
    const p = e.payload || {};
    if (p.phase === "pdf") {
      lastPhase = "pdf";
      updateProgress({
        detail: `PDF 展開中… (${p.current}/${p.total})`,
        current: p.current,
        total: p.total,
      });
    } else if (p.phase === "ocr") {
      lastPhase = "ocr";
      updateProgress({
        detail: `OCR 実行中… (${p.current}/${p.total})`,
        current: p.current,
        total: p.total,
      });
    }
  });
  const unsubLog = await listen("ai_ocr:log", (e) => {
    // (現状ログは UI には流さず console のみ)
    const { line, stream } = e.payload || {};
    if (typeof line === "string") {
      if (stream === "stderr") console.warn("[ai_ocr]", line);
      else console.log("[ai_ocr]", line);
    }
  });

  let doc = null;
  let err = null;
  try {
    doc = await invoke("run_ai_ocr", { files, forceCpu: false });
  } catch (e) {
    err = e;
  } finally {
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
  toast(`画像スキャン完了 (${doc?.pages?.length ?? 0} ページ)`, { kind: "info", duration: 3200 });
  void lastPhase;
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
    // 1. 開いている PDF を優先
    const pdfPath = getPdfPath();
    let files = pdfPath ? [pdfPath] : [];
    // 2. 何も開いてなければ選択ダイアログ
    if (files.length === 0) {
      try { files = await pickInputFiles(); }
      catch (e) {
        console.error(e);
        toast(`ファイル選択失敗: ${e?.message ?? e}`, { kind: "error" });
        return;
      }
    }
    await runAiOcr(files);
  });

  // PDF 読み込み有無に応じて enabled 切替
  const refresh = () => {
    const pdf = getPdfPath();
    btn.disabled = false; // PDF が無くてもダイアログでも実行可
    btn.title = pdf
      ? `現在開いている PDF (${baseName(pdf)}) を AI で画像スキャン`
      : "PDF / 画像を選択して AI で画像スキャン";
  };
  refresh();
  // PDF 切替時にツールチップ更新 (state.js の onPdfChange を活用)
  import("./state.js").then(({ onPdfChange }) => {
    if (typeof onPdfChange === "function") onPdfChange(refresh);
  });
}
