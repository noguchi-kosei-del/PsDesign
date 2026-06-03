# RDD.md — テキスト情報 反映ロジック 要件定義書

> **このドキュメントの目的**
> OPUS（PsDesign）の中核機能である「**原稿テキスト・編集内容を画面プレビューと PSD へ
> 正しく反映する**」ロジックが、改修によって**破損・欠落していないか**をチェックするための
> 要件定義（＝回帰チェックリスト）。
>
> **GitHub にプッシュする前に必ず本書を確認すること。** テキスト反映ロジックに触れた変更が
> ある場合は、該当する要件 (REQ) の「確認方法」を実施し、巻末の「プッシュ前チェックリスト」を
> 完了させてから push する。バグを修正した場合は [DEBUG.md](DEBUG.md) に事例・原因・対策を記載する。

---

## 0. スコープ

対象は「テキスト情報の反映」に関わる経路のみ。具体的には:

- 原稿テキスト（TXT）の取り込み・編集・保持
- 原稿 ↔ 配置済みテキストレイヤーの双方向同期
- in-place 編集（contenteditable）での本文・per-char 属性（サイズ/フォント/太字/斜体/ルビ/
  縦中横/字間/塗り色）の整合
- 画面プレビュー（オーバーレイ）への反映
- Photoshop（PSD）への書き戻し
- 履歴（undo/redo）とプロジェクト（.opus）保存/再オープンでのテキスト保持

対象外: 配色・レイアウト・スプラッシュ・フォント帳・校正パネル表示そのもの・スキャン
エンジンのインストール等（テキスト反映に直接関与しない部分）。

---

## 1. データフロー全体図

```
[原稿TXT]                         [ユーザー編集]
 txt-source.js                     canvas-tools.js (in-place / contenteditable)
   │  parsePages / setTxtSource      │  readContents → computeStringDiff → shiftCharMap/shiftLineMap
   │                                 │  setEdit / updateNewLayer
   ▼                                 ▼
[state.js]  edits(既存差分) + newLayers(新規) + per-char/per-line マップ
   │  ├ onTxtSourceChange ──→ auto-place.js syncPlacedFromTxt（原稿→配置レイヤー追従）
   │  ├ snapshotState / restoreSnapshot（undo に txtSource を含む）
   │  └ exportProjectSnapshot / applyProjectSnapshot（.opus 保存・復元）
   ▼
[プレビュー]  canvas-tools.js renderInnerText → appendLineWithTracking → appendRubySegment / appendStyledSegment
   │  measureAllRubyOffsetsSync（ルビ実描画位置を state へ同期）
   ▼
[保存]  state.js exportEdits  →(serde)→  lib.rs EditPayload  →  jsx_gen.rs applyToPsd  →  Photoshop
```

各段階の「守るべき不変条件」を以降の REQ で定義する。

---

## 2. 要件 (REQ)

各要件は **守るべき条件** と **確認方法**（コードレベル grep / 手動スモークテスト）を持つ。
確認方法の行番号はドリフトするため、原則として**シンボル名での grep**で記述する。

### G1. 原稿テキストの取り込み・保持 — `src/txt-source.js` / `src/state.js`

- **REQ-G1.1** `<<N Page>>` マーカー（半角/全角数字可）を `parsePages` が解釈し、
  `{ hasMarkers, all, byPage }` を返す。マーカー無し原稿は全体を 1 群として扱う。
  - 確認: `parsePages` のマーカー正規表現が半角・全角数字の両方を受けること。マーカー付き／
    マーカー無しの TXT を読み込み、ビューアのページ分割が一致するか目視。
- **REQ-G1.2** `getActivePageNumber()` は PSD 読込中なら `currentPageIndex+1`、未読込なら
  `pdfPageIndex+1` を返し、原稿のページ単位操作の基準になる。
  - 確認: PSD 無し + 見本/TXT のみでページ送りしたとき、原稿ビューアの表示ページが追従するか目視。
- **REQ-G1.3** `setTxtSource` は内容変化時に `txtSourceListeners` を発火し、`txtSelection` /
  `txtSelectedBlockIndex` をクリアする（古い選択 index の参照を残さない）。
  - 確認: `setTxtSource` 内で選択クリア + listener 発火していること。

### G2. 双方向同期（原稿 ↔ 配置レイヤー） — `src/auto-place.js` / `src/txt-source.js`

- **REQ-G2.1** `onTxtSourceChange` → `syncPlacedFromTxt` で、原稿変更時に `sourceTxtRef`
  （`{pageNumber, paragraphIndex}`）を持つ配置レイヤーの本文が追従する（bbox 中心固定で再配置）。
  - 確認: 自動配置 → 原稿ビューアで該当段落を編集 → 配置済みレイヤーの本文が即更新され、
    位置が中心固定で保たれること（手動）。
- **REQ-G2.2** `syncPlacedFromTxt` は charRubies を **マージ**する（TXT 注記由来を優先しつつ、
  手動ルビは保持）。**全置換は禁止**（手動ルビが消える）。lineLeadings も再計算する。
  - 確認: 配置レイヤーに手動ルビを足す → 原稿の同段落を編集 → 手動ルビが残ること（手動）。
    `syncPlacedFromTxt` 内にマージループ（手動ルビを `mergedRubies` に残す処理）があること。
- **REQ-G2.3** 原稿の段落削除（`deleteSelectedTxtBlock` / `deleteTxtBlockByIndex` /
  `cascadeRemoveTxtForLayers`）時、削除 index を参照するレイヤーは除去し、後続レイヤーの
  `paragraphIndex` を 1 繰り上げる。1 トランザクション（`withHistoryTransient`）で行う。
  - 確認: 複数段落を配置 → 中間段落を削除 → 残りの本文が重複/ズレしないこと（手動）。
- **REQ-G2.4** V ツールで配置レイヤーを削除すると `cascadeRemoveTxtForLayers` が対応原稿段落も
  削除する（参照が 0 になった段落のみ）。
  - 確認: 配置レイヤー削除 → 原稿ビューアから対応段落が消えること（手動）。

### G3. in-place 編集の整合 — `src/canvas-tools.js`

- **REQ-G3.1** `readContents`（`serializeEditableText`）は `.ruby-text`（rt）ノードと
  ゼロ幅スペース(ZWSP)を除外する。本文 = state.contents と 1:1 一致を保つ。
  - 確認: `serializeEditableText` が `.ruby-text` をスキップすること。ルビを振った後に本文を
    1 文字編集しても per-char 属性が崩れないこと（手動）。
- **REQ-G3.2** `computeStringDiff` は「共通接頭辞 + 編集域 + 共通接尾辞」の単一連続編集前提で
  `{pos, deleted, inserted}` を返す。半角→全角変換は diff 計算の**後**に行う。
  - 確認: `maybeConvertHalfToFull` 系が `computeStringDiff` の後に走ること。
- **REQ-G3.3** `shiftCharMap` / `shiftLineMap` を **全ての** per-char / per-line マップへ
  **同一の (pos, deleted, inserted)** で適用する。対象: charSizes / charFonts / charBolds /
  charItalics / charHorizontalScales / charVerticalScales / charTrackings / charKernings /
  charTateChuYokos / charFillColors / charRubies、および lineLeadings。
  - 確認: `onInput` 内で全 per-char マップに `shiftCharMap` を呼んでいること（新規 per-char
    マップを追加した場合、ここへの追加漏れが**典型的バグ**）。**新しい per-char 属性を足したら、
    必ず shift 対象に加える。**
- **REQ-G3.4** `recenterBox` は per-char マップの再 index と本文確定の**後**に呼ぶ
  （古いサイズで bbox を見積もらない）。
  - 確認: 文字数が変わる編集の後、ボックスが中心固定で伸縮すること（手動）。

### G4. per-char / per-line 属性のプレビュー反映 — `src/canvas-tools.js`

- **REQ-G4.1** `renderInnerText` は `charRubies` を **lineLeadings 有りの経路と無しの経路の
  両方**で `appendLineWithTracking` に渡す。**片方への渡し漏れはルビ消失の直接原因。**
  - 確認: `appendLineWithTracking(` の**全呼び出し**に `charRubies` 引数が含まれることを grep 確認
    （`rg "appendLineWithTracking\(" src/canvas-tools.js`）。複数行にルビ → 編集モード終了 →
    ルビが残ること（手動）。
- **REQ-G4.2** per-char マップの index は**本文の絶対 index**（行内相対や 1 始まりではない）。
  `appendStyledSegment` で `lineStartIdx + posInSegment` から絶対 index を引く。
  - 確認: 2 行目以降の特定文字にサイズ変更 → その文字だけ反映されること（手動）。
- **REQ-G4.3** ルビ entry は `end`（範囲終端）必須。`appendRubySegment` は mono / group を
  正しく描画し、scale を rt の font-size に反映する。
  - 確認: グループルビ・モノルビ双方が表示されること（手動）。
- **REQ-G4.4** `renderOverlay` の再描画で in-place 編集中のレイヤー DOM を破壊しない
  （フォント遅延ロード完了の再描画でキャレット/ルビが消えない）。
  - 確認: 編集中にフォント読込が走ってもキャレットが保持されること（手動）。
- **REQ-G4.5** **縦書きレイヤーの bbox「厚み」安全余白 (`thickSafety`) は 0**。
  `vertical-rl` は content が box の**右端（block-start）**に寄り、box 左端 = `nl.x` は固定
  （ドラッグ基準のため `scheduleBoxAutoFit` も left/top は触らず右/下端だけ content にハグする）。
  ここで thick safety を足すと余白が**必ず box の左側**に溜まる（＝自動配置テキスト左の余分な余白の
  原因）。横書きは content が上端に寄り、余白は下側に出て autofit が除去するので従来の安全余白を残す。
  - 対象 3 関数の thickSafety はいずれも `isVertical ? 0 : (lineCount > 1 ? 0.4em : 0)`:
    `layerRectForNew` / `layerRectForExisting`（`src/canvas-tools.js`）、`estimateLayerSize`
    （`src/auto-place.js`）。**この 3 関数は同じ式に揃える**（配置中心・実描画枠・原稿追従再配置が
    一致するため。`centerTopLeft` / `syncPlacedFromTxt` / `recenterBox` がこれらを共有する）。
  - **REQ-G10.7 の JSX `_thickSafetyEm` と必ず一致させる**（縦書き = 0）。不一致だと UI と PSD で
    縦書きテキスト右端が thickSafety 分ズレる（典型バグ）。
  - 確認: `rg -n "thickSafety|THICK_SAFETY" src/canvas-tools.js src/auto-place.js`（3 箇所すべて
    `isVertical` 分岐）。縦書き複数行を自動配置 → フレーム左に余分な余白が出ず、文字に沿うこと（手動）。

### G5. ルビ適用 — `src/main.js`（`bindRubyTool` / `doApply`）

- **REQ-G5.1** `doApply` は `setCharRubiesRange`（state 更新）を `applyEditModeRubyToRange`
  （DOM プレビュー）**より先**に呼ぶ。UI だけ更新すると次の input で `shiftCharMap` がルビを落とす。
  - 確認: ルビ適用 → 直後に本文を 1 文字編集してもルビが残ること（手動）。
- **REQ-G5.2** ルビ適用時、親文字行に `setLineLeading(rubyLeadingPct)` を自動設定し、ルビ用の
  行間を確保する。0 行目など前行が無い場合はスキップ。
  - 確認: ルビ適用で当該行の行間が広がること（手動）。

### G6. ルビ位置の UI→PSD 同期 — `src/canvas-tools.js` / `src/bind/save.js`

- **REQ-G6.1** 保存時、`exportEdits()` を呼ぶ**前**に `measureAllRubyOffsetsSync()` を実行し、
  `.ruby-wrap[data-ruby-start]` の実描画位置を `setCharRubyOffset` で state へ書き戻す。
  - 確認: `runSaveWithMode` で `measureAllRubyOffsetsSync()` が `exportEdits()` の前にあること
    （`rg "measureAllRubyOffsetsSync" src/bind/save.js`）。ルビ位置を動かして保存 → PSD で同位置（手動）。

### G7. 履歴（undo/redo） — `src/state.js`

- **REQ-G7.1** `snapshotState()` は `txtSource` を含む。`restoreSnapshot()` は edits / newLayers /
  nextTempId / txtSource を復元し、stale な `txtSelection` / `txtSelectedBlockIndex` をクリアする。
  - 確認: `snapshotState` に `txtSource` が含まれること（`rg "txtSource" src/state.js`）。
    原稿ダブルクリック編集 → undo で本文とレイヤーが同時に戻ること（手動）。
- **REQ-G7.2** ドラッグ・一括編集・ルビ適用・段落削除等の連続更新は `withHistoryTransient` で
  1 スナップショットに束ねる（undo 1 回で巻き戻る）。
  - 確認: 各操作が undo 1 回で戻ること（手動）。

### G8. プロジェクト保存 / 再オープン（.opus） — `src/state.js` / `src/services/project.js`

- **REQ-G8.1** `applyProjectSnapshot(snapshot, { silentTxtListener: true })` で復元時の
  `txtSourceListeners` 発火を抑制する。これがないと `syncPlacedFromTxt` が空 charRubies で
  手動ルビを上書きしてしまう（**手動ルビ消失の典型原因**）。
  - 確認: `services/project.js` の復元呼び出しが `silentTxtListener: true` であること。
- **REQ-G8.2** 復元後は listener 経由ではなく、明示的に `renderTxtSourceViewer` /
  `renderAllSpreads` / `rebuildLayerList` を呼んで UI を同期する。
  - 確認: per-char ルビを振って保存 → 閉じて再オープン → ルビが保持されること（手動）。

### G9. 自動配置 — `src/auto-place.js`

- **REQ-G9.1** `mapBlockToNewLayer` / `mapTxtToPageCenter` は生成レイヤーに `sourceTxtRef`
  （`{pageNumber, paragraphIndex}`）を必ず付与する（後の `syncPlacedFromTxt` の追従に必須）。
  - 確認: 自動配置後に原稿編集 → 配置レイヤーが追従すること（REQ-G2.1 と同じ手動確認）。
- **REQ-G9.2** ルビ注記 `{親}(ふりがな)`（全角括弧も）を `parseRubyAnnotatedText` でパースし、
  本文から注記を除いた親文字を contents に、ルビを charRubies に入れる。
  - 確認: ルビ注記入り TXT を自動配置 → 親文字のみ本文・ルビが付くこと（手動）。
- **REQ-G9.3** 縦書きの半角→全角変換（`convertHalfToFullForVertical`）を**原稿追記とレイヤー
  contents の両方**へ同じ規則で適用する（不一致だと TXT とレイヤーが乖離）。
  - 確認: 縦書きで数字入りテキストを配置 → 原稿とレイヤーの表記が一致すること（手動）。

### G10. PSD 書き戻し — `src-tauri/src/jsx_gen.rs`

- **REQ-G10.1** レイヤー本文設定時、改行を `\r` に正規化する（`normalizeLineBreaks`：
  `\r\n`→`\r`、`\n`→`\r`）。
  - 確認: 複数行テキストが PSD で正しく改行されること（手動）。
- **REQ-G10.2** per-char / per-line 系（`applyPerCharSizesAndFonts` / `applyPerCharBolds` /
  `applyPerCharItalics` / `applyLineLeadings` / `applyRepeatedDashTracking` / `applyTateChuYoko` /
  `applyPunctuationTsume` / `applySymbolFont` 等）の `executeAction(set, ...)` は `set` クラスを
  **`textLayer`（`textKey` 不可）**にする。`textKey` だと Photoshop が新 textStyleRange を破棄する。
  - 確認: per-char サイズ/フォント/太字/縦中横/ツメ/記号フォントが PSD に反映されること（手動）。
- **REQ-G10.3** 句読点ツメ `mojiZume` は **0..1 の fraction**（50% = 0.5）で渡す
  （`punctuationTsumePercent` 0–100 を /100 する）。50 を直接渡すと bbox 崩壊で文字不可視になる。
  - 確認: 「、」「。」が約 50% 詰まること、文字が消えないこと（手動）。
- **REQ-G10.4** apply\* の**実行順序**を維持する（Phase A: 行間 → per-char サイズ/フォント →
  塗り → スケール → 太字/斜体 → ルビ → 記号フォント → 句読点ツメ → 連続記号ツメ → 縦中横 →
  回転）。各段は前段の textStyleRange を baseStyle として clone するため、順序が崩れると属性が落ちる。
  - 確認: ルビ + 記号 + 縦中横 + ツメを同時に持つレイヤーで全属性が反映されること（手動）。
- **REQ-G10.5** Phase B: `applyDefaultTextSettingsToAllLayers`（autoKerning=MANUAL /
  antiAlias=Sharp）の DOM 代入は textStyleRange を flatten するため、その**後**に
  `reapplyPunctuationTsumeForAllLayers` / `reapplyRepeatedTrackingForAllLayers` /
  `reapplySymbolFontForAllLayers` 等で per-char 属性を再適用する。
  - 確認: 保存後の PSD で句読点ツメ・連続記号ツメ・記号フォントが残ること（手動）。
- **REQ-G10.6** `applySymbolFont` はユーザーの per-char 手動フォント指定（charFonts）を尊重し、
  未指定の記号位置のみ symbolFontPostScriptName に置換する。
  - 確認: 記号にユーザーが別フォントを当てた場合、それが保持されること（手動）。
- **REQ-G10.7** ルビレイヤーは autoLeadingPercentage 方式（固定 leading でなく）で行間を確保し、
  `createRubyLayer` の uiOffset（measureAllRubyOffsetsSync 由来）を優先する。新規レイヤーの縦書き
  位置はアンカー差を補正する。saveAs パスは `\` を `/` に正規化する。
  - 新規レイヤー縦書きの位置補正（`nl.direction === "vertical"`）は `bounds.top-right` を
    `nl.x + _thickCanvas` に揃える。`_thickCanvas = _ptInPx × (leadingFactor × lineCount + _thickSafetyEm)`
    で、この **`_thickSafetyEm` は JS 側 bbox（`layerRectForNew` の thickSafety / REQ-G4.5）と
    必ず一致**させる（縦書き = **0**）。`layerRectForNew` の thick から safety を抜いたのに JSX の
    `_thickSafetyEm` を 0.4 のまま残すと、UI（safety 無し）と PSD（safety 有り）で縦書きテキスト
    右端が 0.4em ズレる（**典型バグ／要 cargo パリティ確認**）。
  - 確認: `rg -n "_thickSafetyEm" src-tauri/src/jsx_gen.rs` が縦書き分岐で 0（= REQ-G4.5 と一致）。
    ルビ位置・縦書きテキスト位置が UI とほぼ一致すること、別名保存が成功すること（手動）。

### G11. payload パリティ — `src/state.js` `exportEdits` ↔ `src-tauri/src/lib.rs` `EditPayload`

- **REQ-G11.1** `exportEdits()` が出力する per-layer フィールド（contents / fontPostScriptName /
  sizePt / direction / leadingPct / fillColor / strokeColor / strokeWidthPx / rotation /
  syntheticBold / syntheticItalic / lineLeadings / charSizes / charFonts / charBolds /
  charItalics / charHorizontalScales / charVerticalScales / charTrackings / charKernings /
  charTateChuYokos / charFillColors / charRubies / sourceTxtRef）と、グローバル設定
  （dashTrackingMille / tildeTrackingMille / tateChuYokoEnabled / symbolFontReplaceEnabled /
  symbolFontPostScriptName / punctuationTsumePercent / rubyLeadingPct / rubyPhotoshopOffsetEm /
  rubyPhotoshopBiasPx）が、Rust `EditPayload` / `LayerEdit` / `NewLayer` の serde フィールドと
  **欠落なく対応**する。**新しいテキスト属性を足したら JS payload と Rust struct の両方に追加する。**
  - 確認: 新フィールド追加時、`exportEdits` の出力キーと `lib.rs` の `#[serde(rename = ...)]` が
    一致すること。`cargo check` が通ること。
- **REQ-G11.2** フォントは Rust 側で JSX へ emit する際 `font` キーに短縮される
  （JSX 内では `e.font` / `nl.font` を参照）。`fontPostScriptName` のまま渡すと undefined になる。
  - 確認: per-char / レイヤーフォントが PSD に反映されること（REQ-G10.2 と併せて手動）。
- **REQ-G11.3** `RubyEntry` の `offsetX` / `offsetY` / `absX` / `absY` は Option（任意）。
  measureAllRubyOffsetsSync で埋めた値が serde で渡ること。
  - 確認: ルビ位置が PSD に反映されること（REQ-G6.1 / G10.7 と併せて手動）。

### G12. 写植再利用モード — `src/services/reuse.js` / `src/psd-loader.js` / `src-tauri/src/jsx_gen.rs`（v2.3.0）

「文字入り PSD」を読み込み、文字を剥がして同位置・同内容で編集テキストとして作り直すモード。
テキスト反映ロジック（再生成・中心合わせ・元テキスト非表示・縦中横）の不変条件。

- **REQ-G12.1 元テキスト非表示**: 原稿ペインの背景は **bgImage（全テキストレイヤーを非表示にして
  書き出した「絵だけ」画像）**を使う。保存時は `reuseHideOriginalText`（appMode==="reuse"）→
  jsx_gen `hideAllTextLayers(doc)` ＋ `hideLayerIds` で**元テキストを全非表示**にし、抽出テキスト
  （newLayers）で写植し直す。元テキストとの**二重表示をしない**。
  - 確認: 写植再利用で読み込んだ原稿に元の文字が残っていない。保存後の PSD で元テキストレイヤーが非表示。
- **REQ-G12.2 同座標再生成**: `extractTextLayersToNewLayers` が `reusePsTextItems`（Photoshop 実読み）を
  優先し、無ければ ag-psd 抽出にフォールバックして、各テキストを **同じ内容・組方向で新規編集レイヤー化**する。
  内容は `\r`→`\n` 正規化。
  - 確認: 再生成テキストが元と同じ文章・縦横で編集できる。
- **REQ-G12.3 中心合わせ（UI）**: `layerRectForNew` は実テキスト寸法 `textLongPx`（measureText 由来）/
  `textThickPx`（thickSum）を返し、`alignReuseLayersToSourceCenters(targets, pages)` がフォントロード後に
  **実テキスト中心を元レイヤー中心に合わせる**（縦書きは厚み=右アンカー）。**DOM 測定
  （`uiTextBasisRectForBox`）は枠を測ってしまうため中心合わせに使わない。**
  - 確認: 再生成テキストが見本と同じ位置に重なる。
- **REQ-G12.4 中心合わせ（保存）**: 各再生成レイヤーは `reuseSrcCx/Cy`（元中心 PSD px）を持ち、保存の位置補正で
  **実 bounds 中心を `reuseSrcCx/Cy` に合わせる**。`exportEdits`（…rest 経由）→ Rust `NewLayer.reuse_src_cx/cy`
  （serde rename）→ jsx_gen emit/位置補正、の3層に**欠落なく**渡す（REQ-G11.1 と同じ規律）。
  - 確認: 保存後の PSD のテキストが元位置に重なる。
- **REQ-G12.5 枠の詰め＋autofit除外**: 詰め枠レイヤーは `reuseTightThick` で厚み安全余白を 0 にし、box に
  `layer-box-reuse-tight` を付けて **`scheduleBoxAutoFit` から除外**する（autofit が右へ広げて縦書きを右ずれ
  させるのを防ぐ）。`reuseTightThick` は UI 専用 boolean（Rust 側 struct には不要、unknown field は無視）。
  - 確認: 縦書き複数列で左余白が出ない。ページ切替の再描画で右にずれない。
- **REQ-G12.6 縦中横の保存反映**: 全角 2 連 `！！/！？/？！/？？` と単一合成文字 `‼⁇⁈⁉` を**半角 2 文字へ変換**して
  縦中横対象にする。変換は **新規レイヤー作成直後（書式適用前）に一度だけ**行い、`applyTateChuYoko` 内で contents を
  再代入して書式を壊さない。autoKerning flatten で cross が落ちるため `reapplyTateChuYokoForAllLayers` を
  **Phase B の最後**に実行する（記号フォント/manual spacing 再適用の後）。
  - 確認: 写植再利用で `!! / !? / ‼ / ⁉` 等が保存後の PSD で縦中横になる（通常写植と同じ）。

---

## 3. 移植機能の要件（PORT_NOTES_2026-05-29）

`PORT_NOTES_2026-05-29` で別フォーク（PsDesign）から移植した 7 機能（A〜G）の不変条件。
A/B はルビ操作 UX（テキスト系・G4/G5 と関連）、C/D/E は Photoshop 保存経路の堅牢化
（G6/G10 と関連）、F/G は dev/起動インフラ。トレーサビリティのため本書に記録する。

> **最終検証: 2026-05-29 — A〜G すべて存在・配線・順序を確認。`npm run check`
> （encoding + lint + build）と `cargo check` 緑。破損箇所なし。**

- **REQ-P1（A: ルビ「親文字指定」長押し sticky モード）** — `src/main.js bindRubyTool`
  - 守るべき条件: sticky 宣言群（`STICKY_LONG_PRESS_MS` / `stickyParentSelect` / `setStickyMode` /
    `isStickyParentSelectActive` / `reopenParentSelectIfSticky` / `cancelLongPress`）が
    `const updateSelection` より**前**（＝REQ-P7）。`parentSelectBtn` は click ではなく
    pointerdown/up/leave/cancel + keydown で配線（旧 `addEventListener("click", openParentSelectDialog)`
    は撤去）。`doApply` 末尾 rAF 内で `if (isStickyParentSelectActive()) reopenParentSelectIfSticky()`。
    `updateSelection` の else 分岐で編集対象喪失時 `setStickyMode(false)`。`noFocusSteal(parentSelectBtn)` 維持。
  - 確認方法: `rg -n "STICKY_LONG_PRESS_MS|const updateSelection" src/main.js`（前者 < 後者）+
    旧 click ハンドラが無いこと。手動: 500ms 長押し→accent 色 ON、適用後にダイアログ自動再オープン、短押しで解除。
  - 現状: ✅ 宣言 2225–2259 < updateSelection 2266 / pointer 配線 2319 / hook 2490。
- **REQ-P2（B: 親文字セル長押しドラッグ複数選択）** — `src/main.js openParentSelectDialog`
  - 守るべき条件: 最後の `grid.appendChild(line)` 直後に drag-select 一式（`PARENT_CELL_LONG_PRESS_MS` /
    `enterDragSelectMode` / `handleDragSelectMove` / `endDragSelect` / `swallowClick` + grid の
    pointerdown/move/up/cancel/leave + `window` blur）。既存 `cell.addEventListener("click", ...)`
    （個別 toggle）は**維持**。`swallowClick` は capture で 1 回だけ後続 click を握りつぶす。
  - 確認方法: `rg -n "PARENT_CELL_LONG_PRESS_MS|swallowClick" src/main.js`。手動: セル 250ms 長押し→
    ドラッグで通過セル選択、短クリックは toggle のまま。
  - 現状: ✅ 2095–2165 / swallowClick 2137–2143。
- **REQ-P3（C: スクラッチディスク容量の事前チェック）** — `src/bind/save.js` + `src-tauri/src/lib.rs`
  - 守るべき条件: `runSaveWithMode` の `hasEdits()` 直後に `const scratchOk = await ensurePhotoshopScratchOk();
    if (!scratchOk) return;`。5 段階 `SCRATCH_LEVELS`（5/10GB=danger、20/50/100GB=warning、100GB 以上は無表示）。
    Rust `get_photoshop_scratch_free_space`（`GetDiskFreeSpaceExW`）が `generate_handler!` に登録。
    save.js が `confirmDialog` を import。セッション中 1 回承認で再表示しない。
  - 確認方法: `rg -n "ensurePhotoshopScratchOk" src/bind/save.js`、
    `rg -n "get_photoshop_scratch_free_space" src-tauri/src/lib.rs`。手動: 保存時に空きに応じた警告ダイアログ。
  - 現状: ✅ save.js 528/579/616 / lib.rs 925(コマンド)・1181(登録)。
- **REQ-P4（D: Photoshop 起動時警告ダイアログ自動 OK）** — `src-tauri/src/photoshop.rs` + `lib.rs`
  - 守るべき条件: `start_background_dialog_watcher`（常時 2 秒監視。`lib.rs` setup の先頭で起動）/
    `start_scratch_dialog_auto_dismiss`（PS spawn 直後の 90 秒 500ms polling）/
    `dismiss_known_photoshop_dialogs`（6 段戦略: BM_CLICK → WM_COMMAND IDOK → VK_RETURN KEYDOWN/UP →
    WM_CHAR → SetForegroundWindow+SendInput Enter → WM_CLOSE）。windows / 非 windows の cfg 分岐。
  - 確認方法: `rg -n "start_background_dialog_watcher|start_scratch_dialog_auto_dismiss|dismiss_known_photoshop_dialogs" src-tauri/src/photoshop.rs`、
    setup に `photoshop::start_background_dialog_watcher()`。手動: 起動時の容量警告が自動 OK、dev で `[ps-dismiss]` ログ。
  - 注記: 戦略 5 はグローバルフォーカスを一時奪取して Enter 送信（PORT_NOTES 設計通り。
    Skia UI の Photoshop CC 2024+ 対策。常時監視は OPUS 起動中ずっと 2 秒間隔で走る）。
  - 現状: ✅ photoshop.rs 67(spawn 直後)/203/215/221/232/235 / lib.rs setup 1127。
- **REQ-P5（E: JSX 内ダイアログ抑制）** — `src-tauri/src/jsx_gen.rs` `HEADER`
  - 守るべき条件: `#target photoshop` 直後に try/catch で `app.displayDialogs = DialogModes.NO` と
    `app.userInteractionLevel = UserInteractionLevel.SUPPRESSALERTS`（PS 起動時ダイアログは抑制不可なので
    REQ-P4 と併用）。
  - 確認方法: `rg -n "displayDialogs = DialogModes.NO" src-tauri/src/jsx_gen.rs`。
  - 現状: ✅ 535–536。
- **REQ-P6（F: Vite host = true）** — `vite.config.js`
  - 守るべき条件: `host: host || true`（全インターフェース listen。localhost の IPv4/IPv6 解決差で
    dev サーバへの接続が失敗するのを回避。`TAURI_DEV_HOST` 指定時はそちら優先）。
  - 確認方法: `rg -n "host: host \|\| true" vite.config.js`。手動: `http://localhost:1430` /
    `http://127.0.0.1:1430` どちらでも接続できる。
  - 現状: ✅ 13。
- **REQ-P7（G: main.js TDZ 回避 = sticky 宣言の前方配置）** — `src/main.js`
  - 守るべき条件: REQ-P1 の sticky 宣言群を `const updateSelection` の**前**に置く。`updateSelection` は
    `typeof setStickyMode` を参照し、`bindRubyTool` 末尾で起動直後に直接呼ばれる。TDZ 内 const を typeof
    参照すると ReferenceError となり `bindRubyTool` が落ち、init が止まって**スプラッシュ画面で停止**する。
  - 確認方法: `rg -n "const setStickyMode|const updateSelection" src/main.js`（前者 < 後者）。
    手動: `npm run tauri dev` でスプラッシュから先へ進みメイン画面が表示される。
  - 現状: ✅ setStickyMode 2230 < updateSelection 2266。

---

## 4. プッシュ前チェックリスト

GitHub に push する前に、以下を上から順に実施する。

1. **[必須] `npm run check` が成功する**（= `check:encoding` + `lint` + `build`）。
   - 失敗したら原因を解消するまで push しない。文字化け/BOM、未定義変数、ビルドエラーを潰す。
2. **[テキスト反映系に触れた場合] 関連 REQ の「確認方法」を実施**する。
   特に以下の高リスク不変条件を確認:
   - REQ-G3.3: 新規 per-char マップを足したなら `shiftCharMap` 対象に追加したか。
   - REQ-G4.1: `appendLineWithTracking` の全呼び出しに `charRubies` を渡しているか。
   - REQ-G6.1: 保存前に `measureAllRubyOffsetsSync()` を呼んでいるか。
   - REQ-G8.1: プロジェクト復元は `silentTxtListener: true` か。
   - REQ-G10.2: per-char 系の `set` クラスは `textLayer` か。
   - REQ-G11.1: JS payload と Rust struct の双方に新フィールドを足したか。
   - REQ-G4.5 / G10.7: bbox の縦書き thickSafety を変えたなら、JS 3 関数と JSX
     `_thickSafetyEm` を同値に揃えたか（不一致だと縦書きテキストが UI↔PSD でズレる）。
   - REQ-G12.4: 写植再利用の `reuseSrcCx/Cy` を JS→Rust→JSX の3層に渡したか。
   - REQ-G12.6: 縦中横は半角化を作成時に1回＋`reapplyTateChuYoko` を Phase B 最後で再適用したか。
3. **[最低限の手動スモークテスト]**（`npm run tauri dev` 実機、テストモード可）:
   1. ルビを適用 → 保存 → 再オープンしてルビが保持される。
   2. 本文の前方を編集しても per-char 属性（サイズ/フォント/太字/ルビ）が正しい文字に残る。
   3. 自動配置 → 原稿テキストを編集 → 配置レイヤーが追従し、手動ルビが消えない。
   4. undo で原稿テキストとレイアウトが同時に巻き戻る。
4. **[バグを修正した場合] [DEBUG.md](DEBUG.md) に 1 エントリ追記**する
   （事例・症状・根本原因・対策・影響ファイル・関連 REQ・検証方法）。
5. 上記すべて完了後に commit / push する。

> 本書の REQ は実装の不変条件を要約したもの。実装の詳細・経緯は [CLAUDE.md](CLAUDE.md) を参照。
> 矛盾を見つけたら、コードを正として本書を更新すること。
