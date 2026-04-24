# PsDesign

PSD（Photoshop Document）のテキストレイヤーを一覧編集し、変更を Photoshop 経由で実ファイルに書き戻す Tauri v2 アプリ。フォルダ単位で複数 PSD をまとめて扱い、TXT 原稿からのワンクリック縦書き配置をサポートする。

## スタック

- **フロントエンド**: Vanilla JS (ES modules) + Vite 5
- **バックエンド**: Rust + Tauri 2 (`tauri-plugin-dialog`, `ag-psd` for reading)
- **Photoshop 連携**: ExtendScript (JSX) を Rust から spawn し、センチネルファイルで完了を同期

## 開発・起動

```bash
cd ver_1.0
npm install
npm run tauri dev      # アプリ起動（localhost:1430 / HMR:1431）
npm run build          # フロントエンドビルド（動作確認に有用）
```

複数 Tauri アプリを同時並行開発できるよう **ポートを 1430** に設定（Vite と `tauri.conf.json` の `devUrl` を揃える）。

## ディレクトリ構成

```
ver_1.0/
├── index.html                # メイン HTML（カスタムタイトルバー + ツールバー + 縦ページバー + サイドパネル）
├── src/
│   ├── main.js               # 初期化、ツールバー/ショートカット束ね、ウインドウコントロール、Tauri drag-drop listener、ズーム配線、保存ドロップダウン（`bindSaveMenu`）
│   ├── state.js              # アプリ状態とリスナー（tool, textSize, currentFontPostScriptName, zoom, currentPageIndex, selectedLayers 配列, txt…）
│   ├── psd-loader.js         # ag-psd で PSD をパースして textLayers + dpi を取り出す
│   ├── spread-view.js        # キャンバス描画（DPR 対応の高品質ダウンサンプル、zoom 反映、pageRedraws 管理）
│   ├── canvas-tools.js       # オーバーレイ/選択/ドラッグ/テキスト配置/パン/T ツールの in-place 編集 + V ツールのマーキー選択・多レイヤー同時ドラッグ
│   ├── pagebar.js            # 縦ページバー（MojiQ 風カプセル型ハンドル + グリップ、>>トグルで折畳）
│   ├── text-editor.js        # 右パネルのレイヤーリスト & エディタ（多選択対応・フォント検索コンボボックス・組方向トグル）
│   ├── txt-source.js         # 原稿 TXT の読込・段落ブロック選択・ページマーカー解析・自動送り
│   ├── pdf-loader.js         # `pdfjs-dist` 初期化、ファイルピッカー、read_binary_file → getDocument + ticker 方式プログレス
│   ├── pdf-view.js           # 左ペインの PDF 描画（ページ/ズーム同期・ResizeObserver・renderToken レース対策・回転対応・`.page` ラベル付き）
│   ├── font-loader.js        # フリーフォントを `FontFace` API で WebView に直接登録（Rust 側パスから bytes → ArrayBuffer）
│   ├── hamburger-menu.js     # 左スライドインメニュー（テーマ切替 / ワークスペース左右反転 / ホームに戻る）
│   ├── ui-feedback.js        # 中央プログレスモーダル + 右上トースト + `confirmDialog`（カスタム確認）
│   └── styles.css            # ライト/ダーク両対応、スクロールバーも theme 追従
└── src-tauri/
    ├── capabilities/default.json # core:window:* / dialog:default 権限
    ├── tauri.conf.json           # decorations: false, dragDropEnabled: true, devUrl 1430
    └── src/
        ├── lib.rs            # tauri コマンド宣言 (list_psd_files, read_binary_file, list_fonts, apply_edits_via_photoshop)
        ├── fonts.rs          # インストール済みフォント列挙
        ├── photoshop.rs      # PS 起動 + センチネルポーリングで完了検知
        └── jsx_gen.rs        # 編集内容から ExtendScript を生成（改行 \n → \r、autoLeadingAmount=125 他）
```

## 最近の変更（このセッション）

A. **PSD 表示回転（Photoshop 風ビュー回転）**: `state.psdRotation`（0/90/180/270）と `setPsdRotation`/`onPsdRotationChange` を PDF 側とミラー実装。`#psd-rotate-btn`（PDF と同じ矢印 SVG、hidden 属性で PSD 未読込時は非表示）を `.spreads-psd-area` 直下に配置し、`.psd-rotate-btn` / `.pdf-rotate-btn` は同一スタイル（右上 28px バブル）を共有。`spread-view.js` の各ページ `redraw()` 内で `rotated90 = rotation===90||270` を判定し、`.page` のサイズを「回転後の可視 bbox」に、`.canvas-wrap` を `position:absolute; left:50%; top:50%; transform: translate(-50%,-50%) rotate(Ndeg)` で絶対中央配置して回転させる（canvas と overlay が一体として回るため PSD 座標系はそのまま保持）。`canvasCoordsFromEvent` は `getBoundingClientRect()` の W/H を回転時スワップし、中心起点の `dxS/dyS` を `inverseRotateDelta` で逆回転してローカル座標に戻す閉じ式で書き直し。`beginMultiLayerDrag` も同様に `W/H` を入替え、ドラッグ中のスクリーン delta を `inverseRotateDelta` で PSD 空間に変換してから `scaleX/scaleY` を適用する。`.page-overlay` の全ての percentage-based 配置（レイヤー枠・マーキー・テキスト入力 floater）は変更不要で、回転中も PSD 座標系上でそのまま動く。回転角はセッション中保持（PDF と同方針）、ハンバーガーメニュー「ホームに戻る」で `setPsdRotation(0)` を追加して PDF と一緒にリセット。

B. **V ツールで方向キーによるレイヤー位置ナッジ**: V ツール選択中 + テキストレイヤー選択があるとき、`←↑→↓` で 1 PSD px ずつ、`Shift+方向キー` で 10 px ずつレイヤーを移動。`canvas-tools.js` の `nudgeSelectedLayers(dx, dy)` を新規追加し、既存レイヤーは `addEditOffset` で dx/dy を累積、新規レイヤーは `updateNewLayer` で x/y を更新（複数選択は全員同じ delta で同時移動）。`main.js` のキーハンドラで V ツール時かつナッジ成功時のみ preventDefault し、それ以外のときは従来どおり `←/→` でページ切替（`↑/↓` は未使用）。

C. **V ツールで wheel によるサイズ可変（中心起点）**: V ツール選択中、選択済みレイヤー枠の上で wheel スクロールすると 1pt/ノッチ、`Shift+wheel` で 10pt/ノッチでサイズ増減（6〜999 pt にクランプ）。`canvas-tools.js` の `resizeSelectedLayers(deltaPt)` を新規追加。サイズ変更時は旧 rect と新 rect の幅・高さ差の半分だけ x/y（既存レイヤーは dx/dy）を逆方向にシフトして**中心を固定**する挙動（`layerRectForNew` / `layerRectForExisting` を新旧 sizePt で 2 回呼び差分を算出）。`onLayerWheel(e, ctx, layerId)` を `.layer-box` に `{passive:false}` で登録し、Alt+wheel はズーム、Ctrl/Meta+wheel はブラウザ既定に委譲。`rebuildLayerList` 経由で単独選択時は size-input が自動追従。

D. **縦書きツール時のポインター形状**: `text-v` ツール時は CSS `cursor: vertical-text`（横向き I ビーム）、`text-h` は従来どおり `cursor: text`。`applyToolAttrs` と `.page-overlay[data-tool="text-v"] .layer-box` の双方で設定。

E. **選択中レイヤー枠の強調を box-shadow 方式に**: 従来 `.layer-box.selected { border: 1.5px }` で強調していたが、3px に太くするとテキスト要素（100% サイズ配置）が content area 狭まりで右下にずれる問題が発覚。border は 1px 固定のまま `box-shadow: 0 0 0 2px var(--accent)` の外側リングで太さを演出する方式に変更し、レイアウトに影響しないようにした。

F. **ペイン分離スクロールと `#psd-stage` 追加で回転ボタンを固定**: ズーム拡大時に `#spreads-container` がスクロールし、`.spreads-psd-area` 内の `position:absolute` 回転ボタンもコンテンツと一緒にスクロールして右上からずれる問題があった。構造を PDF 側（`.spreads-pdf-area > #pdf-stage`）と揃え、PSD 側も `.spreads-psd-area > #psd-stage` に再編。`.spreads-pdf-area` / `.spreads-psd-area` は `overflow: hidden` にして回転ボタンの絶対配置基準（padding box）だけを提供し、スクロールは内側の `#psd-stage` / `#pdf-stage` に閉じる（ともに `overflow: auto`）。`spread-view.js` の `container()` は `#psd-stage` を返すように変更。パンツールは `ctx.canvas.closest(".psd-stage")` をスクロールターゲットに切替え、`panState.scroller` に参照を保持。`.pdf-canvas` の `max-width: 100%; max-height: 100%` は**異なる軸の親サイズを参照するためズーム時にアスペクト比が崩れる原因**となり削除（`#pdf-stage` の overflow:auto でスクロール対応）。

G. **Space 押下時のフォーカス解除**: 直前にクリックした回転/ツールボタンにフォーカスが残っていると、Space の既定動作（button/link の activate）で再発火してしまうため、Space keydown 入口で `document.activeElement` が `<button>` / `<a>` なら `blur()` を呼んでフォーカスを外してからパン切替に入るようにした。

H. **Alt 単独押下のシステムメニュー活性化を無効化**: Alt+wheel でズームした後に Alt を離すと、Windows の「Alt 単独の押下・離上でメニューバー／システムメニューを活性化」挙動が走り、次の Space でシステムメニュー（最小化/閉じる等）が左上に出る事故があった。Alt キーの keydown/keyup 両方に `preventDefault` する共通ハンドラ（`suppressAltMenuActivation`）を `bindTools` 内で登録して抑止。Alt+wheel のズーム自体は `wheel.altKey` が別イベントを見ているので影響なし、Alt+F4 等の OS ショートカットは OS 側で処理されるため無影響。

0. **PDF 並列ビューアー（spreads-stage 分割版）**: PSD キャンバス領域を `.spreads-stage` の flex row で **左 PDF / 右 PSD** に 50/50 分割する構造に再設計。以前の `.workspace` グリッドに PDF 列を足す案は廃止し、`.spreads-stage > .spreads-pdf-area + .spreads-psd-area` 構造に変更。`.workspace.flipped` 時は `flex-direction: row-reverse` で左右自動入替。PDF 未読込時も PDF エリアは表示され、空状態（「PDF を開く、またはここにドロップしてください」）にツールバーと同じ **PDF ラベル入りファイルアイコン**を表示。ツールバーに `#open-pdf-btn` 追加（PDF → PSD → テキスト → 保存 の並び）。D&D で `.pdf` は `loadPdfByPath` に振り分け、複数同時ドロップ時は先頭のみ採用。pdfjs-dist v4.x を採用し、worker は `public/pdfjs/pdf.worker.min.mjs` に postinstall で自動コピー（`.gitignore` 対象）。`spread-view.js` の render 先は `#spreads-psd-area` に変更、`pdf-view.js` は `#spreads-pdf-area` を root として `.page .pdf-page` div 内に canvas と `.page-label`（`#<n>  <basename>`）を持つ。
1. **PDF のページ/ズーム/回転同期と耐障害性**: ページは `onPageIndexChange` 購読で PSD に 1:1 対応（PDF が短い場合は「PDF にこのページはありません (N/M)」空状態）。ズームは `onZoomChange` 購読で PSD と同比率。連続ページ送りで `page.render` が重なっても `renderToken` で古い結果は破棄。PDF の intrinsic `rotate` に加え `state.pdfRotation` を合算して `page.getViewport({ rotation })` に渡す。PDF エリア右上に回転ボタン（90° CW 循環）を配置し、逆さま PDF 対応。
2. **PDF 読込のプログレスバー（ticker 方式）**: `pdf-loader.loadPdfByPath` は 30ms 間隔のティッカーで `current` を `target` に追従させ（残距離 18% ずつ）、`0 → 40 → 70/90 → 95 → 100` と段階的に可視進捗を出す（PSD と同じ `${current} / ${total}` 表示）。`task.onProgress` は届けば 40–90 帯を上書き。ディスク読込 / PDF 解析 / 先頭ページ先読み の 3 段階で `detail` も更新。完了時の「読み込みました」トーストは不要との要望で削除、エラー時のみトースト表示。
3. **PDF と PSD の独立性**: `clearPages` 内の `clearPdf()` 呼び出しを削除し、PSD 再読込しても PDF はリセットされない仕様に（同じワークフローで次々と PSD を開ける）。`setPdf` 内の `pdfRotation` リセットも削除（ユーザーが合わせた回転角は別 PDF を開いても保持、同ロット向きが統一されている現場で便利）。代わりに `hamburger-menu` の「ホームに戻る」で明示的に `clearPdf()` と `setPdfRotation(0)` を呼び、ダイアログ文言も「psd、テキスト、PDFがリセットされます」に更新。
4. **フォントを FontFace API で WebView に直接登録**: OS インストール済みだが WebView2 が family 名解決できないフリーフォントでも描画できるよう、`fonts.rs` の `FontEntry` に `path: Option<String>` を追加し、`extract_fonts` でファイルパスを埋め込み。旧キャッシュ（path 無し）は `read_cache` が自動破棄して再ビルド。`font-loader.js` は `ensureFontLoaded(ps)` で `read_binary_file` を叩いて bytes を取得し、**family 名と PS 名の両方**で `new FontFace(name, buffer, { display: "swap" })` を登録（`FontFace` は buffer を消費する仕様のため `makeBuffer()` で名前ごとにコピー）。同時ロードはセマフォで **最大 3 並列**。新規登録時は 80ms デバウンス通知で `refreshAllOverlays` を発火。
5. **フォントコンボを実フォントで表示 + IntersectionObserver で軽量化**: サイドバーのフォント検索ドロップダウンで、各項目名を**そのフォント自身**の書体で描画（`main.style.fontFamily = "Family", "PS", sans-serif`）。全 500+ 項目に一気に適用すると WebView が重くなるため、`IntersectionObserver(root: list, rootMargin: 80px)` で**可視範囲に入った項目だけ** `fontFamily` 設定 + `ensureFontLoaded` 呼び出し、一度スタイル適用した項目は `unobserve`。hover/click 時も `ensureFontLoaded` を呼び確実に読み込む。
6. **テキスト入力系のフォーカス抜け自動化**: `commitFont` 完了時に `fontEl().blur()` を呼び、フォントコンボ選択後に Space でパンツールを切り替えた際に文字が入力欄に入る事故を防止。さらに `main.js` の `bindGlobalBlurOnOutsideClick` でキャプチャ `mousedown` を監視し、テキスト入力系（INPUT text/number/search、TEXTAREA、contenteditable）がアクティブかつクリック先が別の入力欄・`.font-combobox`・`.save-menu`・`.text-input-floater` 外であれば `blur()`。ボタン（type=button/submit）やチェックボックスは対象外（Space で文字入力しないため）。
7. **テキストツール配置時の中央揃え**: `canvas-tools.js` に `centerTopLeft(page, {contents, sizePt, direction}, clickX, clickY)` ヘルパーを追加。`layerRectForNew` で矩形サイズを事前計算し、クリック座標が中央になるように top-left を返す。`placeTxtSelectionAt`（原稿テキスト配置）と `startTextInput` の `onCommit`（手入力確定時）でこのヘルパーを使用。既存レイヤーの in-place 編集は位置維持。
8. **レイアウト微調整**:
   - `.side-panel` の列幅を `320px → 280px` に縮小（グリッド 4 箇所）。
   - サイドパネルの h2/h3 を `font-weight: 600 → 800`、`color: --text-muted → --text`、`font-size: 12 → 13px` で強調。
   - ウィンドウ最小幅を `1300px` に設定（`tauri.conf.json`：初期 1360 / minWidth 1300）。
9. **UI 表記**: ユーザーに見える「TXT」をすべて**「テキスト」**に置換（ツールバーボタン title、サイドパネル見出し「原稿テキスト」、空状態メッセージ、クリア確認、トースト）。
10. **ヘッダーのボタン順入替**: 「PDF を開く」を「PSD を開く」の前に。最終順は `PDF → PSD → テキスト → 保存ドロップダウン`。
11. **pdfjs worker の gitignore**: `public/pdfjs/` は `postinstall` で `node_modules/pdfjs-dist/build/` からコピーされる自動生成物のため `.gitignore` に追加。`npm install` するだけで再生成される。

> **Before/After 構造要約**:
> - 旧: `.workspace` = `1fr auto 44px 320px`（5 col で PDF を横列として追加する案もあったが没）
> - 新: `.workspace` = `1fr auto 44px 280px`（以前のまま）。PDF は **`.spreads-stage` 内部**で `.spreads-pdf-area` と `.spreads-psd-area` の flex row 分割として表示。

1. **読み込みをファイルベースに変更**: 「PSD を開く」はフォルダ選択ではなく **`.psd` の複数ファイル選択**ダイアログへ変更。`pickPsdFiles` → `loadPsdFilesByPaths`。D&D はファイル・フォルダ両対応（フォルダは内部で `list_psd_files` に展開）。
2. **文字色スウォッチをサイドツールバーへ移動**: 編集パネルの `既定/白/黒` セグメントを廃止し、サイドツールバー下部に Photoshop 風のオーバーラップ 2 スウォッチ（白左上 / 黒右下）を `margin-top: auto` で配置。アクティブ中の色を再クリックで `default` にトグル off。
3. **フチ色を 3 つの丸サムネに**: `なし / 白 / 黒` のテキストトグルを 20 px 径の丸スウォッチへ刷新（なし は白地 + 赤い斜線）。アクティブは青リング。
4. **フチ太さに ± ボタン**: `[−] [input] px [＋]` レイアウト。0.5 px ステップ。初期値 **20 px** に変更（旧 2 px）。
5. **サイズ / 太さの入力上限を 3 桁に**: どちらも `max=999`、`setTextSize` / `setStrokeWidthPx` のクランプも 999 に合わせ、`.size-input` は `56px → 44px` に縮小。
6. **組方向トグルをアイコン化**: `縦` / `横` のテキストボタンを、サイドツールバーの T（縦書き）/ Y（横書き）ツールと同じ SVG アイコン（T + 矢印）に置換。
7. **フチ行の要素順を入替**: 太さ（`[−] input px [＋]`）を左、色ドット 3 つを右へ（`.size-row` の `justify-content: space-between` で自動整列）。「太さ」ラベルも撤廃。
8. **D&D ビジュアルフィードバック**: 全画面固定の `#drag-overlay` を追加し、Tauri の `drag-enter` / `drag-over` / `drag-leave` / `drag-drop` 4 イベントで青枠パルス（`drag-overlay-pulse`、1.2s ループ）＋ 投下時フラッシュ（`drag-overlay-flash`、0.35s）を再生。

（詳細は下の各セクション、および `4c`・`4d`・`10. UI` を参照）

## 主要機能

### 1. PSD 読み込みと縦書き配置
- 「PSD を開く」で **.psd ファイルを複数選択**して読み込み、**1 画面 1 ページ** 表示（`pickPsdFiles` が Tauri `plugin-dialog` の `open({ multiple: true, filters: [.psd] })` を呼ぶ → `loadPsdFilesByPaths(paths)` が順次 `loadPsdFromPath` → `addPage`）。
- PSD ファイル / TXT / フォルダはウィンドウのどこへでも **ドラッグ&ドロップ可**。Tauri v2 の `dragDropEnabled: true` と `tauri://drag-drop` イベントで絶対パスを取得、拡張子で振り分け：`.psd` → そのまま取り込み、`.txt` → `loadTxtFromPath`、拡張子なし（フォルダ想定）→ Rust `list_psd_files` で中身の .psd を展開して取り込む（フォルダ D&D の利便性を維持）。
- 右パネルは **現在表示中ページのテキストレイヤーのみ** をリスト。
- キャンバス左の **縦ページバー** のハンドルをドラッグ / ←/→ キーでページ切替。`Ctrl+J` でページ番号入力ダイアログ（カスタムモーダル）。`Ctrl+←/→` で先頭 / 末尾ページ。

### 2. 原稿 TXT からのワンクリック配置
- 右サイドパネル上段の「原稿 TXT」にドロップ or ツールバーの TXT ボタンで読込（UTF-8 / Shift_JIS 自動判別）。
- **空行で段落分割**。各段落内の改行は保持され、1 ブロック＝ 1 段落として扱う。
- **`<<数字Page>>` ページマーカー**（例 `<<1Page>>`、半角/全角数字、大小文字許容）。マーカーで区切られたテキスト群が該当ページに紐付き、`txt-source-viewer` には**現在表示中ページの段落のみ** を表示。ページ切替（←/→、ページバー等）に連動して viewer が更新される。マーカー自体は出力に含まれない。
- **テキストツール（T）** 選択中にキャンバスをクリック → その段落が改行付きの **縦書きテキストレイヤー**（黒字）として配置。配置後は **自動で次段落へ選択が移動** し連続配置できる。末尾では選択解除。
- **行送り 125%**（Photoshop のジャスティフィケーション自動行送り同等）でオーバーレイも Photoshop も統一。
- **選択ツール（V）** では配置できない（配置＝ T 専用）。

### 3. ツール別役割の明確化
- **V（選択ツール）**:
  - 既存／新規テキストレイヤーのクリック選択＋ドラッグ移動。未選択レイヤーをクリックすると選択を置換し、既に選択中のレイヤーをドラッグすると**選択中の全レイヤーを同じデルタで同時移動**（`beginMultiLayerDrag`）。
  - **空キャンバスをドラッグで矩形（マーキー）選択**：`startMarquee` → `layerRectForExisting` / `layerRectForNew` と `rectsIntersect` で交差判定し、該当レイヤーを一括選択。`.marquee-rect` の破線矩形がオーバーレイに描画される。
  - **Shift 修飾キー**：Shift+マーキーは既存選択に加算、Shift+レイヤークリックは選択トグル。
  - 空クリック（ドラッグ距離ほぼゼロ）で選択解除（Shift 付きなら維持）。
- **T（縦書きツール） / Y（横書きツール）**: テキスト配置ツールは縦書き・横書きの 2 種類。tool 値は `"text-v"` / `"text-h"`。ヘルパ `isTextTool(tool)` / `textToolDirection(tool)` で分岐。
  - 原稿 TXT ブロック選択中 → キャンバスクリックで段落配置 + 次段落自動選択。配置 direction は現在のツールに従う（縦書きツールなら `"vertical"`、横書きツールなら `"horizontal"`）。
  - ブロック未選択 → 手入力 textarea を開き、**Enter で改行 / Ctrl+Enter で確定 / Esc で破棄 / 外クリックで確定**。textarea の `writing-mode` とプレースホルダー文言もツールに連動。確定後は**選択解除**（次クリックで新規 textarea を開ける）。
  - **入力中に他の空所クリック**：既存 `.text-input-floater` を検出したら `__finalize(true)` で確定するだけ・新規 textarea は開かない。もう一度クリックすると新規入力できる。
  - **既存 / 新規レイヤーをクリックすると in-place 編集**：`startInPlaceEdit` が現テキスト初期値の textarea をレイヤー位置に開く。既存レイヤーは `setEdit({contents})`、新規は `updateNewLayer({contents})` でコミット。direction はレイヤー自身のものを維持（ツールに依らない）。
  - CSS `.page-overlay[data-tool="text-v"] .layer-box`・`.page-overlay[data-tool="text-h"] .layer-box` は `pointer-events: auto`（クリックを受ける）、`cursor: text`。
- **パン（手のひら）ツール**: **MojiQ 流**のパン実装。canvas 自身に `mousedown/mousemove/mouseup` を常設リスナーで張り、毎イベントで `preventDefault + stopPropagation` を呼び親要素へのバブリングを抑止。左クリック（`e.button === 0`）以外は無視。`#spreads-container` の scrollLeft/Top を直接書換、ズーム非依存。カーソルは `grab`/`grabbing`。`window` の mouseup / blur をセーフティネットに `endPan()`。
  - **Space キー押下中のみ一時切替**（MojiQ 互換）。Space keydown は `!e.repeat` ではなく**毎回（リピート含む）`preventDefault`** を呼び、ブラウザ既定の「Space で 1 画面分下スクロール」を完全に抑止。初回のみ `panPreviousTool` を記憶 → `setTool("pan")`。keyup で元に戻す。`window.blur` でも復元。input/textarea 内では無効。
  - **ツールバーのアクティブ表示は Space 中でも直前ツールのまま**：`applyActive()` が `panSpaceActive && panPreviousTool ? panPreviousTool : getTool()` を参照し、Space 一時切替で V/T のハイライトが外れないようにする。

### 4. 文字サイズ編集（エディタ内 size-input）
- 右パネルのレイヤーエディタ内、フォント検索欄の下に − / size-input / pt / ＋ の行。入力欄は `.size-input`（44px 幅・右寄せ・tabular-nums）。
- **デフォルト 12pt**。ボタンは ±1pt、キーボード `[`/`]` は ±2pt（Shift で ±10pt）、size-input は直接入力で **0.1pt 単位**（`step="0.1"`、`min=6` / `max=999` → 3 桁まで受け付け）。`setTextSize` も 6〜999 にクランプ。
- `state.textSize` で「選択中レイヤーのサイズ」＋「次に配置する既定サイズ」を双方向同期。
- キャンバスの新規/既存レイヤーのプレビューは `sizePt × dpi/72 × 画面倍率` で実寸相当、複数行は 125% の行送りで計算。

### 4b. 組方向（縦／横）トグル
- サイズ入力の右に**セグメント型トグル**を配置。ラベルは SVG アイコン（サイドツールバーの T（縦書き） / Y（横書き）ボタンと同じ "T + 下／右向き矢印" のストロークアイコンを流用、`stroke="currentColor"` で active 時に白反転）。`.size-field` を `[label] → .size-row[.size-group | .direction-toggle]` 構造に再編。アクティブ側は `--accent` 塗り、ボタン間は 1px 枠線仕切り。
- 選択中レイヤーの `direction` を即時切替：`commitField("direction", "vertical" | "horizontal")` で既存は `setEdit`、新規は `updateNewLayer` に書き込み、`rebuildLayerList` + `refreshAllOverlays` が自動で走るのでオーバーレイ枠の縦横寸法（`layerRectForExisting` / `layerRectForNew`）と `writing-mode: vertical-rl` が同時更新。
- `populateEditor` 内で選択レイヤーから有効 direction を算出（既存: `edit.direction ?? layer.direction ?? "horizontal"` ／ 新規: `newLayer.direction ?? "vertical"`）→ `syncDirectionToggle(direction)` でアクティブボタンを同期。
- スコープ：トグルは「選択済みレイヤーの切替」用。新規配置 direction は「縦書き／横書きツール」の選択で決まるため、トグルは既存／新規レイヤーの事後修正専用。

### 4c. フチ効果（白／黒の境界線、Photoshop 互換）
- 編集パネルの **フチ** 行：左側に **太さ入力欄**（`[−][input] px [＋]`、`.size-input` 44px 幅、`step 0.5`、`min=0` / `max=999`、± ボタンで 0.5 px ステップ）、右側に **3 つの丸サムネ**（`.stroke-toggle > .stroke-dot.stroke-dot-none / .stroke-dot-white / .stroke-dot-black`）を `justify-content: space-between` で並列配置（文字色はサイドツールバー下部のスウォッチに分離）。各ドットは 20px 径の丸スウォッチで、`なし` は Photoshop の "No Color" 同様に白地 + 赤い斜線（`::before` 疑似要素、`overflow: hidden` + `border-radius: 50%` で円内にクリップ）、`白` / `黒` は単色塗り。アクティブ側は `box-shadow: 0 0 0 2px var(--accent)` のリングで強調。
- state モデル: `state.strokeColor` (`"none" | "white" | "black"`) と `state.strokeWidthPx`（初期値 20）をグローバルに保持し、`textSize` と同じく **選択中レイヤーの現在値**兼**次に配置する既定値**として両用。`addNewLayer` 引数に `strokeColor` / `strokeWidthPx` を追加、`clearPages` でデフォルトにリセット。
- 配置時: `placeTxtSelectionAt` / `startTextInput` 内の `addNewLayer` 呼び出しが `getStrokeColor() / getStrokeWidthPx()` を初期値として引き継ぐ。
- オーバーレイプレビュー: `canvas-tools.js` の `applyStrokePreview(inner, color, widthPx, pxPerPsd)` が `-webkit-text-stroke: Npx <color>` + `paint-order: stroke fill` を `inner.style` に設定し、outside ストロークを近似。画面倍率 `pxPerPsd` で PSD px → screen px 変換。
- Photoshop への書き戻し: `jsx_gen.rs` の `applyStrokeEffect(layerRef, {color, size})` が Action Manager で `frameFX`（境界線効果）を設定。outside / 100% / normal / solid color で固定。`color === "none"` のときは `disableStrokeEffect` で明示的に OFF。
- PSD 読み戻し: `psd-loader.js` の `extractStroke(layer)` が `layer.effects.stroke` を 3 ヘルパ（`pickActiveStrokeFx` / `readStrokeSizePx` / `readStrokeColor`）で解釈し `strokeColor` / `strokeWidthPx` を復元。配列／単体、`enabled` / legacy `visible`、size の単位違い（pt → px 換算）、color が `{r,g,b}` / `{red,green,blue}` / `[r,g,b]` / `#rrggbb` のいずれでも吸収。白/黒以外の色は `"none"` にフォールバック（本アプリは白/黒のみ対応）。
- **複数選択の一括適用**: `text-editor.js` の `commitStrokeFields(colorOrNull, widthOrNull)` が `getSelectedLayers()` をループして全レイヤーに書き込む。`null` を渡すと**そのレイヤーの現在値を保持**する仕様で、混在状態で片方だけ編集しても他方が上書きされない。色トグル押下時は `currentWidthForCommit()` が混在（input 空）を検知して `null` を返し幅保持モードに切替。
- **編集パネルの scope 分離**: `index.html` で `data-editor-scope="single"` を付けた要素（フォント / サイズ・組方向）は単独選択時のみ、それ以外（フチ）は複数選択時も表示。`populateEditor` が `selections.length !== 1` で single-only を hidden にする。`computeCommonStroke(selections)` で全選択から共通値を算出、値が揃えば表示、混在なら `null` → トグル全非アクティブ・太さ input 空 + placeholder「混在」。文字色は編集パネル外（サイドツールバー）に移動したため、`size-field` に含まれない。
- 保存時の data フロー: `exportEdits()` で既存 edit diff と新規 layer の両方が `strokeColor` / `strokeWidthPx` を保持 → Rust `LayerEdit` / `NewLayer` に serde で受け渡し → JSX 生成で `strokeColor: "..."`, `strokeWidth: N` をレイヤーオブジェクトに出力 → `applyStrokeEffect` 呼び出し。

### 4d. 文字色（白／黒、Photoshop 互換）
- **配置場所**: サイドツールバー下部（V/T/Y/パンの下、`margin-top: auto` で末尾にピン留め）に Photoshop 風の **オーバーラップ 2 スウォッチ**（`.fill-swatch-stack > .fill-swatch-white + .fill-swatch-black`）のみを配置。白スウォッチは左上、黒スウォッチは右下に重ねて表示し、アクティブ側は `box-shadow: 0 0 0 2px var(--accent)` のリングで強調。**アクティブ中のスウォッチを再クリックすると `default`（そのまま）状態に戻り**、両スウォッチとも非アクティブ表示になる。専用の「既定」ボタンは持たない。
- **常駐型コントロール**: 選択解除時も表示され、次に配置するテキストの既定文字色を直接操作できる。値は `state.fillColor` と双方向同期（選択があれば共通値を反映、無ければ最後に選んだ値を保持）。
- **`default`（そのまま）状態**は両スウォッチとも非アクティブ。書き戻し時も `ti.color` を触らない（元の色を保持）。新規レイヤーで `default` のまま配置された場合は従来通り黒を採用。専用の「既定」ボタンは持たず、アクティブ中のスウォッチを**再クリックすると `default` に戻る**トグル挙動で実現。
- state モデル: `state.fillColor` (`"default" | "white" | "black"`)。`getFillColor` / `setFillColor(color)` / `onFillColorChange(fn)` 提供。`addNewLayer` 引数に `fillColor` を追加、`clearPages` で `"default"` にリセット。
- 配置時: `placeTxtSelectionAt` / `startTextInput` 内の `addNewLayer` 呼び出しが `getFillColor()` を初期値として引き継ぐ。
- オーバーレイプレビュー: `canvas-tools.js` の `applyFillPreview(inner, fillColor)` が `white` / `black` のときだけ `inner.style.color = "#fff" / "#000"` を設定。`default` は何も触らず、編集前の見た目を保持。既存/新規レイヤー両方に適用。
- Photoshop への書き戻し: `jsx_gen.rs` の HEADER に `whiteColor()` と `fillColorFor(name)` を追加。`fillColorFor` は `"white"` / `"black"` で `SolidColor` を返し、`"default"` や未指定は `null`。
  - 既存レイヤー: `e.fillColor` が文字列かつ `fillColorFor(...)` が非 null のときのみ `ti.color = fc` を適用。失敗は `addWarning` に記録し、保存自体は続行。
  - 新規レイヤー: `nti.color` を `fillColorFor(nl.fillColor) ?? blackColor()` に設定（既定で黒を維持しつつ白も選択可能）。
- PSD 読み戻し: `psd-loader.js` の `extractFillColor(layer)` が `layer.text.style.fillColor` を解釈し `white` / `black` を分類。白黒に分類できない色は `"default"` にフォールバック（書き戻しで触らないほうが安全）。color 形状揺れ（`{r,g,b}` / `{red,green,blue}` / `[r,g,b]` / `#rrggbb`）を吸収。
- **複数選択の一括適用**: `text-editor.js` の `commitFillField(color)` が `getSelectedLayers()` をループして全レイヤーに書き込む。フチの `commitStrokeFields` と違って単一フィールドのみなので保持モードは不要。`computeCommonFill(selections)` で共通値を算出、混在なら `null` → 両スウォッチ全非アクティブ。
- **UI 同期**: `syncFillToggle(color)` が 2 スウォッチの `.active` を付け替え（`"default"` / `null` はどちらも両方非アクティブ表示）。`bindEditorEvents` で `syncFillToggle(getFillColor())` を初期呼び出しし、さらに `onFillColorChange(syncFillToggle)` を購読して外部変更（`clearPages` 等）にも追従させる。`populateEditor` は選択 0 件時に編集パネルを hide しつつ `syncFillToggle(getFillColor())` でスウォッチ側の表示を保つ（ユーザーが意図して選んだ次配置用の色を勝手にリセットしない）。クリックハンドラは `getFillColor() === color` なら `default` に戻し、違えば `color` をセット（アクティブ再クリックでトグル off）。
- 保存時の data フロー: `exportEdits()` で既存 edit diff と新規 layer の両方が `fillColor` を保持 → Rust `LayerEdit` / `NewLayer` の `fill_color: Option<String>` に受け渡し → JSX 生成で `fillColor: "..."` をレイヤーオブジェクトに出力 → `applyToPsd` 内で `ti.color` / `nti.color` に反映。

### 5. フォント選択
- エディタ内は **カスタムコンボボックス**（検索入力 + `▾` トグル + 絞込みドロップダウン）。
  - 入力時に `fonts[]` を family name / PS 名のどちらでも大文字小文字区別なしで逐次フィルタ。
  - ↑↓で候補移動、Enter で確定、Esc で閉じる、外側クリック / blur で自動クローズ。
  - 確定値は PostScript 名を `state.currentFontPostScriptName` と該当レイヤー差分に反映。
- 新規テキストのオーバーレイ表示 / 既存レイヤーのオーバーレイも `inner.style.fontFamily` に `family name, PS 名, sans-serif` を設定して即時反映。
- 保存時は JSX の `ti.font = postScriptName` で Photoshop に書き戻し、`nti.useAutoLeading = true; nti.autoLeadingAmount = 125;` で行送りも明示。

### 6. ズーム
- ツールバー左（Pd ロゴ右）に左から **ズームイン ＋ / パーセント表示 / ズームアウト −** の順で配置。パーセントクリックで 100% リセット。
- `#spreads-container` を `overflow: auto` にして canvas の `cssW / cssH` を zoom 倍して描画、はみ出た部分はスクロールで閲覧。
- **`Alt + ホイール`** でも拡縮（`passive: false` で preventDefault）。
- ショートカット: `Ctrl+=` / `Ctrl++` / `Ctrl+テンキー+` でズームイン、`Ctrl+-` / テンキー `-` でズームアウト、`Ctrl+0` / テンキー `0` で 100% リセット。capture フェーズで確実に先取り + `preventDefault/stopPropagation`。

### 7. 保存済み PSD の再編集
- JSX で新規レイヤー作成後、`layerRef.bounds` 参照＋`translate(0,0)` で bounds を強制再評価し、PSD の LayerRecord に正しい top/left/bottom/right を書き込む。
- `psd-loader.js` は `layer.text.orientation` から `direction` を取得。
- 既存レイヤーの overlay は bounds が過小なとき `fontSize × 行数 × 文字数` でフォールバック算出し、必ずクリック可能サイズに。

### 8. Photoshop 保存と完了同期
- Rust は Photoshop を `spawn()` で非同期起動。
- JSX が全処理後に `%TEMP%/psdesign_done_<ts>.flag` に `OK` / `ERROR …` / **`OK|WARN <msg1> | <msg2>`** を書き込み、Rust がポーリングして真の完了を検知（最大 10 分）。
- 結果は右上トーストで通知。警告付き（`|WARN` を含む）なら `kind: "info"` + 7 秒表示、純 OK なら `kind: "success"` + 3.5 秒。
- **Photoshop 側シークエンスバー**: ScriptUI パレットウインドウ（`jsx_gen.rs` の `initProgress / setProgress / closeProgress`）を `Window("palette", ...)` で表示。Photoshop の UI 上に `[プログレスバー][現在処理中の PSD 名][X / N]` を出し、`.update()` で即時再描画。`writeSentinel` が冒頭で `closeProgress()` を呼ぶため、成功/失敗/例外のどれでも UI リーク無し。
- **互換性強化（Photoshop 将来アップデート対策）**:
  - Action Manager は `charIDToTypeID`（CS6 時代の 4 文字コード、将来削除リスク）をやめ、**`stringIDToTypeID`（Adobe 推奨）に全面移行**。`sID = function (s) { return stringIDToTypeID(s); }` ラッパで統一（`frameFX` / `outsetFrame` / `solidColor` など）。
  - `photoshopVersion()` で `parseFloat(app.version)` を取得、CS6 (v13) 未満は `addWarning(...)` で警告。
  - `PSDESIGN_WARNINGS[]` に警告蓄積、`writeSentinel` で `|WARN` 後に結合。`applyStrokeEffect` 失敗はここに入り、保存自体は続行。
- 進捗ウインドウは HEADER に関数定義、`generate_apply_script` が PSD ループで `setProgress(idx, total, "<name> を処理中 (i+1/total)")` を各 `applyToPsd` 直前に emit、ループ終了後 `setProgress(N, N, "完了")` で満タンにしてから `writeSentinel("OK")`。

### 8b. 保存ドロップダウン（上書き／別名）
- ツールバーの保存ボタンは MojiQ 風ドロップダウン（`.save-container` + `.save-menu`、三角吹き出し付き）。
- メニュー項目:
  - **上書き保存**（`Ctrl+S`）: 既存 PSD を `doc.save()` で上書き。
  - **別名で保存**（`Ctrl+Shift+S`）: 親フォルダを選択するダイアログ → `<元フォルダ名>_YYYYMMDD_HHMMSS` のサブフォルダを Rust の `std::fs::create_dir_all` で作成 → 各 PSD を `doc.saveAs(file, PhotoshopSaveOptions, asCopy=true, Extension.LOWERCASE)` で書き出し。
- **初回 Ctrl+S は別名で保存に自動フォールバック**：`hasSavedThisSession` フラグ（`loadPsdFilesByPaths` 開始時に false リセット、成功で true）を main.js が保持。メニューから明示的に「上書き保存」を選べば常に上書き。
- payload は従来の `exportEdits()` に `saveMode: "overwrite" | "saveAs"` と `targetDir` を追加。`EditPayload`（lib.rs）と `generate_apply_script`（jsx_gen.rs）が対応。JSX の `applyToPsd(psdPath, edits, newLayers, savePath)` は 4 引数目 `savePath` が空なら `doc.save()`、セットされていれば `saveAs` を呼ぶ。
- ドロップダウンは save-btn クリックでトグル、`document mousedown` による外側クリック検出 / `Esc` で閉じる。保存成功で右上トーストに保存先パスを併記。

### 9. 表示画質
- `canvas.width = cssW × devicePixelRatio` + `imageSmoothingQuality = "high"` で 1 回だけダウンサンプル。
- `ResizeObserver` でウィンドウサイズ変更に追従、`onZoomChange` で各ページ redraw を再実行。

### 10. UI

- **カスタムタイトルバー**（`decorations: false`）:
  - 左: **Pd 紫バッジロゴ**（`#2a0a4a` bg / `#c4a6ff` 文字、暫定アイコン）と **ハンバーガー `≡`**。続いて **ズーム群**（＋ / % / −）、**ツールバーアクション**（フォルダ / TXT / 保存ドロップダウン）。`data-tauri-drag-region` で空白をドラッグしてウインドウ移動。
  - **保存ドロップダウン**（`#save-container` > `#save-btn` + `#save-menu`）: クリックで開閉。メニュー右端にショートカット表記（`Ctrl+S` / `Ctrl+Shift+S`）を表示。ホームに戻る時 / 保存ボタン disabled 時はメニューを自動で閉じる。
  - 右: `window-controls`（最小化 / 最大化トグル / 閉じる）。close ホバーは `#e81123`。
- **ハンバーガーメニュー**（左スライドイン 280px）:
  - 下部 3 アイコンボタン: **ワークスペース反転**（MojiQ 流の FlipIcon：左右矢印ポリゴンが状態に応じて塗り分け。`.workspace` に `.flipped` クラスを付与、`grid-template-columns` を `1fr auto 44px 320px` ↔ `320px 44px auto 1fr` で反転し、各子要素に明示的 `grid-column` を割当て。ページバーハンドルラベル位置・折畳トグル矢印方向も CSS で自動反転）、**ライト/ダークモード切替**（`<html data-theme>` + `localStorage psdesign_theme`）、**ホームに戻る**（`confirmDialog` 必須、OK で folder/pages/TXT を全クリア）。
  - ワークスペース反転状態は `localStorage psdesign_layout_flipped` に永続化。
  - 暗幕クリック / Esc / × で閉じる。
- **縦ページバー**（キャンバス右／サイドツールバー左）:
  - トラック（12px 幅、CSS 変数 `--pagebar-track`）＋ **MojiQ 風カプセル型ハンドル**（10×30px、縦グラデ + 白線 2 本グリップ）。
  - ホバー/ドラッグ中にハンドル左側へ `現在ページ / 総数` のラベル。
  - 上部 `>>` トグルで折畳／展開、24px 幅に縮小＆トラック非表示。`localStorage psdesign_pagebar_visible` で永続化。
  - **折畳時は背景・枠・下部 padding をすべて消し、展開ボタン `＜` のみが浮いて見える状態**（`.pagebar.collapsed { background: transparent; border: none; padding: 6px 0 0; gap: 0; }`）。展開すると通常の `var(--panel)` 背景と枠が復活。
- **サイドツールバー**: V（選択） / T（縦書き） / Y（横書き） / パン の縦 4 ボタン、アクティブは青塗り、枠無し。縦書き／横書きは `data-tool="text-v"` / `data-tool="text-h"` で切り替わり、どちらも `isTextTool(tool)` で同一系統として扱われる。末尾（`margin-top: auto` で押し下げ）に **文字色スウォッチ**（`.fill-color-picker`）：Photoshop 風に白と黒の小スウォッチをオーバーラップ配置し、アクティブ側は青リングで強調。**アクティブ中の色を再クリックすると「そのまま（default）」に戻る**（両スウォッチ非アクティブ表示）。
- **右サイドパネル**（上から順）:
  1. 原稿 TXT（ファイル名 + ゴミ箱アイコンのクリアボタン、TXT ドロップゾーン）。未読込時は file-text アイコン＋メッセージ。
  2. **編集**（h2 見出し、常時表示）: フォントコンボボックス / サイズ入力 ＋ **組方向トグル（縦／横）** / **フチ行**（`なし/白/黒` トグル + `太さ: N px`）。見出し直下の editor は**選択 0 件で hidden、1 件以上で表示**。`data-editor-scope="single"` を付けた項目（フォント / サイズ・組方向）は単独選択時のみ、**フチ項目は複数選択時も表示**して一括適用できる。項目間は `.editor > *:not([hidden]) + *:not([hidden]) { border-top: 1px solid var(--border); margin-top/padding-top: 10px; }` で**区切り線**を描画（hidden 要素は先頭扱いにならないよう `:not([hidden])` ペアのみ適用）。テキスト本文の編集は T ツールの in-place 編集で行う（サイドバーからの編集欄は廃止）。文字色はサイドツールバー末尾のスウォッチに分離（選択解除中も操作可）。
  3. テキストレイヤー一覧。項目クリックで単数選択、**Shift+クリックで複数選択の加算／解除**（`toggleLayerSelected` 経由）。キャンバスのマーキー選択・Shift+レイヤークリックと同一の `state.selectedLayers` モデルを共有。
  4. **レイヤー削除ボタン**（一覧下部 `.layer-list-footer` 内、ゴミ箱アイコンの `.layer-delete-btn`）：選択中のいずれかが新規レイヤーの場合のみ表示（`updateDeleteButtonVisibility`）。クリックで `confirmDialog`（「レイヤーを削除します。よろしいですか？」）を出し、OK のときだけ選択中の新規分を一括削除し、既存レイヤーは選択に残す。
- **空状態**（PSD 未読込）: spreads-container 中央にフォルダアイコン＋「「PSD を開く」で編集したい PSD ファイルを選択、またはこのウィンドウにドロップしてください。」
- **D&D オーバーレイ**（`#drag-overlay`）: ファイルドラッグ中の視覚フィードバック。全画面固定・`pointer-events: none`・`z-index: 400`（モーダルの上に重なる）。Tauri の `tauri://drag-enter` / `tauri://drag-over` で `.active` 付与 → 青枠 + 内側グロウの **1.2 秒パルスアニメーション**（`drag-overlay-pulse`、`--accent` ↔ `--accent-hover`）、`tauri://drag-leave` で外して 0.18 秒 fade out。`tauri://drag-drop` では `.flash` クラスによる 0.35 秒のワンショットブライトフラッシュ（`drag-overlay-flash`）で投下確認を演出してから消える。
- **中央プログレスモーダル**: PSD 読込・Photoshop 反映時。背景・カード・テキスト要素すべてに `data-tauri-drag-region` を付与してあり、読込中でもモーダル上のどこをドラッグしてもウインドウを移動できる。
- **`confirmDialog`**: Tauri の native `ask` を置き換えるカスタムモーダル。`Promise<boolean>` を返し、Enter 確定 / Esc / 暗幕 / キャンセルで `false`。
- **テーマ**: `:root[data-theme="dark"|"light"]` に CSS 変数セットを分離。キャンバス背景・ページ背景・ページバー・スクロールバーも変数化済み。`color-scheme` も同時に切替、`::-webkit-scrollbar*` と `scrollbar-color` でスクロールバーの配色も両テーマ追従。

## ショートカット

| キー | 動作 |
| --- | --- |
| `V` | 選択ツール |
| `T` | 縦書きツール |
| `Y` | 横書きツール |
| `Space`（長押し） | パンツール一時切替（離すと元に戻る／ツールバー表示は維持） |
| `Shift+ドラッグ`（V、空キャンバス） | マーキー選択に加算 |
| `Shift+クリック`（V、レイヤー） | 選択のトグル |
| `[` / `]` | サイズ ±2（Shift で ±10） |
| `←` / `→` | 前 / 次のページ |
| `Ctrl+←` / `Ctrl+→` | 先頭 / 末尾ページ |
| `Ctrl+J` | ページ番号ジャンプダイアログ |
| `Ctrl+S` | 上書き保存（初回のみ別名で保存にフォールバック） |
| `Ctrl+Shift+S` | 別名で保存（新規フォルダ作成） |
| `Ctrl+=` / `Ctrl++` | ズームイン（15%） |
| `Ctrl+-` | ズームアウト（15%） |
| `Ctrl+0` | ズーム 100% |
| `Alt + ホイール` | キャンバス上でズーム |
| `Enter`（in-place 編集 / 手入力 textarea 内） | 改行 |
| `Ctrl+Enter`（同上） | テキスト確定 |
| `Esc` | フォント候補 / ダイアログ / 保存メニュー / テキスト入力を閉じる |

## データフロー

1. PSD ファイル選択（複数可）or ファイル／フォルダのドロップ → フォルダは Rust `list_psd_files` で `.psd` を展開 → `loadPsdFromPath`（ag-psd）→ `state.pages` に追加。`hasSavedThisSession` を false にリセット。`state.folder` は最初に読み込んだ PSD の親ディレクトリで初期化（別名で保存のフォルダ名生成に使う）。
2. ユーザー編集 → `state.edits`（既存レイヤー差分）/ `state.newLayers`（新規配置、フォント / サイズ / 方向 / 文字色 / フチ色・太さ含む）に蓄積。T ツールで既存/新規レイヤーをクリックすると in-place textarea が開き、確定で同じ state 差分に書き戻す。
3. 選択状態は `state.selectedLayers: Array<{pageIndex, layerId}>` で複数管理。`setSelectedLayer` / `getSelectedLayer` は配列の先頭要素を扱う単数ラッパ。マーキー選択・Shift トグルは `setSelectedLayers` / `toggleLayerSelected` で配列を更新。
4. 「保存」 → `exportEdits()` に `saveMode` / `targetDir` を付けた payload を `apply_edits_via_photoshop` に渡す → 別名保存時は Rust で `create_dir_all` → JSX 生成（各 PSD に `savePath` を埋込）→ PS 実行 → センチネル → 完了。成功で `hasSavedThisSession = true`。

## 設計メモ

- テキストレイヤーの編集は「差分」として state に持ち、元の `textLayers` はイミュータブルに扱う。
- 新規レイヤーは `tempId`（"new-1", …）で識別。保存で実 Photoshop ID が振られ、次回読込時は既存レイヤーとして再編集できる。
- **Tauri 2 の `dragDropEnabled: true`**（window config）で OS の D&D を Tauri の 4 イベント（`tauri://drag-enter` / `tauri://drag-over` / `tauri://drag-leave` / `tauri://drag-drop`）として受け取り、絶対パスが取れる。`main.js` の `setupTauriDragDrop` が 4 つすべてを listen し、enter/over で D&D オーバーレイ表示、leave で非表示、drop で flash アニメ + `handleDroppedPaths` による振分け（`.psd` → 読込、`.txt` → `loadTxtFromPath`、拡張子なし → フォルダ想定で `list_psd_files` 展開）。
- `ag-psd` の合成 `psd.canvas` を表示に使うため、色域（ICC）や一部レイヤー効果の忠実度は Photoshop 完全一致ではない。
- 段落内の改行は UI では `\n`、Photoshop 保存時のみ JSX 側で `\r` に正規化。
- 縦ページバーは `.workspace` のグリッド列（デフォルト `1fr auto 44px 320px` ／ 反転時 `320px 44px auto 1fr`）で幅を確保。折畳時はページバー列 44 → 24。ワークスペース反転時は `.workspace.flipped > .xxx` セレクタで各子要素に `grid-column` を再割当てし、ページバーハンドルラベルの `right: 100%` → `left: 100%`、折畳トグル SVG の `transform: scaleX(-1)` も自動反転。
- カスタムウインドウコントロールは `@tauri-apps/api/window` を動的 import。Tauri v2 の capability で `core:window:allow-start-dragging` 等を明示許可しないと drag region が無反応なので注意。
- **`<label>` に `<button>` をネストすると**、Chromium がラベルの暗黙 control として「最初の labellable 子孫」を選ぶため、ラベル領域内のどこにカーソルがあってもその子ボタンが `:hover` 扱いになる罠がある。サイズ編集では `<label>` を `<div class="size-field">` に置換して回避。
- フォント名 → CSS `font-family` は PostScript 名を直接使うと認識されないブラウザがあるため、`list_fonts` から `name`（display/family）にマップしてからカンマ区切りで指定。
- ズームと `overflow: auto` の組合せ時は `.spreads-stage` に `align-items: safe center` を指定し、コンテンツがコンテナより大きくてもスクロール可能にする。
- ズームショートカットは WebView2 のネイティブ処理と競合することがあるため、capture フェーズで先取り + `preventDefault + stopPropagation`。
- 新規レイヤーのオーバーレイ枠サイズは `longRaw = Math.max(ptInPsdPx * 2, ptInPsdPx * 1.05 * chars)`・`thick = ptInPsdPx * 1.25 * lineCount`。`.new-layer-text` / `.existing-layer-text` は `padding: 0` / `overflow: hidden`、枠縁と描画領域を一致させて見切れと余計な空白を両方回避（CJK グリフの ascent/descent ぶんの 5% だけバッファ）。
- `Ctrl+S` / `Ctrl+Shift+S` は WebView2 のページ保存ショートカットと競合するので `bindTools` の keydown ハンドラ内で `preventDefault + return` にて確実に先取りする。
- **Space の `preventDefault` はリピート keydown でも毎回呼ぶ**必要がある。MojiQ 流。`!e.repeat` ガードで初回しか prevent しないと、Space 長押し中に `#spreads-container`（`overflow: auto`）が既定の「1 画面下スクロール」を連打してしまう。
- **パンのリスナーは MojiQ に倣って canvas 自身に張る**（`window` ではなく）、毎イベントで `preventDefault + stopPropagation`。`dragDropEnabled: true` の Tauri window 配下では Chromium 由来のドラッグ系既定動作がスクロールを誘発しうるため、イベントを親にバブリングさせない。
- **複数選択モデル**：`state.selectedLayers` は `Array<{pageIndex, layerId}>`。`isLayerSelected(pageIndex, layerId)` は `some` でスキャン。`toggleLayerSelected` は配列入替で参照を更新する。`rebuildLayerList` が `applySelectionHighlight`（`some` マッチ）＋ `populateEditor`（選択数 1 のときだけフォーム表示）を呼ぶので、選択変更後は `renderOverlay + rebuildLayerList` を呼べばオーバーレイ・リスト・編集パネルが一括同期する。
- **レイヤー矩形計算の共通化**：`canvas-tools.js` の `layerRectForExisting` / `layerRectForNew` が `{left, top, right, bottom, width, height, isVertical, ptInPsdPx}` を返し、`renderOverlay` とマーキーヒット判定（`rectsIntersect` + `collectLayerHits`）で同一式を使う。フォールバック（`fallbackLong`/`fallbackThick`/`minLong`/`minThick`）も共有。
- **テキスト入力 floater の共通化**：`canvas-tools.js` の `createTextFloater(ctx, opts)` が textarea 生成・配置・`focus/keydown/blur` 配線・`input.__finalize = finalize` 付与を一手に担う。`startTextInput`（新規入力）と `startInPlaceEdit`（既存/新規レイヤー編集）はそれぞれ `onCommit(value)` コールバックと `initialText` / `selectAll` / `guardBlurUntilFocused` オプションで差分だけ宣言。`onCanvasMouseDown` が既存 floater を検出したら `__finalize(true)` で確定し新 textarea は開かず return、次クリックで新規入力を開く UX を成立させている。
- **確認ダイアログの z-index**：`confirmDialog`（`.progress-modal` 流用）はハンバーガーメニュー（z-index 150/151）から呼び出されるケースがあるため、`#confirm-modal { z-index: 300; }` で明示的に上層に置かないと、オーバーレイに隠れて操作不能になる罠。他の `.progress-modal`（PSD 読込・Photoshop 反映中）はハンバーガーから呼ばれないので z-index 100 のままで OK。
- **Photoshop Action Manager の string ID 移行**：`charIDToTypeID`（`"FrFX"` / `"Sz  "` / `"#Pxl"` 等の 4 文字コード）は CS6 時代の互換レイヤーで将来削除され得る。`applyStrokeEffect` は全面的に `stringIDToTypeID`（`"frameFX"` / `"size"` / `"pixelsUnit"` 等、Adobe 推奨）に移行済み。今後 Action Manager を足すときは `sID("...")` ラッパ経由で統一。
- **ag-psd の effects 読み戻しは形状揺れに注意**：`layer.effects.stroke` が Photoshop バージョンで配列 / 単体、`{value, units}` / ネスト `{value: {value, units}}`、`{r,g,b}` / `{red,green,blue}` / `[r,g,b]` / `#rrggbb` のいずれでも返る。`psd-loader.js` の `pickActiveStrokeFx` / `readStrokeSizePx` / `readStrokeColor` で吸収。pt 単位は 96/72 で px 換算、他単位はそのまま採用。
- **Photoshop 側シークエンスバー（ScriptUI palette）**：`Window("palette", ...)` はモードレスで Photoshop 操作を妨げないが、長時間ブロッキングスクリプト下で再描画が止まるため、`setProgress` 毎に `.update()` を呼ぶ必要あり。`writeSentinel` 先頭で `closeProgress()` を呼び、OK/ERROR/例外いずれも UI を確実に閉じる。
- **フチの `commitStrokeFields` は null = per-layer 保持**：色トグルクリック時は `commitStrokeFields(color, currentWidthForCommit())`、太さ input イベント時は `commitStrokeFields(null, width)`。`null` 指定の側は「各レイヤーの既存値を保持」と解釈される。これがないと複数選択で片方の属性だけ編集したとき、もう片方がグローバル state（`getStrokeColor/Width`）で他レイヤーに上書き伝播してしまう。`currentWidthForCommit` は width input が空（= 混在表示）なら `null` を返す。
