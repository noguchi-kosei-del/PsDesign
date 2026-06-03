# v2.3.0 追加修正データ — 写植再利用モード（今回分のみ）

> 本ファイルは **今回のセッションで追加・修正した部分だけ** をまとめた変更データ。
> 全体の経緯・既存仕様は [CLAUDE.md](CLAUDE.md)（v2.3.0 セクション）、要件は [RDD.md](RDD.md)（G12）、
> バグ事例は [DEBUG.md](DEBUG.md)（BUG-20260601-0x）を参照。

- **バージョン**: 2.2.5 → **2.3.0**
- **新規ファイル**: `src/services/reuse.js`、`CHANGES_v2.3.0_写植再利用.md`（本ファイル）、
  デスクトップ `写植再利用_仕組みまとめ.md`（ユーザー向け解説）
- **主目的**: 「文字入り PSD を読み込み、文字を剥がして同位置・同内容で“編集できるテキスト”として作り直す」
  写植再利用モードの新設と、その付随修正。

---

## 1. 写植再利用モード（新機能）

- ホーム「写植再利用」カード → `startHomeReuseFlow`（`src/main.js`）→ `loadPsdFilesForReuse`（`src/services/reuse.js`）。
- Photoshop で各 PSD から **見本画像（文字入り）/ 原稿背景（文字を全非表示にした絵だけ）/ 文字情報** を取得。
- 原稿ペイン = 絵だけ背景 ＋ **同座標で再生成した編集テキスト**。見本ペイン = 元の完成品。
- 保存時は元テキストレイヤーを全非表示にし、再生成テキストを写植し直す（`reuseHideOriginalText` / `hideLayerIds`）。

## 2. Photoshop 一括・バックグラウンド読み取り

- `read_text_layers_batch`（`src-tauri/src/photoshop.rs` / `lib.rs read_psd_text_layers_batch` /
  `jsx_gen.rs generate_read_text_layers_batch_script`）で **1 セッションで全 PSD を処理**。
- 起動直後 **25ms 間隔の高速隠蔽ループ**で前面フラッシュ防止。完了後は **`SW_SHOWMINNOACTIVE`（タスクバー最小化）**で
  前面に出さず、別途使えるように戻す。失敗時は従来の per-file 読み取りに自動フォールバック。

## 3. フォント・サイズ「再現 / 選んで統一」

- 開始時に `confirmDialog`（元を再現 / 選んで統一）。「選んで統一」は `pickReuseFontSize`（`src/ui-feedback.js`）で
  フォント・サイズを選び、`unifyFont` / `unifySize` で全テキストを統一（位置は元のまま）。

## 4. 再生成テキストの中心合わせ（位置ズレ修正）

- **UI**: `layerRectForNew`（`src/canvas-tools.js`）が実テキスト寸法 `textLongPx` / `textThickPx` を返し、
  `alignReuseLayersToSourceCenters(targets, pages)` が実テキスト中心を元レイヤー中心に合わせる（決定論的・全ページ）。
  DOM 測定（`uiTextBasisRectForBox`）は枠を測るため不採用。
- **保存**: 各レイヤーに `reuseSrcCx/Cy`（元中心）を持たせ（reuse.js → exportEdits → `lib.rs NewLayer.reuse_src_cx/cy` →
  jsx_gen emit）、位置補正で **実 bounds 中心を元中心へ合わせる**。UI 推定・CSS/PS のジオメトリ差に依存せず元位置を厳密再現。

## 5. 左余白（右ずれ）対策

- `reuseTightThick` フラグで `layerRectForNew` の厚み安全余白を 0 にし、**枠を実テキスト列幅ぴったりに詰める**。
- 詰め枠 box に `layer-box-reuse-tight` を付け、`scheduleBoxAutoFit`（はみ出し検知で枠を右へ広げる処理）から**除外**。
  これでページ移動の再描画ごとに右へずれる現象を解消（白フチのにじみ誤検知が原因）。

## 6. 縦中横（!! / !? / ‼ / ⁉）の保存反映修正

`src-tauri/src/jsx_gen.rs`:
- `normalizeFullWidthToHalfTcy` を全角 2 連 `！！/！？/？！/？？` ＋ **単一合成文字 `‼ ⁇ ⁈ ⁉` → 半角 2 文字** に拡張。
  検出も `?` 始まりペア対応。
- 半角化は **新規レイヤー作成直後（フォント適用前）に 1 回**だけ実施し、`applyTateChuYoko` 内の contents 再代入による
  書式破壊を回避。
- `reapplyTateChuYokoForAllLayers` を新設し **Phase B の最後**（autoKerning flatten 後・記号フォント/manual spacing 再適用の後）で
  cross を再適用。

## 7. 白フチ / 中丸ゴシック自動判定の流用

- `extractTextLayersToNewLayers`（reuse.js）が「絵だけ背景」を `analyze_image_text_regions` に渡し、
  `computeAutoStyleFromMetrics` で通常写植と同じ「白フチ自動付与（白率 < 0.7）」「中丸ゴシック自動切替（スコア ≥ 0.5）」を適用。

## 8. 起動スプラッシュが閉じない問題の修正

- `src/main.js` の `init()` を **try/finally** で囲み、成功・失敗いずれも finally で `closeStartupSplash()` を必ず実行。
- 一時診断 `__reuseDiag3`（起動時に固定 PSD 自動ロード）を撤去。
- 開発運用注意: `npm run tauri dev` 実行中に別ターミナルで `cargo`/`cargo check` を併走させると **ビルドロック競合**で
  cargo が固着し、再起動のたびにスプラッシュが出続ける。dev 中は cargo を併走させない。

---

## 変更ファイル一覧（今回分）

| 区分 | ファイル | 主な変更 |
|---|---|---|
| 新規 | `src/services/reuse.js` | 写植再利用フロー本体 |
| フロント | `src/psd-loader.js` | `buildReusePageFromPsData` / `loadPsdForReuse` |
| フロント | `src/canvas-tools.js` | `layerRectForNew`(textLongPx/textThickPx, reuseTightThick) / `alignReuseLayersToSourceCenters` / autofit 除外 |
| フロント | `src/main.js` | `startHomeReuseFlow`(フォント選択) / `init` try/finally / 診断撤去 |
| フロント | `src/ui-feedback.js` | `pickReuseFontSize` |
| フロント | `src/state.js` | reuseInfo / reuseHideOriginalText / appMode "reuse" |
| Rust | `src-tauri/src/photoshop.rs` | `read_text_layers_batch` / 25ms 隠蔽 / 最小化復帰 |
| Rust | `src-tauri/src/lib.rs` | `read_psd_text_layers_batch` / `NewLayer.reuse_src_cx/cy` |
| Rust | `src-tauri/src/jsx_gen.rs` | batch script / 位置補正(reuseSrcCx/Cy) / 縦中横(Phase B・変換拡張) / hideAllTextLayers |
| 文書 | `CLAUDE.md` / `RDD.md` / `DEBUG.md` | v2.3.0・G12・BUG-20260601-0x 追記 |
| バージョン | `package.json` / `package-lock.json` / `Cargo.toml` / `Cargo.lock` / `tauri.conf.json` | 2.3.0 |

## 検証

- `npm run check`（encoding + lint + build）緑、`cargo check` 緑。
- 実機推奨: 写植再利用を開く →（フォント再現/統一）→ 原稿に編集テキストが同位置で出る → ページ切替で右ずれしない →
  保存で元位置に重なり、`!! / !?` が縦中横になる → Photoshop は前面に出ずタスクバーから使える。
