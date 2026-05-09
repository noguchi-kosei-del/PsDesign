// 縦書き漫画の読み順 (右上 → 左下) で吹き出し blocks を並べ替える。
// y-中心が近いブロックを「行」にクラスタリングし、行は上→下、行内は右→左。
// バンドは平均ブロック高 × 0.5。
//
// 注: コマ枠 (panel) を見ていないため、左右コマで縦位置が近い吹き出しは
// 同じ行に誤束ねされる可能性あり。改善は将来別タスクで。
//
// 引数: blocks = MokuroBlock[] (各 block は box: [x1,y1,x2,y2] を持つ前提)
// 戻り値: 読み順に並び替えた MokuroBlock[] (新しい配列、入力は不変)
export function sortBlocksMangaOrder(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];
  const items = blocks.map((b) => ({
    block: b,
    cx: (b.box[0] + b.box[2]) / 2,
    cy: (b.box[1] + b.box[3]) / 2,
    h: b.box[3] - b.box[1],
  }));
  // y 順に処理して行を組み立てる
  items.sort((a, b) => a.cy - b.cy);
  const avgH = items.reduce((s, it) => s + it.h, 0) / items.length;
  const band = Math.max(avgH * 0.5, 1);
  const rows = [];
  for (const it of items) {
    const row = rows.find((r) => Math.abs(r.cy - it.cy) <= band);
    if (row) {
      row.items.push(it);
      row.cy = (row.cy * (row.items.length - 1) + it.cy) / row.items.length;
    } else {
      rows.push({ cy: it.cy, items: [it] });
    }
  }
  rows.sort((a, b) => a.cy - b.cy);
  for (const row of rows) row.items.sort((a, b) => b.cx - a.cx); // 右 → 左
  return rows.flatMap((r) => r.items.map((i) => i.block));
}
