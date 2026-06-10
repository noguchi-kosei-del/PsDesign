// ag-psd がパースした PSD オブジェクトから、埋め込みガイド（トンボ/塗り足し枠）を
// ルーラーの内部表現 { h: number[], v: number[] }（PSD pixel）へ変換する純関数。
//
// ag-psd の guides: { location: number(PSD px), direction: 'horizontal' | 'vertical' }
//   - direction='horizontal' = 画面上で水平な線 = Y 座標 → ルーラー axis "h"
//   - direction='vertical'   = 画面上で垂直な線 = X 座標 → ルーラー axis "v"
//   - location は uint32/32 で既に PSD pixel（page.width/height と同一単位）なので変換不要。
//
// DOM / Tauri に依存しないため worker（psd-parse-worker.js）からも import 可能。
export function extractPsdGuides(psd) {
  const out = { h: [], v: [] };
  const guides = psd?.imageResources?.gridAndGuidesInformation?.guides;
  if (!Array.isArray(guides)) return out;
  for (const g of guides) {
    if (!g || !Number.isFinite(g.location)) continue;
    if (g.direction === "horizontal") out.h.push(g.location); // 水平線 = Y
    else if (g.direction === "vertical") out.v.push(g.location); // 垂直線 = X
  }
  return out;
}
