// テストモード: 実ファイルを用意せずにエディタ挙動を確認するための白紙ページ生成。
// ハンバーガーメニュー下部の「テストモード」ボタンから呼ばれ、見本（左ペイン）と
// PSD（右ペイン）の両方に白紙 3 ページを表示し、各 PSD ページにサンプルテキストを
// 新規テキストレイヤーとして配置する。
//
// 既存ローダー（services/psd-load.js）と同じ流れを踏襲:
//   clearPages → buildBlankPsdPage/addPage ループ → setPdf(白紙合成 doc)
//   → renderAllSpreads / rebuildLayerList / renderTxtSourceViewer
//   → "psdesign:psd-loaded" を 1 回だけ dispatch。

import {
  addNewLayer,
  addPage,
  clearPages,
  getCurrentFont,
  getFillColor,
  getLeadingPct,
  getNewTextDirection,
  getStrokeColor,
  getStrokeWidthPx,
  getTextSize,
  hasEdits,
  setActivePane,
  setCurrentPageIndex,
  setParallelSyncMode,
  setPdf,
  setPdfPageIndex,
  setPdfSkipFirstBlank,
  setPdfSplitMode,
} from "./state.js";
import { buildBlankPsdPage } from "./psd-loader.js";
import { buildBlankReferenceDoc } from "./pdf-loader.js";
import { renderAllSpreads } from "./spread-view.js";
import { rebuildLayerList } from "./text-editor.js";
import { renderTxtSourceViewer } from "./txt-source.js";
import { centerTopLeft } from "./canvas-tools.js";
import { confirmDialog } from "./ui-feedback.js";

const PAGE_COUNT = 3;
const PAGE_W = 1200;
const PAGE_H = 1700;
const PAGE_DPI = 72;
const SAMPLE_TEXTS = ["あいうえお", "かきくけこ", "さしすせそ"];

// テストモードを開始する。破棄キャンセル時のみ false を返す（呼び出し側はホーム解除を抑止）。
export async function runTestMode() {
  if (hasEdits()) {
    const ok = await confirmDialog({
      title: "テストモード",
      message: "現在の編集内容は破棄されます。続行しますか？",
      confirmLabel: "続行",
    });
    if (!ok) return false;
  }

  // --- PSD ペイン: 白紙ページ + サンプルテキスト ---
  clearPages();
  for (let i = 0; i < PAGE_COUNT; i++) {
    const page = buildBlankPsdPage(`テストPSD ${i + 1}`, PAGE_W, PAGE_H, PAGE_DPI);
    addPage(page);
    const opt = {
      contents: SAMPLE_TEXTS[i % SAMPLE_TEXTS.length],
      sizePt: getTextSize(),
      direction: getNewTextDirection(),
      leadingPct: getLeadingPct(),
    };
    const { x, y } = centerTopLeft(page, opt, PAGE_W / 2, PAGE_H / 2);
    addNewLayer({
      psdPath: page.path,
      x,
      y,
      contents: opt.contents,
      fontPostScriptName: getCurrentFont(),
      sizePt: opt.sizePt,
      direction: opt.direction,
      strokeColor: getStrokeColor(),
      strokeWidthPx: getStrokeWidthPx(),
      fillColor: getFillColor(),
      leadingPct: opt.leadingPct,
    });
  }

  // --- 見本ペイン: 白紙合成 doc ---
  setPdfSplitMode(false);
  setPdfSkipFirstBlank(false);
  const refDoc = await buildBlankReferenceDoc(PAGE_COUNT, PAGE_W, PAGE_H);
  setPdf(refDoc, "テスト見本", []);

  // --- 表示既定 ---
  setParallelSyncMode(true);
  setActivePane("psd");
  setCurrentPageIndex(0);
  setPdfPageIndex(0);

  // --- 反映 ---
  renderAllSpreads();
  rebuildLayerList();
  renderTxtSourceViewer();
  window.dispatchEvent(new CustomEvent("psdesign:psd-loaded"));
  return true;
}
