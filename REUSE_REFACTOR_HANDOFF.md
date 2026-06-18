# リサイクル機能 分離リファクタ ハンドオフ

ブランチ: `refactor/reuse-session-split`（main 未マージ）
状態: **一区切り（完了）**。核心の分離は達成・実機検証済み。残り項目はリスクとして意図的に見送り。

## 目的
リサイクル（リサイくるん）処理を通常写植から分離し、`pages` / `newLayers` / 保存・描画への
reuse 専用分岐の混入を減らす。リサイクルは「同じ原稿の再写植（in-place）」が前提。

## 完了した変更（main からの差分・すべて検証済み）

| commit | 内容 |
|---|---|
| `aedf30c` | ステップ1: `collectReuseDraftsForPage`（純粋・state不変）/ `applyReuseDraftsToPage`（state反映の唯一の場所）に分割 |
| `42f41bc` | 再現モードの配置基準を「元bounds左上アンカー」→「中心合わせ＋tight枠」に統一（保存側と一致）。`reuseSource*` を不使用化 |
| `a1280c2` | 保存の位置基準を `uiAnchorCx/Cy`（保存直前に算出する現在のUIグリフ中心）に。UI上の調整を保存へ反映 |
| `0433dce` | ステップ2: commit境界。ページループは collect のみ、ループ後 `commitReuseSessionToTypesetting` で一括反映（リサイクル→通常stateの唯一の出口） |
| `fbd773a` | ステップ4: 元テキスト非表示を appMode 全体フラグ → per-PSD `hideOriginalText`（reuseInfo駆動）に。通常PSD誤爆を構造的に防止 |

検証: `npm run check`（encoding/security/lint/build）+ `cargo check` 緑。実機で
通常写植（文字消えない）・リサイクル（元テキスト非表示・二重表示なし）正常。

現アーキテクチャ: collect（純粋解析）→ commit（単一の反映点）→ 通常 newLayers ＋ per-PSD 付箋フラグ。

## 保留＝リスクとして未着手（意図的に見送り）

1. **【位置残差】** リサイクル写植のビューアー↔PSD 位置がわずかにズレる。中心統一・UI実測
   アンカーでも残存。原因は WebView(Chromium) と Photoshop の文字描画 bbox 差の可能性が
   高いが、別要因も要調査。実害は軽微で「UI上で手調整」運用で回避可（uiAnchor により調整は
   保存へ反映される）。
2. **ステップ5（`reuseTightThick`→`tightBox` 改名 / `reuseSourceBoundsForNewLayer` 削除）**:
   旧 `.opus` が `reuseTightThick` / `reuseSourceContents` 等に依存。改名・削除は旧プロジェクト
   再オープン時の枠/位置挙動を変えるため migrate が必要。得るのは命名の綺麗さのみ＝リスク＞リターン。
3. **ステップ6（snapshot に未commit draft 保存）**: 現設計は抽出直後に即 commit のため未commit
   状態が存在せず**不要**。
4. **ステップ7（appMode をラベル表示に縮小）**: appMode はリサイクルのビューア表示（見本ペイン
   並列）にまだ使用。縮小は純粋な表示整理で低価値。

## 戻し方
- 個別: `git revert <hash>`
- 全体: `git checkout main`（ブランチ未マージ）
