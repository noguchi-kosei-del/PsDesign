# DEBUG.md — バグ事例・原因・対策ログ

> **このドキュメントの目的**
> テキスト反映ロジック（および関連機能）で発生したバグの「**事例 / 根本原因 / 対策**」を蓄積し、
> 同種バグの再発防止と原因切り分けの高速化に使う知見ベース。
>
> **運用ルール**
> 1. **バグを修正したら、GitHub に push する前に必ず本書へ 1 エントリ追記する。**
> 2. 可能な限り関連する [RDD.md](RDD.md) の要件 (REQ-Gx.x) を紐付ける。
>    （対応する REQ が無ければ、RDD.md 側に要件を追加することも検討する。）
> 3. 新しいエントリは「## エントリ」セクションの**先頭（新しい順）**に追加する。
> 4. 記入は下の「エントリ テンプレート」をコピーして使う。

---

## エントリ テンプレート

```markdown
### [BUG-YYYYMMDD-NN] 一行サマリ

- **日付**: YYYY-MM-DD
- **関連バージョン**: vX.Y.Z（任意）
- **症状**: ユーザーから見て何が起きたか
- **再現手順**: 1. … 2. … 3. …
- **根本原因**: なぜ起きたか（コードレベルの原因）
- **対策**: どう直したか（関数・経路）
- **影響ファイル**: `path/to/file.js` ほか
- **関連 RDD 要件**: REQ-Gx.x
- **検証方法**: 修正が効いていることをどう確認したか
- **備考 / 再発防止**: 追加で気をつける点（任意）
```

---

## エントリ（新しい順）

### [BUG-20260618-07] Ctrl+Z が 3〜4 手分まとめて戻る（historyTransientDepth リーク）

- **日付**: 2026-06-18
- **関連バージョン**: v2.6.2（未リリース作業）
- **症状**: 写植を読み込んである程度作業し、途中でプロジェクト保存して作業を続けると、Ctrl+Z を 1 回押すと 3〜4 手前の状態まで一気に戻ることがある。プロジェクトから開き直すと起きない（再現性は不明瞭）。
- **再現手順**: 1. 写植を自動配置して作業 2. テキストを in-place 編集（ダブルクリック）した状態のまま、ページ送り / 表示モード切替 / 再描画が走る 3. 以降の数手が個別 undo できず、Ctrl+Z で一気に戻る。
- **根本原因**: in-place 編集は開始時に `beginHistoryTransient()`（`historyTransientDepth++`）を呼び、`finalize()`（blur/Enter/Esc/外部呼び出し）で `commit/abortHistoryTransient()` して depth を戻す設計。しかし `spread-view.js renderAllSpreads()` は `root.innerHTML = ""` で全 DOM（`.layer-box.editing` 含む）を破棄するのに、破棄前に `__finalize` を呼んでいなかった。編集中にページ送り・表示モード切替・各種再描画が走ると編集 DOM が finalize されず消え、`historyTransientDepth` が 1 のまま詰まる。以降 `pushHistorySnapshot()` が `if (depth > 0) return;` で無言の no-op になり、詰まり中の変更が snapshot されず、Ctrl+Z がそれらをまとめて 1 手で戻る。プロジェクト再オープンは `resetHistoryBaseline()` が depth を 0 に戻すため起きない（保存では戻らない）。CLAUDE.md v2.5.1 の undo/redo 断続失敗と同系の詰まり機構。
- **対策**:
  1. **根因**: `renderAllSpreads()` の冒頭（`root.innerHTML = ""` の前）で `commitActiveInPlaceEdit()` を呼び、DOM 破棄前に進行中の in-place 編集を必ず finalize（= transient を確定）する。`commitActiveInPlaceEdit` は `.editing` 解除と `__finalize=null` を先に行うため、finalize 内の `refreshAllOverlays`/`rebuildLayerList` から再入しても二重発火しない。auto-place の transient は全て `renderAllSpreads` 呼出前に commit/abort 済みなので干渉しない。
  2. **安全網**: `state.js` に `healLeakedHistoryTransient()` を追加し、`undo()` / `redo()` の先頭で呼ぶ。transient が開いていないはずの undo/redo 地点で depth>0 を検出したら、現在状態を 1 件 snapshot してから depth=0 に戻す。既に失われた粒度は復元できないが、詰まりが次操作以降へ持ち越されず（= Ctrl+Z が戻り続ける症状を断ち切る）、未保存の現在状態も失わない。depth=0 のときは no-op。
- **影響ファイル**: `src/spread-view.js`, `src/state.js`
- **関連 RDD 要件**: 該当なし（履歴 / in-place 編集ライフサイクル）
- **検証方法**: 履歴機構の単体シミュレーション（通常 undo は 1 手ずつ / リーク時は初回 undo でバッチ復帰後に自己回復して以降は粒度維持）、`npm run check`（encoding / security / lint / build）成功。
- **備考 / 再発防止**: in-place 編集の `beginHistoryTransient` を伴う long-lived transient は、編集 DOM を破棄するあらゆる全再描画の前に必ず finalize すること。新たに DOM を全消去する経路を足すときは `commitActiveInPlaceEdit()` を先に呼ぶ。

### [BUG-20260618-06] 途中見開きPSD（"2,3.psd"・"4修正版.psd" 等）でテキストが別ページへ流し込まれる

- **日付**: 2026-06-18
- **関連バージョン**: v2.6.2（未リリース作業）
- **症状**: 途中に見開き（1 ファイルに 2 ページ）が混在する PSD 群（例: `1p修正版.psd` / `2,3.psd` / `4修正版.psd` …）を読み込み、見開き部分を非表示にすると、ページ番号がずれてテキストが正しいページに流し込まれない。
- **再現手順**: 1. `1p修正版.psd`・`2,3.psd`（見開き）・`4修正版.psd`…のように「先頭数字＋後続文字」やカンマ区切りのファイル名 PSD を読み込む 2. 自動配置すると、見開き以降のページでテキストが 1 ページぶんずれて配置される。
- **根本原因**: 3 つの要因が重なっていた。
  - (a) `psd-loader.js parseExplicitSpreadPageNumbers` がカンマ/読点区切り（`2,3` `2、3` `２，３`）を解釈できず、横長見開き PSD が左右ページへ分割されなかった（見開き PSD をそのまま読み込むケース）。
  - (b) `auto-place.js parsePsdPageNumbersFromPath` が「先頭数字＋日本語」（`4修正版`→4）やカンマ区切りを解釈できず `fallbackPageNumber = index+1` に落ち、論理ページ番号がずれた。
  - (c) **本命**: 見開き相当ページを見本で非表示にして単ページ PSD だけ（例: `1p修正版` `4修正版` `5修正版` `6` `7`）で写植する運用では、画像スキャン由来 TXT が「見本順の連番」`<<1Page>>..<<5Page>>`（`referenceScanDocToText`）で出るのに対し、`pageToPsdIndices` は実ページ番号（`4修正版`→4）で引くため番号系が食い違う。TXT 連番 P4（実ページ6=サッカー）が `pageToPsdIndices.get(4)`=「4修正版」へ流れ、本来の `6.psd` は空になり、`4修正版` にバスシーン文と重なって配置された。(b) のパース修正でこの食い違いが顕在化した（修正前は parse 失敗の fallback で偶然 1:1 になっていた）。この読み替えを行う `txtGroupsUseReferenceOrder` が `logicalPages[0] > 1` のときしか発火せず、ページ 1 が存在し途中に飛番（見開きスキップ）があるケースを取りこぼしていた。
- **対策**:
  1. `parseExplicitSpreadPageNumbers`（psd-loader.js）: NFKC 正規化 + カンマ/読点（`,` `，` `、`）区切りの見開き表記に対応 → `2,3.psd`（横長）が右(p2)/左(p3)へ正しく分割。
  2. `parsePsdPageNumbersFromPath`（auto-place.js）: NFKC 正規化後、「先頭の見開き表記」→「先頭の単ページ数字（後続文字許容）」→「旧来の末尾アンカー」の順で解釈。`4修正版`→[4]、`1p修正版`→[1]、`2,3`→[2,3]。
  3. `buildPsdPageMap`（auto-place.js）: 枚数一致（見本=PSD）時は位置対応(1:1)を最優先。論理マッピングは見開き/論理ずれ＋枚数不一致のときに限定し、見本がフル（≥ 論理最大ページ）なら割り当てを実ページ番号 **N→index N-1**、圧縮見本ならランクに分岐。
  4. **`txtGroupsUseReferenceOrder`（auto-place.js）の発火条件を拡張**: 「論理ページが 1..K 連番でない（飛番/歯抜け）」かつ「TXT のページ番号が 1..K の連番（= 見本順 / 画像スキャン由来）」のときに、TXT ページ N → `logicalPages[N-1]`（見本順 N 番目の実ページ）へ読み替える。原稿テキストが実ページ番号（飛番あり）で書かれている場合（連番でない）は読み替えない。これでサッカー文が `6.psd`、バス文が `4修正版.psd` へ正しく配置される。
- **影響ファイル**: `src/psd-loader.js`, `src/auto-place.js`
- **関連 RDD 要件**: 該当なし（見開きページ対応 / 自動配置ページ対応ロジック）
- **検証方法**: ①実ファイル名の `parsePsdPageNumbersFromPath` / `parseExplicitSpreadPageNumbers` 単体確認、②非表示見開き運用（単ページ PSD 5 件 + 見本 2,3 非表示 + 画像スキャン連番 TXT）の配置マッピング全経路シミュレーション（TXT P2→4修正版/p4・TXT P4→6.psd/p6 を確認）、③連番分割(18)/実番号 TXT 飛番/開始>1 の各回帰シミュレーション、④`npm run check`（encoding / security / lint / build）成功。
- **備考 / 再発防止**: PSD ファイル名のページ番号は「先頭数字＋日本語」「カンマ区切り見開き」「全角数字」が現場で頻出する。新たな命名に対応するときは psd-loader.js（分割判定）と auto-place.js（ページ対応）の両方を必ず揃える。

### [BUG-20260618-05] 「！」「…」等の細グリフが配置/保存で右へ大きくずれる

- **日付**: 2026-06-18
- **関連バージョン**: v2.6.2
- **症状**: 「！」「…」など字面が細い縦書き単グリフを配置、または PSD 保存すると、位置が列の右へ大きくずれる。
- **再現手順**: 1. 縦書きで「！」または「…」のみのテキストを配置する 2. プレビュー上で右にずれて見える 3. PSD 保存後の位置とも食い違う。
- **根本原因**: フロントの `scheduleVerticalSingleLineAnchor` が、縦書き 1 行テキストの実描画右端を枠右端に揃える transform（`boxRight - contentRect.right`）を当てていた。字面が列幅より細く列中央に寄ったグリフでは補正量が約半列ぶんになり右へ大きくずれる。保存側 jsx_gen.rs は v2.6.1 でこれらを中央寄せ済みだったため、フロント（右端揃え）と保存（中央寄せ）が食い違っていた。
- **対策**: `src/canvas-tools.js` の `scheduleVerticalSingleLineAnchor` を保存側 `_shouldCenterSingleColumn` と同じ判定に統一。保存側と同一集合 `isVerticalCenterRiskCharCode` / `isVerticalRightEdgePunctuationCharCode` を移植し、中央寄せ対象（「！」「…」「ー」等）または細い非・右端約物は右端揃え transform を当てず列中央のままにした。「、」「。」と全角字は従来どおり右端揃え。
- **影響ファイル**: `src/canvas-tools.js`
- **関連 RDD 要件**: REQ-G4.5 / REQ-G10.7（縦書き bbox / 保存座標一致）
- **検証方法**: 文字分類の単体動作確認、`npm run check`
- **備考 / 再発防止**: 縦書き単列の位置補正はフロントと jsx_gen.rs で必ず同じ文字集合・同じ寄せ方を使う。

### [BUG-20260618-04] リサイクルで先頭/最終行に空行ができて配置がずれる

- **日付**: 2026-06-18
- **関連バージョン**: v2.6.2
- **症状**: リサイクルしたテキストの 1 行目または最終行にテキストの無い空行ができ、可視テキストが空行ぶんずれて配置される。
- **再現手順**: 1. 段落末尾に改行を持つテキストレイヤーを含む PSD をリサイクルする 2. 再生成されたテキストの先頭/最終に空行が入り、元の見本と位置がずれる。
- **根本原因**: Photoshop の `textItem.contents` は段落末尾の改行などで先頭/末尾に空行を含むことがある。新規レイヤーの厚み方向 bbox は contents の行数から推定するため、空行があると 1 行ぶん膨らみ、元レイヤーの bounds（描画ピクセル基準で空行を含まない）中心との中心合わせ・再現配置がずれた。
- **対策**: `src/services/reuse.js` に `trimReuseBlankLines` を追加し、リサイクル contents（Photoshop / ag-psd 両経路）から先頭/末尾の空行を除去（中間は保持）。原稿テキスト側（既に `.trim()` 済み）と一致させ `syncPlacedFromTxt` の不要な再リフローも防止。
- **影響ファイル**: `src/services/reuse.js`
- **関連 RDD 要件**: 該当なし（リサイクル写植再現ロジック）
- **検証方法**: 正規表現の単体動作確認（先頭/末尾除去・中間保持）、`npm run check`
- **備考 / 再発防止**: bbox 行数推定と元 bounds（ピクセル基準）の差に注意。Photoshop contents は前後の空行を持ち得る。

### [BUG-20260618-03] リサイクルで白文字に白フチが付く

- **日付**: 2026-06-18
- **関連バージョン**: v2.6.2
- **症状**: 元 PSD では白フチの無い白文字（黒地・集中線上の白抜き文字など）が、リサイクル配置で白フチ付きになる。
- **再現手順**: 1. 黒地に白文字のテキストを含む PSD をリサイクルする 2. 再生成された白文字に不要な白フチが付く。
- **根本原因**: 白率ヒューリスティック・無効化 stroke の誤読・祖先グループ効果の継承などで、塗り色と同色（白文字に白フチ）の冗長なフチが付与されていた。
- **対策**: `src/services/reuse.js` に `suppressRedundantStroke` を追加し、`fillColor === strokeColor`（白×白 / 黒×黒）のフチを `"none"` に除去。リサイクル配置 2 経路（Photoshop / ag-psd）に適用、通常編集には無影響。
- **影響ファイル**: `src/services/reuse.js`
- **関連 RDD 要件**: 該当なし（リサイクル写植再現ロジック）
- **検証方法**: `npm run check`
- **備考 / 再発防止**: 塗り色と同色のフチは視覚的に無意味。フチ判定の最終段で同色除去ガードを通す。

### [BUG-20260618-02] リサイクルで白フチが付いたり付かなかったりする（グループ境界線の取りこぼし）

- **日付**: 2026-06-18
- **関連バージョン**: v2.6.2
- **症状**: 元 PSD で境界線効果が付いているのに、リサイクル配置で白フチが付くレイヤーと付かないレイヤーがまだらに出る。特に「白フチ＋ルビ」のレイヤーで再現される。
- **再現手順**: 1. 白フチ付きテキスト（一部はルビ付き）を含む PSD をリサイクルする 2. ルビ付きレイヤーの白フチが再現されず、背景の白い箇所では特に欠ける。
- **根本原因**: ① 読み取りの `strokeFromFrameFx` は純白/純黒以外を `null`(=none) に落とし背景白率ヒューリスティックへ流していた。② `strokeFromLayerEffects` はテキストレイヤー自身の layerEffects しか読まないが、OPUS は「白フチ＋ルビ」をサブグループへ境界線適用するため、テキスト層単体には frameFX が無く取りこぼしていた。
- **対策**: `src-tauri/src/jsx_gen.rs` で `strokeFromFrameFx` を 3 状態化（色未分類でも `"present"` を返す）+ 白/黒閾値を `>=235/<=20` に緩和。`strokeFromLayerEffectsWithAncestors` を新設し親グループを遡って frameFX を探す。`src/services/reuse.js` で `"present"` を白フチに解決。`src/psd-loader.js` の `readStrokeColor` 閾値緩和 + `collectReuseStrokeHintsFromAgPsd` の親グループ継承を追加。
- **影響ファイル**: `src-tauri/src/jsx_gen.rs`, `src/services/reuse.js`, `src/psd-loader.js`
- **関連 RDD 要件**: 該当なし（リサイクル写植再現ロジック）
- **検証方法**: `npm run check`, `cargo check --manifest-path src-tauri/Cargo.toml`
- **備考 / 再発防止**: 「元に効果が無い」と「読めなかった」を区別する（`"present"`）。境界線はテキスト層だけでなく祖先グループにも乗り得る。通常読み込み経路は `normalizeExtractedStrokeColor` が `"present"` を `"none"` に丸めるため無影響。

### [BUG-20260618-01] リサイクルで非表示レイヤーが配置されテキストが重なる

- **日付**: 2026-06-18
- **関連バージョン**: v2.6.2
- **症状**: PSD でテキストレイヤーを非表示にしているのに、リサイクルすると表示・再配置され、テキストが重なる。
- **再現手順**: 1. 一部テキストレイヤーを非表示にした PSD をリサイクルする 2. 非表示にしたテキストが可視の新規レイヤーとして配置され、見本に無いテキストが重なる。
- **根本原因**: Photoshop 一括/単体読み取り（jsx_gen.rs の `walk` / `collectTextLayers`）は可視・非表示を問わず全テキストレイヤーを返し `"visible"` を出力していたが、フロントの `extractTextLayersToNewLayers`（Photoshop 主経路）で `visible` を弾いていなかった。ag-psd フォールバック経路（`collectTextLayers`）は元々非表示を除外済みで、主経路だけ非対称だった。
- **対策**: `src/services/reuse.js` の Photoshop 経路ループに `if (it.visible === false) continue;` を追加。原稿テキスト生成より前に弾くので新規配置・原稿の両方から除外され、ag-psd 経路と挙動が揃う。
- **影響ファイル**: `src/services/reuse.js`
- **関連 RDD 要件**: 該当なし（リサイクル写植再現ロジック）
- **検証方法**: `npm run lint`, `npm run check:encoding`
- **備考 / 再発防止**: Photoshop 読み取りは非表示も含めて返す。フロント側で `visible` を必ず尊重する。

### [BUG-20260606-03] リサイクルの指定フォントモードで中丸フォントに切り替わらない

- **日付**: 2026-06-06
- **関連バージョン**: v2.3.7
- **症状**: リサイクルの「フォント・サイズを指定」で処理すると、OCR/背景判定上は中丸ゴシック相当の吹き出しでも、選択した通常フォントのまま配置される。白フチ・サイズ感・文字色も PSD/OCR 由来の結果が十分に反映されない。
- **再現手順**: 1. ウニ吹き出しや太い白フチのある PSD をリサイクル対象にする 2. 「フォント・サイズを指定」を選ぶ 3. 新規配置されたテキストが通常フォントのままになり、中丸ゴシック・白フチ・検出サイズ・色が反映されないことを確認する。
- **根本原因**: 指定モードでは選択フォント/サイズを強く優先しており、`autoFontSwitched` や背景解析由来の中丸判定、検出サイズ、PSD 読み取り色を上書きしていた。さらに中丸判定は PSD テキストの狭い bounds だけを見るため、ウニ吹き出し外周を拾えないケースがあった。
- **対策**: `src/services/reuse.js` で指定フォント/サイズを基本値にしつつ、OCR/背景判定が成立した場合は中丸フォント・白フチ・検出サイズを優先するよう整理した。中丸判定は拡張 bounds も解析し、スコアがしきい値以上なら bucket 0 でも切り替える。`src-tauri/src/jsx_gen.rs` では `textItem.color` を読み取り、黒/白/HEX 色を配置 payload に渡すようにした。
- **影響ファイル**: `src/services/reuse.js`, `src-tauri/src/jsx_gen.rs`, `src/ui-feedback.js`
- **関連 RDD 要件**: 該当なし（リサイクル写植再現ロジック）
- **検証方法**: `npm run check`, `cargo check --manifest-path src-tauri/Cargo.toml`
- **備考 / 再発防止**: 「ユーザー指定」は完全固定ではなく、PSD/OCR 由来の写植特徴を反映する基本値として扱う。背景解析の対象領域は PSD テキスト bounds だけに固定しない。

### [BUG-20260606-02] テストモードの原稿反映・用紙サイズ・縦書き枠が通常画面と違う

- **日付**: 2026-06-06
- **関連バージョン**: v2.3.7
- **症状**: テストモードで通常作業画面の動きが正確に再現されず、原稿テキストが配置済みテキストへ正しく反映されない。用紙サイズも通常想定の A4 ではなく、縦書きテキストの左側に余分な余白が出る。
- **再現手順**: 1. テストモードを起動する 2. 原稿テキストの変更や縦書き配置の見た目を確認する 3. 通常の PSD/PDF/原稿テキスト読み込み時と挙動がずれることを確認する。
- **根本原因**: テストモードの仮想ページとテキストレイヤーが、通常読み込み時の PSD/PDF/原稿テキスト連携に必要な `sourceTxtRef` や TXT パス状態を十分に持っていなかった。さらにページ寸法と縦書き bbox の扱いが通常配置の詰め枠と異なっていた。
- **対策**: `src/test-mode.js` で A4 縦 72dpi 換算の白紙 PSD/PDF と `テスト原稿.txt` を生成し、テスト配置レイヤーに `sourceTxtRef` を付与した。`src/state.js` で `reuseTightThick` を新規レイヤー状態に保持し、テストモードの縦書き枠でも左余白を抑えるようにした。
- **影響ファイル**: `src/test-mode.js`, `src/state.js`
- **関連 RDD 要件**: REQ-G2.1 / REQ-G2.2
- **検証方法**: `npm run check`, `cargo check --manifest-path src-tauri/Cargo.toml`
- **備考 / 再発防止**: テストモードは専用の簡易状態を作らず、通常画面が参照する PSD/PDF/原稿テキスト状態をできるだけ同じ形で初期化する。

### [BUG-20260606-01] PSD直接編集で空行を入れると配置テキストが欠ける

- **日付**: 2026-06-06
- **関連バージョン**: v2.3.7
- **症状**: PSD に配置されているテキストを編集して改行し、1 行空けると、改行した左側や後続のテキストが消失する。原稿テキストとテキストエディタの流れがずれ、テキストが正しく反映されない。
- **再現手順**: 1. 原稿テキストから PSD へテキストを配置する 2. PSD 上のテキストを in-place 編集する 3. 途中で空行を含む改行を入れる 4. 原稿テキスト側の段落分割と再同期により、配置済みテキストの一部が欠けることを確認する。
- **根本原因**: PSD 上の直接編集内容を原稿テキストへ逆同期するとき、空行を含む改行を原稿段落区切りとして扱っていた。その結果、1 つの吹き出し内のテキストが原稿側で複数段落に分裂し、配置レイヤーの `sourceTxtRef` が前半だけを参照する状態になっていた。加えて CR/LF の扱いが経路ごとに揺れており、行数・bbox・Photoshop 書き出しでズレが出やすかった。
- **対策**: `src/txt-source.js` の逆同期で空行を含む PSD 直接編集内容は原稿段落へ反映しないようにし、同一吹き出し内の空行として保持する方針にした。`src/canvas-tools.js` と `src-tauri/src/jsx_gen.rs` では改行分割を `\r\n` / `\r` / `\n` 共通に揃えた。
- **影響ファイル**: `src/txt-source.js`, `src/canvas-tools.js`, `src-tauri/src/jsx_gen.rs`
- **関連 RDD 要件**: REQ-G2.1 / REQ-G3.1
- **検証方法**: `npm run check`, `cargo check --manifest-path src-tauri/Cargo.toml`
- **備考 / 再発防止**: 「原稿の段落区切り」と「PSD レイヤー内の空行」は別概念として扱う。PSD 直接編集から原稿へ戻す処理では、本文整形の意味を勝手に変換しない。

### [BUG-20260601-01] 100MB 超の見本 PDF 圧縮進捗が読込フェーズで停止して見える

- **日付**: 2026-06-01
- **関連バージョン**: v2.2.9
- **症状**: ホームの写植用ファイル選択で 100MB 超の見本 PDF を選ぶと、警告後の圧縮進捗ダイアログが出ない、または `PDF読込` が 0% / 19% のまま止まって見える。
- **再現手順**: 1. 写植用ファイル選択で 100MB 以上の PDF を見本に指定 2. 警告ダイアログで OK 3. 圧縮処理に入ると進捗が読込フェーズで停滞する。
- **根本原因**: フロント側で巨大 PDF 全体を `read_binary_file` してから PDF.js / canvas / PDF 再生成による圧縮に入る設計だったため、ファイル読込中に実進捗を取れず UI が固まって見えた。さらに圧縮処理はメモリ・処理時間のばらつきが大きく、ホームモーダルとの重なり順やフェーズ表示の調整だけでは安定した UX にできなかった。
- **対策**: 100MB 以上の見本 PDF は圧縮せず、警告ダイアログを出して読み込み対象から除外する仕様に変更した。`rejectLargeReferencePdfFiles` でサイズを事前判定し、サムネイル生成・ページ数確認・本読み込みの各入口で同じガードを通す。圧縮用 JS モジュール、圧縮 PDF 保存 Tauri コマンド、`pdf-lib` 依存、圧縮進捗前面化の残骸を削除した。
- **影響ファイル**: `src/pdf-loader.js`, `src/main.js`, `src-tauri/src/lib.rs`, `package.json`, `package-lock.json`, `src/ui-feedback.js`, `src/styles.css`
- **関連 RDD 要件**: 該当なし
- **検証方法**: `npm run check`、`cargo check`、`npm run tauri -- --version`。また `rg` で `pdf-lib` / `pdf-compress` / `save_compressed_reference_pdf` / 圧縮進捗関連の参照が残っていないことを確認。
- **備考 / 再発防止**: 巨大ファイルを WebView 側で丸ごと読んでから処理する設計では、読込フェーズの実進捗を返せない。100MB 以上の PDF の扱いを再導入する場合は、Rust 側でストリーミング処理するか、最初から受け付けない方針を維持する。

### [BUG-20260601-02] npm 操作後に Tauri npm package と Rust crate の minor が不一致になる

- **日付**: 2026-06-01
- **関連バージョン**: v2.2.9
- **症状**: `Found version mismatched Tauri packages` エラーが出て Tauri 起動/ビルドが止まる。
- **再現手順**: 1. 依存整理で `npm uninstall` などを実行 2. `@tauri-apps/api` が `2.11.0` に解決される 3. Rust 側 `tauri v2.10.x` と minor がずれて mismatch エラーになる。
- **根本原因**: `package.json` の `@tauri-apps/api` が `^2` だったため、npm の再解決で Rust 側より新しい minor が入った。
- **対策**: `@tauri-apps/api` を `2.10.1` に固定し、`package-lock.json` も同じ版へ揃えた。
- **影響ファイル**: `package.json`, `package-lock.json`
- **関連 RDD 要件**: 該当なし
- **検証方法**: `npm ls @tauri-apps/api @tauri-apps/cli @tauri-apps/plugin-dialog @tauri-apps/plugin-process @tauri-apps/plugin-updater` で npm 側 API が `2.10.1` に揃うこと、`cargo tree -i tauri` で Rust 側が `tauri v2.10.3` であること、`npm run tauri -- --version` が成功することを確認。

### [BUG-20260530-02] 複数選択でフォントサイズを一括変換すると自動配置の色が一部消えない

- **日付**: 2026-05-30
- **関連バージョン**: v2.2.5
- **症状**: 自動配置で色マーカー（`autoFontSwitched` / バケット信号色）が付いたテキストを複数選択し、
  サイドバーで**フォントサイズを一括変換（揃える）すると、一部のテキストだけ色が消えない**。
- **再現手順**: 1. 背景の濃いコマ等で自動配置 → 複数レイヤーにバケット色が付く 2. そのうち一部を既定
  サイズと同じ値にしておく 3. それらを複数選択し、サイドバーのサイズ入力で全体を 1 つの値に揃える
  4. **元から目標値と同サイズだったレイヤーだけ色が残る**（フレーム / レイヤー一覧 / 原稿テキストの色）。
- **根本原因**: [src/text-editor.js](src/text-editor.js) `commitSingleFieldToSelections`（= サイドバーの
  サイズ一括変更の本体。`commitSizeToSelections` / サイズ入力 / +- / `[` `]` がすべて通る）に、
  値が同じレイヤーを飛ばす早期 `if (cur === value) continue;` がある。**色マーカーの解除コードは
  この continue の後にある**ため、「サイズを揃える」変更で**既に目標サイズと同値だった新規（自動配置）
  レイヤーは skip され、マーカーが解除されない** → 色が残る（＝同サイズだったものだけ残る）。
  正しく動く wheel 経路（[src/canvas-tools.js](src/canvas-tools.js) `resizeSelectedLayers`、v2.0.6 修正済み）
  は、サイズ未変更でも `autoFontSwitched === true` の新規レイヤーはマーカーを**無条件で先に解除**してから
  continue している。サイドバー経路にこの手当てが無いのが差。`commitFontToSelections`（フォント一括適用）
  も同型の `if (cur === ps) continue;` を持ち、同じクラスのバグだった。
- **対策**: wheel 経路と同じパターンを `commitSingleFieldToSelections`（size）と `commitFontToSelections`
  （font）の 2 関数に導入。**新規レイヤー(`ref.kind === "new"`) かつ `autoFontSwitched === true` のとき、
  値が未変更でもマーカー（`autoFontSwitched:false` / `autoFontSwitchBucket:-1`）だけ先に `updateNewLayer`
  で解除して `continue`** する。`any = true` を立てるので末尾の `if (mutated)` ブロック
  （`rebuildLayerList` / `refreshAllOverlays` / `refreshTextStyleMarkerViews`）が走り、フレーム・
  レイヤー一覧・原稿テキストパネルの 3 か所すべての色が更新される（`refreshTextStyleMarkerViews` が
  `renderTxtSourceViewer` を呼ぶため追加の refresh 配線は不要）。サイズは `field === "sizePt"` のときのみ
  解除（行間 `leadingPct` 変更ではマーカーを解除しない既存挙動と一致）。
- **影響ファイル**: [src/text-editor.js](src/text-editor.js)（`commitSingleFieldToSelections` /
  `commitFontToSelections`）
- **関連 RDD 要件**: 該当なし（自動配置の UI 色強調で、RDD のテキスト反映ロジックスコープ外）
- **検証方法**: 複数の自動配置色付きテキスト（一部は既定サイズと同値）を選択 → サイズ一括変更 →
  3 か所すべてで色が全消えすること（旧: 同値のものだけ残る）。+/- / `[` `]` 経由でも同様。フォント一括
  適用で既に同フォントの自動配置レイヤーの色も消えること。サイズが実際に変わるレイヤーは中心固定で
  サイズ反映＋色消えが従来どおり（リグレッション無し）。`npm run lint` / `build` / `check:encoding` 緑。
- **備考 / 再発防止**: 「編集したら自動配置の色マーカーを解除する」処理は、**値未変更で skip される
  経路でも必ず実行する**こと。一括 commit 系（`commitSingleFieldToSelections` /
  `commitFontToSelections` / wheel `resizeSelectedLayers`）は `cur === value` の早期 continue を持つので、
  マーカー解除はその continue より**前**に置く。

### [BUG-20260530-01] テキストエディタで「見本」に切り替えると重い（pdf-view ResizeObserver の再レンダ storm）

- **日付**: 2026-05-30
- **関連バージョン**: v2.2.5
- **症状**: テキストエディタモードで左ペインを「校正 → 見本」に切り替えると、切替の 0.3 秒間 UI が
  カクついて重い。
- **再現手順**: 1. 見本(PDF/画像)と PSD を読み込みテキストエディタモードに入る 2. 左ペインヘッダーの
  「見本」をクリック 3. 見本が左半分に展開する間、描画がカクつく / もたつく。
- **根本原因**: [src/pdf-view.js](src/pdf-view.js) の `ResizeObserver` が `.spreads-pdf-area`(`rootEl`)
  を observe し、コールバックで `schedule()` → `redraw()` → pdfjs `page.render()` を直接呼ぶ。
  「見本」切替では共有 transition rule（`.spreads-pdf-area` の `width 0.3s`）で pdf-area の幅が
  0.3 秒かけてアニメするため、**幅が毎フレーム変化 → ResizeObserver が毎フレーム発火**し、重い
  pdfjs 再レンダ（page.render は CPU コスト大、特に画像見本 / 大判ページ）が ~18 回連続で走る。
  `schedule()` は rAF debounce だが**同一フレーム内の発火しか合流しない**ため、フレームをまたぐ
  毎フレーム発火（= トランジション中の連続リサイズ）は間引けていなかった。
- **対策**: pdf-view.js に ResizeObserver 専用の **trailing debounce**
  （`scheduleResizeRedraw` / `RESIZE_REDRAW_DEBOUNCE_MS = 130`）を新設し、ResizeObserver の
  コールバックを `schedule()` 直呼びから `scheduleResizeRedraw()` に変更。連続リサイズ（width
  トランジション / ウインドウドラッグ）が収束してから 1 回だけ再レンダする。モード切替由来の明示
  `schedule()`（`onEditorLeftPaneModeChange` / `onParallelViewModeChange` 等）は即時のままなので、
  切替直後 1 回 + 収束後 1 回の計 2 回に削減（旧 ~18 回）。
- **影響ファイル**: [src/pdf-view.js](src/pdf-view.js)（`resizeRedrawTimer` / `scheduleResizeRedraw`
  追加、`ResizeObserver` コールバック差し替え）
- **関連 RDD 要件**: 該当なし（見本(PDF/画像)プレビューの描画パフォーマンスで、RDD のテキスト
  反映ロジックスコープ外）
- **検証方法**: テキストエディタで「校正 ↔ 見本」を往復してもカクつかないこと（手動）。ウインドウ
  リサイズ中も pdfjs 再レンダが収束後 1 回に間引かれること。`npm run lint` / `npm run build` 緑。
- **備考 / 再発防止**: 「ResizeObserver → 重い処理」は CSS の width/height トランジションと
  組み合わさると毎フレーム storm になりやすい。新たに ResizeObserver で重い処理（再レンダ等）を
  呼ぶ場合は trailing debounce を挟む。PSD 側 [src/spread-view.js](src/spread-view.js) にも同様の
  リサイズ → redraw 経路があるが、エディタモードでは PSD ペインが隠れるため今回の症状には無関係
  （必要なら同様の debounce 化を検討）。

### [BUG-20260529-01] プロジェクト(.opus)を開くとロード画面が 86% で完了になる

- **日付**: 2026-05-29
- **関連バージョン**: v2.2.4 後（未リリース作業ブランチ）
- **症状**: `.opus` プロジェクトを開くと、ロード画面（OPUS 進捗演出）のタスクパネル数値が 100% に
  到達せず **86% のまま「完了」して閉じる**。
- **再現手順**: 1. ホーム →「プロジェクトを開く」→ `.opus` を選択 2. ロード画面のタスクパネルが
  86% で止まったまま閉じる（タスク項目も全「完了」にならない）。
- **根本原因**: OPUS 進捗の "place" variant は determinate 進捗を**フェーズ窓でキャップ**する設計
  （`initialOpusPhaseEnd("place")=72`、`advanceOpusProgressPhase` 1 回で `72+14=86`、
  `maxOpusPhaseEnd("place")=94` クランプ）。完了時 `hideProgress({success:true, variant:"place"})`
  → `completeOpusProgress()` は `finishing=true` でミルキーバー（`--opus-progress-pct`）と上部カウンタ
  （`opus-counter-percent`、`updateOpusCopy` 行 `finishing ? 100`）を 100% にするが、**タスクパネル**
  （`opus-task-total-percent` + タスク一覧 = `updateOpusTasks`）を 100% 化するのは flow / "save" /
  "load" 分岐のみで、**"place"/"scan" 分岐が欠落**。`finishing` ループも `updateOpusTasks` を呼ばない
  ため、タスクパネルが読込時の最後の値（= 86 フェーズキャップ）で固着していた。
- **対策**: `completeOpusProgress()` に末尾 `else`（実質 place/scan）分岐を追加し、"load" 分岐と同形で
  `updateOpusTasks({ detail:"完了", current: total, total, pct:100, taskIndex: 末尾, taskProgress:100 })`
  を呼んでタスクパネルを 100% / 全「完了」に最終化する。
- **影響ファイル**: `src/ui-feedback.js`（`completeOpusProgress`）
- **関連 RDD 要件**: 該当なし（ローディング進捗 UI で、RDD（テキスト反映ロジック）のスコープ外）
- **検証方法**: `.opus` を開く → タスクパネルが 100% / 全「完了」で閉じる。自動配置("place") /
  画像スキャン("scan") も完了時 100% 到達。通常読込("load") / PSD 保存("save") はリグレッション無し。
  `npm run check` 緑。
- **備考 / 再発防止**: 同じ欠落で通常の自動配置・画像スキャン完了時もフェーズキャップ止まりだったのを
  同時に解消。タスクパネル系 variant を増やす際は `completeOpusProgress` の最終化分岐に必ず含める。

### [BUG-SEED-04] プロジェクト(.opus)再オープンで手動ルビが消失する

- **関連バージョン**: v2.2.3（およびマージモード化の経緯）
- **症状**: PsDesign 内で per-char ルビを振ってプロジェクトを保存・再オープンすると、ルビが消える。
- **再現手順**: 1. テキストにルビを手動付与 2. `.opus` 保存 3. 閉じて再オープン → ルビが無い。
- **根本原因**: `applyProjectSnapshot` が `state.txtSource` 復元時に `txtSourceListeners` を発火し、
  登録済みの `auto-place.js syncPlacedFromTxt` 等が走って、TXT 注記由来の**空 charRubies で手動
  ルビを上書き**していた。
- **対策**: `applyProjectSnapshot(snapshot, { silentTxtListener: true })` で復元時の listener 発火を
  抑制。`syncPlacedFromTxt` 側も TXT 注記と手動ルビを **char index 単位でマージ**（手動ルビ保持）。
  復元後は listener 経由でなく `renderTxtSourceViewer / renderAllSpreads / rebuildLayerList` を
  明示呼び出しして UI 同期。
- **影響ファイル**: `src/state.js`(`applyProjectSnapshot`), `src/services/project.js`,
  `src/auto-place.js`(`syncPlacedFromTxt`)
- **関連 RDD 要件**: REQ-G8.1 / REQ-G8.2 / REQ-G2.2
- **検証方法**: per-char ルビを振る → 保存 → 再オープン → ルビ保持を目視。
- **備考 / 再発防止**: 復元系で listener を一律発火させると、空データでの上書き事故が起きやすい。
  「復元は silent + 明示再描画」を原則にする。

### [BUG-SEED-03] 本文の前方編集で per-char 属性が別の文字へズレる

- **症状**: ある文字に per-char 属性（サイズ/フォント/太字 等）を付けた後、その文字より前を
  編集すると、属性が意図しない文字に付いてしまう。
- **再現手順**: 1. 5 文字目を太字にする 2. 1 文字目付近に文字を挿入 3. 太字が別の文字へ移る。
- **根本原因**: in-place 編集の `onInput` で、新規追加した per-char マップ（例: `charBolds`）に
  `shiftCharMap` を**掛け忘れ**ていた。本文編集で index がずれても当該マップだけ再 index されず、
  他マップと index が食い違った。
- **対策**: `onInput` で `computeStringDiff` の `(pos, deleted, inserted)` を**全 per-char / per-line
  マップへ同一適用**するよう統一（`shiftCharMap` / `shiftLineMap`）。
- **影響ファイル**: `src/canvas-tools.js`（in-place 編集 `onInput`）
- **関連 RDD 要件**: REQ-G3.3
- **検証方法**: 各属性を付けた文字より前を編集し、属性が正しい文字に残ることを目視。
- **備考 / 再発防止**: **新しい per-char 属性を追加したら、必ず `shiftCharMap` 対象に加える。**
  これは最頻出の見落としポイント。

### [BUG-SEED-02] `ruby-text`（rt）が本文に混入し per-char 属性が崩壊する

- **関連バージョン**: v1.27.0
- **症状**: ルビを振った直後に本文を編集すると、per-char 属性が大きく崩れる / ルビが壊れる。
- **再現手順**: 1. 親文字にルビを付与 2. 本文を 1 文字編集 3. 属性が総崩れ。
- **根本原因**: in-place 編集の本文取得（`readContents`）が `.ruby-text`（ふりがな rt）ノードの
  文字も含めて返していたため、`computeStringDiff` が巨大な差分を誤検出し、`shiftCharMap` の
  index 計算が破綻していた。
- **対策**: `serializeEditableText`（`readContents`）の DOM 走査で `.ruby-text`
  （`contenteditable="false"`）と ZWSP を `FILTER_REJECT` / スキップし、本文 = state.contents の
  1:1 一致を保証。
- **影響ファイル**: `src/canvas-tools.js`（`serializeEditableText` / `readContents`）
- **関連 RDD 要件**: REQ-G3.1
- **検証方法**: ルビ付与後に本文を編集しても属性・ルビが崩れないことを目視。
- **備考 / 再発防止**: DOM ↔ state.contents の 1:1 対応が崩れると下流（diff / shift）が全滅する。
  装飾用 DOM（rt / アンカー ZWSP）は本文シリアライズから必ず除外する。

### [BUG-SEED-01] 編集モードを抜けるとルビが消える

- **関連バージョン**: v1.27.0 / v2.2.3
- **症状**: ルビを振った後、in-place 編集モードを抜けると、ふりがな（rt）が画面から消える。
- **再現手順**: 1. 文字を選択しルビ適用 2. 編集モード終了 3. ルビが描画されない。
- **根本原因**: ① `renderInnerText` が `appendLineWithTracking` を 2 経路（per-line `lineLeadings`
  あり / なし）で呼ぶうち、**lineLeadings 無し経路に `charRubies` 引数を渡し忘れ**ていた
  （行間 override が無い大多数のレイヤーで発症）。② 編集中プレビューが `::after` 疑似要素方式で、
  contenteditable の caret 操作に対して脆かった。
- **対策**: ① `appendLineWithTracking` の**全呼び出しに `charRubies` を渡す**。② 編集中・非編集とも
  本番の実 DOM 構造 `<span class="ruby-wrap"><span class="ruby-base">親</span><span class="ruby-text">rt</span></span>`
  に統一し、rt に `contenteditable="false"` を付与。
- **影響ファイル**: `src/canvas-tools.js`（`renderInnerText` / `appendLineWithTracking` /
  `appendRubySegment` / `applyEditModeRubyToRange`）, `src/styles.css`
- **関連 RDD 要件**: REQ-G4.1 / REQ-G3.1 / REQ-G5.1
- **検証方法**: 複数行にルビ → 編集モード終了 → ルビが残ることを目視。
- **備考 / 再発防止**: 「同じレンダリングを複数経路で呼ぶ」関数は、引数追加時に**全経路へ反映**する。
  REQ-G4.1 の grep 確認をルーチン化する。
