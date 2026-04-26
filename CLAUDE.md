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
│   ├── hamburger-menu.js     # 左スライドインメニュー（テーマ切替 / ワークスペース左右反転 / 環境設定 / ホームに戻る）
│   ├── settings.js           # 環境設定の state + localStorage 永続化 + ショートカット照合 (`findShortcutMatch` / `matchShortcut`) + 衝突検知 + listener API
│   ├── settings-ui.js        # 環境設定モーダル（タブ：ショートカット / ページ送り反転）+ キーキャプチャモーダル + 衝突警告 UI
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

## 最新セッション（PDF/PSD 並列ビュー強化）

I. **PDF 仮想ページ機構**: `src/pdf-pages.js` を新設し、PDF を物理ページ番号 + side（"full" / "left" / "right"）の **仮想ページ列**として扱うレイヤを追加。`getPdfVirtualPages()` / `getPdfVirtualPageCount()` / `getPdfVirtualPageAt(idx)` / `getPdfVirtualIndexForPhysicalPage(pageNum)` を提供。`pdf-view.js` は `getCurrentPageIndex` ではなく `getPdfPageIndex` + 仮想ページ参照に切替。side が `"left"` / `"right"` のときはオフスクリーン canvas に full レンダ → 表示用 canvas に半分だけ `drawImage(off, -srcX, 0)` で切り出し。`viewport0.width > viewport0.height` でないとき（縦長ページ・90°/270° 回転後の縦長見え）は自動で `"full"` にフォールバック。

J. **PDF 単ページ化（横長見開き原稿の自動分割）**: `state.pdfSplitMode` を新設し、PDF 読込時に `pdf-loader.detectLandscape(doc)`（1 ページ目の `getViewport({rotation: baseRotation})` で width > height 判定）で **landscape を検出したら自動 ON**。手動切替ボタンは廃止（読込時の自動判定に一本化）。`pdf-pages.js` の生成ロジックは **和書右綴じ順**：P1 は中央分割の左半分のみ（裏白扱い）、P2 以降は **右半分 → 左半分** の 2 仮想ページに展開。総数 = `1 + 2 × (count - 1)`。

K. **先頭白紙ページ除外（チェックボックス）**: `state.pdfSkipFirstBlank`（既定 false、永続化なし）と `<button id="skip-first-blank-btn" aria-pressed>` を追加。トグル ON のとき仮想ページ生成で `startPage` を 2 に上げ、物理 P1 を完全に除外（split モードに依存せず動作）。トグル前後で同じ物理ページに留まるよう `getPdfVirtualPageAt` → `getPdfVirtualIndexForPhysicalPage` で remap。**Tauri の `data-tauri-drag-region` がクリックを横取りする問題**を回避するため、`<label>` + `<input type=checkbox>` ではなく `<button aria-pressed>` + 自作チェックボックス疑似要素（`.skip-blank-box::after` で ✓）で実装。アイコンはファイル＋中央 × の SVG（白文字、控えめな主張）。

L. **同期 / 非同期モードのページ進行ブリッジ**: `state.parallelSyncMode`（既定 true）と `state.activePane`（"pdf" / "psd"、既定 "psd"）を新設。同期モード ON では `onPageIndexChange` ↔ `onPdfPageIndexChange` を相互ミラー（再入防止に `syncBridgeBusy` フラグ）。PSD 未読込のときは `setCurrentPageIndex` が空回りするので `advancePage` / `jumpToEdge` 内で **PSD ページ無し → PDF を直接駆動**にフォールバック。非同期モードでは各ペインが独立し、`activePane` の側だけが矢印キー / ホイールで動く。**アクティブペインはクリックで切替**（`mousedown` を capture 相当で拾い、既存の layer-click 等は妨げない）。**青いリング枠** は async モード時のみ表示。同期に戻すときは **resync モーダル**（「このまま再同期」/「ページを合わせて再同期」）を出し、後者ではアクティブ側の index を非アクティブ側にコピー。トグル UI はアイコンのみ（`<button title="ページ同期" aria-label>` ＋ `<button title="ページ非同期" aria-label>`）、tooltip は「ページ同期 / ページ非同期」。

M. **PDF/PSD ズームの独立化**: 共有 `state.zoom` を廃止、`state.pdfZoom` と `state.psdZoom` に分離。Alt+wheel は **カーソルが乗っているペイン**を直接ズーム（PDF 領域なら pdfZoom、PSD 領域なら psdZoom）。+/- ボタン・`Ctrl+=` / `Ctrl+-` / `Ctrl+0` はアクティブペインを操作。ズーム表示は `PSD 100%` / `PDF 100%` のように対象ペインを明記し、`activePane` 切替で自動更新。

N. **PDF にもパンツール**: `pdf-view.js` にモジュールレベル `panState` を追加、canvas の `mousedown` / `mousemove` / `mouseup` を capture 相当で登録、毎イベントで `preventDefault + stopPropagation`。スクロール対象は `#pdf-stage`（PSD と同じ overflow:auto 構造）。`onToolChange` 購読で `cursor: grab`（pan 中）/ `grabbing`（ドラッグ中）/ `default` を切替。`window.mouseup` / `window.blur` を安全網に `endPdfPan()`。

O. **`Ctrl+J` ページジャンプの PDF 対応**: `decidePageJumpTarget()` で activePane を優先、無効なら片方にフォールバック。PDF を選んだ場合は **仮想ページ番号**で受け付ける（単ページ化中は `#1左 / #2右 / #2左 / …` の通し番号、先頭白紙除外 ON のときは除外後の通し）。ヒント表示も `"PDF ページ：1 〜 N を入力してください"` のように対象明記。

P. **ファイルピッカーのタイトル設定**: `pickPsdFiles` / `pickPdfFile` / `pickTxtPath` に `title: "PSDを開く" / "PDFを開く" / "テキストを開く"` を追加。OS のファイル選択ダイアログのタイトルバーに表示。

Q. **ページバー廃止 → サイドツールバーの上下ボタン化**: `#pagebar`・`spread-nav-track` / `spread-nav-handle` 系の HTML / CSS / JS（`pagebar.js`）を全廃止。代わりに `.side-toolbar` 内の文字色スウォッチ直上に **ページ移動グループ（▲ / "現在 / 総数" / ▼）** を配置。`bindPageNav` が `advancePage(±1)` を駆動、`updatePageNav` が `onPageIndexChange` / `onPdfPageIndexChange` / `onPdfChange` / `onPdfSplitModeChange` / `onPdfSkipFirstBlankChange` / `onParallelSyncModeChange` / `onActivePaneChange` を購読して表示・disabled 状態を更新。`.workspace` のグリッドは `1fr auto 44px 280px` → `1fr auto auto`（要素 width 駆動）に変更。

R. **サイズ・フチの ± ボタン位置入替**: `.size-group` / `.stroke-width-group` の DOM 順を `[−][input] [unit] [＋]` から **`[＋][input] [unit] [−]`** に入れ替え（id・ハンドラはそのまま、ショートカット `[` / `]` も従来どおり）。

S. **MojiQ 流の折り畳み（サイドツールバー / サイドパネル）**: 各パネル先頭に高さ 24px の `.panel-header` 帯を追加し、`.panel-toggle-btn`（`>>` chevron）を配置。クリックで `.collapsed` クラスをトグルし、要素 `width` を `44px ↔ 24px` / `280px ↔ 24px` に縮める（`transition: width 0.25s ease`）。`.collapsed > *:not(.panel-header) { display: none }` で本体非表示。アイコンは `.icon-collapse`（`>>`）/ `.icon-expand`（`<<`）を CSS で切替、ワークスペース反転時は `transform: scaleX(-1)` で向きを自動反転。状態は `localStorage psdesign_side_toolbar_collapsed` / `psdesign_side_panel_collapsed` に永続化、起動時に復元。`bindCollapseToggles` / `bindPanelToggle` / `applyPanelCollapsed` で配線。

> **このセッションの構造変更まとめ**:
> - 旧: `.workspace = 1fr auto 44px 280px`（spreads / pagebar / side-toolbar / side-panel の 4 列）
> - 新: `.workspace = 1fr auto auto`（spreads / side-toolbar / side-panel の 3 列、後ろ 2 列は要素 width で driven）。pagebar 廃止。
> - 旧: `state.zoom`（PDF/PSD 共有）、`state.currentPageIndex`（PDF/PSD 共有）
> - 新: `state.pdfZoom` / `state.psdZoom`（独立）、`state.currentPageIndex`（PSD 専用）/ `state.pdfPageIndex`（PDF 専用）。同期モード時は main.js の bridge が両者を相互ミラー。

## 最新セッション（致命的バグ修正・連打対策・環境設定）

### 致命的バグリスク調査と Critical 4 件の修正

T. **多重押下防止（保存ボタン）**: `runSaveWithMode` 入口に `saveInflight` モジュール変数のガードを追加。in-flight 中は `toast("保存処理中です。完了までお待ちください")` で早期 return、`#save-btn` も `disabled` 化。`finally` で `saveInflight = false` + ボタン再有効化（`getPages().length === 0` のときは disabled のまま）。Ctrl+S / Ctrl+Shift+S / メニューからの呼び出しすべてに同じガードが効く。**Photoshop が同じ PSD を 2 回開いて状態破壊する事故**を根本防止。

U. **編集中の PSD 切替で確認ダイアログ**: `loadPsdFilesByPaths` 冒頭で `hasEdits()` をチェック、true なら `confirmDialog({title: "未保存の編集があります", message: "現在の編集内容は破棄されます。続行しますか？", confirmLabel: "破棄して開く"})`。OK のときのみ `clearPages()` 実行。`handleDroppedPaths` 経由の D&D もここで一元的にカバー。ハンバーガー「ホームに戻る」は元から confirm 付きなので変更なし。

V. **NaN ガード**: `addEditOffset(psdPath, layerId, ddx, ddy)` の冒頭で `Number.isFinite(ddx) && Number.isFinite(ddy)` チェック。さらに防御深化として `exportEdits()` 内に `sanitizeNumericFields(obj)` を追加し、payload 出力時に NaN/Infinity の数値フィールドを脱落させる。新規レイヤーは `x` / `y` のいずれかが non-finite なら**そのレイヤー自体を payload から除外**（不正配置で JSX を壊さない）。これがないと JSX に `dx: NaN` リテラルが流れて Photoshop 側で `UnitValue` 例外 → 当該 PSD 以降のループ全停止。

W. **per-PSD try/catch + 進捗集計（JSX 側）**: `jsx_gen.rs` の `generate_apply_script` で各 `applyToPsd(...)` 呼び出しを **JS の try/catch で個別包囲**、`__saveOk++` / `__saveFail++` で集計、失敗は `addWarning("[保存失敗] <ファイル名>: <例外>")` に積んで継続。最終的に `writeSentinel("OK")` か `writeSentinel("OK partial " + __saveOk + "/" + (__saveOk + __saveFail))` を出力。`photoshop.rs` 側は `OK partial <ok>/<total>` をパースして「N / M 個の PSD を更新（警告: ...）」表示に切替。**「3 ファイル目で失敗 → 残り 7 ファイル未処理」のサイレント中断を解消**、ユーザーは成功数と失敗詳細を toast で確認できる。

> **特記**: 調査時に Explore エージェントが Critical と報告した「`saveAs` 失敗時の編集破棄（`asCopy=true` で原本は安全）」「センチネル空文字で 10 分ハング（実際は ERROR として正しく返る）」「`commitFillField("default")` で色破壊（JSX 側 `fillColorFor("default") === null` で `ti.color` を触らず無害）」は実コードを verify した結果**いずれも誤検知**。エージェント結果は `findShortcutMatch` 等と同じく**実装を直接確認してから採用**するワークフローを徹底すべき。

### ページ送り連打対策（PDF/PSD ラグ解消）

X. **PDF レンダタスクの即時キャンセル**: `pdf-view.js` にモジュール変数 `currentRenderTask` を追加、新 redraw の冒頭で `cancelInFlightRender()` を呼んで前の `RenderTask.cancel()` を確実に発火。`page.render(...)` の戻り値（RenderTask）を捕捉して `try/await/finally` で `currentRenderTask = null` リセット。連打中も pdfjs ワーカーが裏で複数のレンダ計算を並行実行して CPU 飽和、という連鎖を断ち切る。`RenderingCancelledException` は既存 catch でハンドル済みのため追加コード不要。

Y. **PSD ページ変更の rAF coalesce**: `bindPageChange` の `onPageIndexChange` 購読を `schedulePageRender()` で 1 フレーム合流。重い `renderAllSpreads()` + `rebuildLayerList()` + `updatePsdRotateVisibility()` は最終 index に対して 1 回だけ実行（`renderAllSpreads` は DOM を全壊して再構築するため、フレーム内で複数回呼ばれると DOM thrashing が生じる）。軽量な `updatePageNav()` のラベル更新のみは毎回即時実行して位置表示の応答性を保つ。

Z. **キーリピートのスロットル**: `e.repeat === true`（OS auto-repeat、〜30Hz）のときだけ leading-edge 80ms スロットル（`canAdvancePageNow()` ヘルパ）で実質 12Hz に制限。単発の手タップは `e.repeat === false` なので throttle されず即時反映。`isPageNavShortcut(id)` で対象を `pagePrev/pageNext/pageFirst/pageLast` の 4 つだけに限定。

### 環境設定（ショートカット + ページ送り反転）

α. **`src/settings.js` 新設**: MojiQ の `js/settings.js` を踏襲した state 管理モジュール。
- **永続化**: `localStorage` キー `psdesign_settings`、`migrate(old)` でデフォルト設定の上に保存値を被せる（デフォルトに無いキーは無視＝ホワイトリスト方式）。
- **API**: `getShortcut(id)` / `setShortcut(id, key, modifiers)` / `getAllShortcuts()` / `getPageDirectionInverted()` / `setPageDirectionInverted(v)` / `resetShortcuts()` / `resetAll()` / `checkConflict(id, key, modifiers)` / `formatShortcutDisplay(sc)` / `normalizeKeyName(rawKey)` / `matchShortcut(event, id)` / `findShortcutMatch(event)` / `onSettingsChange(fn)`。
- **照合ロジック**: `keysMatch(event, key)` で英字は case-insensitive、数値・記号キーは `e.code` 併用で JIS / US 配列差や Numpad を吸収（`=` ↔ `+` / `;`、`-` ↔ `_`、Numpad 系）。修飾キーは strict 一致（Ctrl は Cmd と等価）。
- **既定 15 ショートカット**: save / saveAs / pagePrev / pageNext / pageFirst / pageLast / pageJump / toolSelect / toolTextV / toolTextH / zoomIn / zoomOut / zoomReset / sizeUp / sizeDown。Space（パン）と Alt 抑制は特殊挙動のため対象外。

β. **`src/settings-ui.js` 新設**: モーダル UI 制御。
- **タブ**: 「ショートカット」「ページ送り」の 2 タブ、`switchTab(id)` で `.active` 付け替え。
- **ショートカットリスト**: `renderShortcutList()` で `getAllShortcuts()` を回して `<button class="shortcut-key-btn">` を動的生成、表示は `formatShortcutDisplay(sc)` で `Ctrl + Shift + S` のように整形。
- **キーキャプチャモーダル**: `openKeyCapture(id, sc)` で `window.addEventListener("keydown", onCaptureKeyDown, true)` を **capture フェーズ**で登録、毎キー preventDefault + stopPropagation、`Escape` でキャンセル / `Backspace` でクリア / 修飾キー単独押下 (`Control` / `Shift` / `Alt` / `Meta`) は無視。確定時は `checkConflict()` で他 ID との衝突警告を表示（衝突時も上書き可、ユーザー判断）。
- **ページ送り反転**: ラジオで `setPageDirectionInverted(value === "true")` 即時反映。
- **listener 連携**: `onSettingsChange(() => { ... })` で外部からの変更（reset 等）にも UI 追従。

γ. **`index.html` への追加**:
- ハンバーガー footer に `<button id="settings-btn" class="menu-icon-btn" title="環境設定">` を**「テーマ切替」と「ホーム」の間に**配置（歯車 SVG アイコン）。
- `<div class="settings-modal" id="settings-modal">` 本体（タブ + ショートカットリスト + ラジオ）と `<div class="settings-modal" id="key-capture-modal">` を末尾に追加。

δ. **`styles.css` 追加**: `.settings-modal / .settings-card / .settings-tabs / .settings-tab / .settings-tab-panel / .settings-section-header / .settings-reset-btn / .shortcut-list / .shortcut-item / .shortcut-key-btn / .settings-radio-list / .settings-radio-option / .key-capture-card / .key-capture-display / .key-capture-conflict` を**既存の CSS 変数 (`--bg`, `--panel`, `--accent`, `--text`...) で**統一実装。z-index は `.settings-modal { z-index: 200 }`（ハンバーガー 151 より上）、`#key-capture-modal { z-index: 320 }`（キャプチャがさらに最前面）。

ε. **`main.js` のショートカットハンドラ全面リファクタ**: keydown ハンドラから個別の hardcoded `if (e.code === "Equal" ...) zoomIn()` 群を撤去し、以下の構造に再編。
- **Space**: 既存挙動（パン一時切替）をそのまま保持。
- **矢印キー + move ツール + 選択中**: レイヤーナッジを最優先（`nudgeSelectedLayers(dx, dy)` が成功したら return）。これは環境設定対象外（ナッジは `e.shiftKey` で 1px / 10px 選択あり）。
- **環境設定 dispatch**: `findShortcutMatch(e)` で ID 取得 → `isShortcutBlockedInInput(id, e.target)` で入力欄ガード（無修飾 or 矢印キーは入力欄では無効） → `e.repeat && isPageNavShortcut(id)` でページ送りのみ throttle → `runShortcut(id)` で実行。
- **`runShortcut(id)`**: 15 ID を switch で dispatch。`pagePrev/pageNext/pageFirst/pageLast` は `getPageDirectionInverted()` に従って方向を入替（true なら `pagePrev → advancePage(+1)` / `pageNext → advancePage(-1)` / `pageFirst → jumpToEdge("last")` / `pageLast → jumpToEdge("first")`）。**サイドバーの ▲/▼ ボタンは反転対象外**（直接 `advancePage(±1)` を呼ぶため）。
- `bindZoomTool` の capture フェーズハンドラも `matchShortcut(e, "zoomIn"/"zoomOut"/"zoomReset")` 一本化、WebView2 の native zoom hijack 対策は維持。
- 既存の **Shift+]/[ で ±10pt の倍速調整**は撤去（matcher が strict 修飾判定のため）。±2pt の単発のみ。大きい変更はサイズ入力欄に直接タイプ。

ζ. **`hamburger-menu.js` 配線**: `import { openSettingsModal } from "./settings-ui.js"`。「設定」クリック時は `closeMenu()` を先に呼んでから `openSettingsModal()`（ハンバーガーと設定モーダルの z-index 順序を簡潔化）。

> **このセッションの構造変更まとめ**:
> - 旧: keydown ハンドラに 15 個の hardcoded `if (key === ...) action()` が直書き
> - 新: `findShortcutMatch(event)` → `runShortcut(id)` の 2 段 dispatch、設定値は `localStorage` → `settings.js` → matcher で照合
> - 旧: ←/→ キー = 物理方向で固定（advancePage に直結）
> - 新: ←/→ キー = `pagePrev/pageNext` shortcut 経由、`pageDirectionInverted` で進行方向を実行時切替（▲/▼ ボタンは物理方向のまま）

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

下記のうち **★ 印は環境設定（ハンバーガー → 歯車）からカスタマイズ可能**。Space / Alt 抑制 / 矢印ナッジ / マーキー選択 / wheel 系 / Esc / Enter は固定。

| キー | 動作 |
| --- | --- |
| `V` ★ | 選択ツール |
| `T` ★ | 縦書きツール |
| `Y` ★ | 横書きツール |
| `Space`（長押し） | パンツール一時切替（離すと元に戻る／ツールバー表示は維持） |
| `Shift+ドラッグ`（V、空キャンバス） | マーキー選択に加算 |
| `Shift+クリック`（V、レイヤー） | 選択のトグル |
| `[` ★ / `]` ★ | サイズ ±2（旧 Shift で ±10 倍速は撤去） |
| `←` ★ / `→` ★ | 前 / 次のページ（環境設定で**反転可**：→で前 / ←で次） |
| `Ctrl+←` ★ / `Ctrl+→` ★ | 先頭 / 末尾ページ（反転設定で入替）|
| `Ctrl+J` ★ | ページ番号ジャンプダイアログ |
| `Ctrl+S` ★ | 上書き保存（初回のみ別名で保存にフォールバック）|
| `Ctrl+Shift+S` ★ | 別名で保存（新規フォルダ作成） |
| `Ctrl+=` ★ / `Ctrl++` ★ | ズームイン（15%） |
| `Ctrl+-` ★ | ズームアウト（15%） |
| `Ctrl+0` ★ | ズーム 100% |
| `Alt + ホイール` | キャンバス上でズーム |
| `Enter`（in-place 編集 / 手入力 textarea 内） | 改行 |
| `Ctrl+Enter`（同上） | テキスト確定 |
| `Esc` | フォント候補 / ダイアログ / 保存メニュー / テキスト入力 / 環境設定モーダルを閉じる |
| `←/↑/→/↓`（V ツール + レイヤー選択中） | 1px ナッジ（Shift で 10px、環境設定対象外）|

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
- **多重保存ガードは `runSaveWithMode` 入口の単一フラグ**：`saveInflight` をモジュール変数で持ち、ガードは中央 1 箇所だけ。Ctrl+S / Ctrl+Shift+S / メニューからの呼び出しすべてが `runSaveWithMode` を経由するので入口ガードで網羅できる。`finally` でリセット + `getPages().length === 0` のとき disabled を維持して save-btn の状態整合性を保つ。
- **JSX の per-PSD 失敗継続パターン**：`generate_apply_script` のループで各 `applyToPsd(...)` を JS の `try { ...; __saveOk++; } catch (eFile) { __saveFail++; addWarning(...); }` で個別包囲。`applyToPsd` 内の `finally { doc.close(DONOTSAVECHANGES) }` が先に走るので例外発生時もリソースリークなし。最終 `writeSentinel("OK partial " + __saveOk + "/" + (__saveOk + __saveFail))` で部分成功を明示、Rust 側で `OK partial <ok>/<total>` を strip_prefix → "N / M 個の PSD を更新（警告: ...）" 表示に切替える。
- **`exportEdits` の NaN サニタイズは二段防御**：一次は `addEditOffset` 入口で `Number.isFinite(ddx) && Number.isFinite(ddy)` チェック、二次は `exportEdits` 内 `sanitizeNumericFields(rest)` で payload 出力時に NaN/Infinity 数値を除去。新規レイヤー (`x`/`y`) は不正なら**そのレイヤー自体を payload から落とす**（壊れた配置で JSX を破綻させない）。これがないと JSX に `dx: NaN` リテラルが出て Photoshop 側で `UnitValue` 例外 → 当該 PSD 以降のループ全停止につながる。
- **PDF レンダタスクは必ず `cancel()` する**：`pdf-view.js` の `currentRenderTask` モジュール変数で in-flight な `RenderTask` を保持し、新 redraw 冒頭で `cancelInFlightRender()` を呼んで前タスクを停止。`renderToken` のチェックだけだと結果は捨てるが裏で計算は走り続けるので、連打中に複数のレンダが並行して CPU 飽和する。`page.render(...)` の戻り値は **RenderTask（`.promise` と `.cancel()` を持つ）** であり、await するときは `.promise` のみ、cancel するときは task 本体に対して呼ぶ。
- **PSD ページ変更の rAF coalesce**：`bindPageChange` の listener 内で `schedulePageRender()`（rAF debounce 1 段）を呼び、重い `renderAllSpreads()` + `rebuildLayerList()` + `updatePsdRotateVisibility()` をフレーム合流。`renderAllSpreads` は `root.innerHTML = ""` で DOM を全壊して再構築するため、auto-repeat 30Hz で連射されると DOM thrashing で著しいラグが出る。軽量な `updatePageNav()`（ラベル更新）のみは即時実行して位置表示の応答性を保つ。
- **キーリピートの leading-edge スロットル**：`canAdvancePageNow()` が `lastArrowAdvanceAt + 80ms` を満たすかチェック、満たせば `lastArrowAdvanceAt = now()` 更新して true。`e.repeat === true && isPageNavShortcut(id)` のときだけ適用するので、単発の手タップは throttle されず即時反映。`pagePrev/pageNext/pageFirst/pageLast` の 4 つだけが対象、`sizeUp/sizeDown` 等は throttle されない。
- **環境設定の matcher は strict 修飾キー一致**：`matchShortcutObj(event, sc)` で `event.ctrlKey !== wantCtrl` などを strict 比較。これにより `save = "Ctrl+S"` と `saveAs = "Ctrl+Shift+S"` が衝突なく共存できる（Ctrl+Shift+S 押下時、save の wantShift=false に対して shiftKey=true で不一致 → save は match せず、saveAs だけが match する）。代償として **`sizeUp = "]" no-mods` のとき Shift+] は match しない**ため、旧 Shift+] で ±10pt の倍速調整は撤去された。サイズ大幅変更はサイズ入力欄に直接タイプする運用。
- **入力欄での shortcut ガードはルール 1 本**：`isShortcutBlockedInInput(id, target)` が「INPUT/TEXTAREA/contenteditable + (修飾キーなし or 矢印キー使用)」の組合せだけ true を返す。これにより Ctrl+S 等は入力中でも発火、Ctrl+← 等は入力中の word jump を尊重して shortcut 抑止、V/T/Y や ←/→ も入力中は素通し（テキスト入力の邪魔をしない）が一貫して効く。
- **キーキャプチャモーダルは capture フェーズで全キー横取り**：`onCaptureKeyDown` を `window.addEventListener("keydown", fn, true)` で登録、毎キー `preventDefault + stopPropagation`。これでキャプチャ中に Ctrl+S 等の他 shortcut が誤発火するのを防ぐ。`closeKeyCapture` で必ず removeEventListener。修飾キー単独 (`Control` / `Shift` / `Alt` / `Meta`) は `isModifierOnly(key)` で無視（押し続けで暴走しないため）。
- **ページ送り反転は keyboard だけ、ボタンは物理方向**：`runShortcut("pagePrev")` 内で `getPageDirectionInverted()` をチェックして `advancePage(±1)` を入替えるが、サイドバーの ▲/▼ ボタンは `bindPageNav` 内で直接 `advancePage(±1)` を呼ぶため反転設定の影響を受けない。これは「←/→ キーは『左キー = 進む方向』として配置するのが自然な人もいれば逆の人もいる」（縦書き右綴じ漫画の慣習）を尊重する一方、▲/▼ は視覚的に「上 = 戻る、下 = 進む」が普遍的なので物理方向で固定する設計判断。

## 最新セッション（テキスト編集 UX 強化 + ルーラー / ガイド）

### テキストツールの操作性向上

a. **テキスト枠上で wheel サイズ可変**: `canvas-tools.js` の `onLayerWheel` の発火条件を `move` 限定から `move | text-v | text-h` に拡張。テキストツール選択中もレイヤー枠ホイールで ±1pt（Shift で ±10pt、6〜999 pt クランプ、中心固定）。

b. **テキスト配置直後に方向キーでナッジ**: `main.js` の矢印キー dispatch で `getTool() === "move"` の制限を `move | text-v | text-h` に拡張。配置直後（自動選択中）も矢印キーで 1px / Shift+10px ナッジ可能。`startTextInput` 確定時に `setSelectedLayer(...)` で新規レイヤーを自動選択するようにし、txt 原稿配置と手入力配置の整合を取った。

c. **選択中レイヤー右下にサイズバッジ**: `canvas-tools.js` `createSizeBadge(sizePt)` を追加し、`renderOverlay` で selected 時のみ box に append。`.layer-size-badge` は黒背景・白文字で枠下中央外側に張り出し（`top: 100%; left: 50%; transform: translateX(-50%)`）、`pointer-events:none` でホイール操作を妨げない。`.layer-box-new` の `overflow: hidden` を撤去（`.new-layer-text` 側で既に hidden 指定済みのため見た目への影響なし）し、バッジが枠外に出られるようにした。ホイールでサイズ変更すると `refreshAllOverlays` 経由でバッジも追従。

d. **空所クリック先に選択解除（テキストツール）**: `onCanvasMouseDown` のテキストツール分岐で「txt セレクションなし + 選択中レイヤーあり」のとき、空所クリックを「まず選択解除のみ、新規 textarea は開かない」に変更。次のクリックではじめて新規入力 textarea が起動するため、配置完了後の空所クリックで意図せず textarea が暴発する事故を解消。

### テキスト回転ハンドル

e. **選択中レイヤー上辺中央に回転ハンドル**: `state.js` の `addNewLayer` に `rotation` 引数（既定 0）追加。`canvas-tools.js` で `box.style.transform = rotate(Ndeg)` を既存 / 新規両方に適用、selected 時に `createRotateHandle()` を box に追加。`beginRotateDrag(e, ctx, layerId)` がドラッグ中の `mousemove` で `Math.atan2` から角度差分を計算、`setLayerRotation(...)` で更新（Shift で 15° スナップ）。回転中心は `box.getBoundingClientRect()` の AABB 中心（CSS rotate は中心保持なので元の box 中心と一致）。`beginMultiLayerDrag` の preview transform を `translate() rotate()` 合成にして、ドラッグ中も回転が消えないように。

f. **回転ハンドルの Photoshop 書き戻し**: `lib.rs` の `LayerEdit` / `NewLayer` に `rotation: Option<f64>` 追加。`jsx_gen.rs` で payload に `rotation: N` を出力し、`applyToPsd` 内で各レイヤー処理の最後に `layer.rotate(rotation, AnchorPosition.MIDDLECENTER)` を呼ぶ（失敗は `addWarning` で継続）。既存レイヤーの delta（dx/dy）と同じく、incremental に累積する仕様（保存後リロードしないと意図と乖離する場合あり）。

### Undo / Redo / 全削除

g. **history インフラ（state.js）**: `state.history`（snapshot 配列）/ `historyIndex` / `historyTransientDepth` / `historyListeners` を追加。`HISTORY_MAX = 100`。`snapshotState()` は `{edits: Array, newLayers: Array, nextTempId}` をディープコピー、`restoreSnapshot(snap)` で復元時に存在しなくなった `selectedLayers.tempId` を自動破棄。
- 全 mutation 関数の末尾に `pushHistorySnapshot()` を埋め込み（`setEdit` / `addNewLayer` / `updateNewLayer` / `removeNewLayer`）。`addEditOffset` は `setEdit` 経由で 1 push。
- `clearPages()` 末尾で `resetHistoryBaseline()` を呼び、PSD 読込時に履歴を空状態（snapshot 1 件）にリセット。
- `beginHistoryTransient()` / `commitHistoryTransient()` / `abortHistoryTransient()` の depth カウンタで、ドラッグ中・複数選択一括編集中の連続更新を 1 件にまとめる。

h. **ヘッダー Undo/Redo/全削除 ボタン群**: `index.html` のズームの右に `.toolbar-history` グループ（MojiQ Pro と同じ SVG アイコン：戻り矢印・進み矢印・×丸）。`.toolbar-history` に `margin-left: -12px` で `.toolbar` の `gap: 12px` を打ち消し、左右の余白を対称化（`.toolbar-viewmode` と同方針）。`.history-btn:disabled` で 0.35 透過、`.clear-all-btn:hover` のみ `--danger` 色。
- ショートカット：`Ctrl+Z` で undo、`Ctrl+Y` または `Ctrl+Shift+Z` で redo、`Ctrl+Delete` で全削除（confirmDialog あり、文言は短く「現在の編集をすべて削除します。」）。`main.js` keydown ハンドラの環境設定 dispatch より前に hardcode（破壊的でないので固定キー）。
- `bindHistoryButtons` で `onHistoryChange` を購読し、disabled 状態 + `refreshAllOverlays` + `rebuildLayerList` を一括更新。

i. **ドラッグ中の連続更新を 1 件に集約**: `nudgeSelectedLayers` / `resizeSelectedLayers` / `beginRotateDrag` / `beginMultiLayerDrag.onUp` を `beginHistoryTransient()` … `commitHistoryTransient()` で囲み、ドラッグ 1 回 = 履歴 1 件。値変化なしのときは `abortHistoryTransient()`。`text-editor.js` の `commitStrokeFields` / `commitFillField` / レイヤー削除ボタンの一括 `removeNewLayer` も同様に batch 化。

### サイドパネル UI 改善

j. **セクション折りたたみ（h2 右の chevron）**: 各セクションを `<section class="panel-section" data-section="...">` で包み、`<h2 class="panel-section-h2">` を `flex` 行にして `<span>` ラベル + `<button class="section-toggle-btn">`（chevron-down SVG）を並置。`.panel-section.collapsed > *:not(.panel-section-h2) { display: none }` で本体を隠し、chevron は `.section-chevron { transition: transform 0.15s }` + `.collapsed .section-chevron { transform: rotate(180deg) }`。`.txt-source.collapsed` は `max-height: none; flex: 0 0 auto` で空き領域を作らないように。状態は `localStorage psdesign_panel_section_collapsed`（JSON `{txt, editor, layers}`）に永続化。

k. **テキストレイヤー削除ボタンを常時表示**: `text-editor.js` `updateDeleteButtonVisibility` を `hidden` から `disabled` 切替に変更。新規レイヤー選択なしのときは `opacity: 0.35; cursor: not-allowed` でグレーアウト。CSS で `.layer-delete-btn[hidden]` を撤去し `.layer-delete-btn:disabled` を追加。

l. **テキストレイヤーセクションを縦 flex で残り高さ占有**: `.panel-section[data-section="layers"]` に `display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0` を当て、`.layer-list-footer` に `margin-top: auto` を追加。レイヤー 0 件のときも削除ボタンが下端に固定される。

### 行間（leading）と行ごと leading override

m. **行間フィールド + ルビトグル**: `state.js` に `leadingPct: 125` + `getLeadingPct/setLeadingPct(50–500)/onLeadingPctChange` 追加。`addNewLayer` に `leadingPct` 引数追加（既定 125）。`clearPages` で 125 リセット。`index.html` のサイズとフチの間に「行間」フィールド（`[+] [input] % [-]`、`min=50` `max=500` `step=1`）+ ルビトグル（`なし` / `ルビ` の 2 段ボタン）。`main.js bindLeadingTool` でサイズツールと同じ pattern で配線、`+/-` で ±5%。
- ルビトグル active は leadingPct から導出：`>= 150` で「ルビ」active、それ未満は「なし」active。`+/-` ボタン or 手動入力で値変化しても highlight が追従。
- `canvas-tools.js renderOverlay` でプレビュー `inner.style.lineHeight` を leading から計算（既存：`edit.leadingPct/100`、なければ 1.05；新規：`nl.leadingPct/100`、デフォルト 1.25）。`layerRectForExisting` / `layerRectForNew` の厚み係数も `1.4` / `1.25` から `(leadingPct ?? 125) / 100` に置換し、行間広げで枠から見切れる問題を解消。
- Photoshop 書き戻し：既存 / 新規両方で `nti.autoLeadingAmount = leadingPct; nti.useAutoLeading = true;` を呼ぶ。

n. **行ごと leading override（in-place 編集中のカーソル行）**: `state.js` に `editingContext: {psdPath, layerId|tempId, currentLineIndex, totalLines}` 追加 + `setEditingContext` / `getEditingContext` / `onEditingContextChange`。各レイヤーに `lineLeadings: {[lineIndex]: pct}`（疎オブジェクト）追加 + `setLineLeading` / `getLineLeading` API。
- `canvas-tools.js createTextFloater` に `onCursorChange` / `onClose` コールバックを追加。`focus/keyup/click/input/select` イベントで `selectionStart` から行 index 算出。`startInPlaceEdit` 開始時に `setEditingContext(...)`、close 時に `setEditingContext(null)`。
- `main.js applyLeading(n)` を `editingContext` 有無で分岐：context あり → `setLineLeading(...)` で当該行 override に書込み、なし → 従来どおり layer 全体の `leadingPct`。`syncLeadingInputForEditingContext()` で input・ルビトグル・対象行ラベルを同期。
- in-place 編集 textarea のフォーカスを保ったまま行間調整できるよう、`bindGlobalBlurOnOutsideClick` の安全ゾーンに `.editor` を追加、`bindLeadingTool` の `+/-` / ルビボタンに `mousedown.preventDefault` を入れた。textarea 自身の blur ハンドラも `relatedTarget.closest(".editor")` のときは finalize しないように。
- `canvas-tools.js renderInnerText(inner, text, defaultPct, lineLeadings)` で `lineLeadings` がある場合のみ 1 行ずつ `<div>` に分けて per-line `line-height` を当てる（軽量経路は維持）。
- Photoshop 書き戻し：`jsx_gen.rs` HEADER に `cloneActionDescriptor` / `cloneActionList` / `applyLineLeadings` を追加。`executeActionGet` で textKey を取得し、1 つ目の textStyle をテンプレに各行 `from`/`to` の textStyleRange を構築、override がある行だけ `autoLeading=false; leading=fontSize × pct/100 pt`、無ければ `autoLeading=true`。textKey をディープクローンして `textStyleRange` だけ差し替え、`set` で書き戻し。

o. **編集パネルをタブ化（サイズ / 行間 / フチ）**: `index.html` の `#editor` 内、フォントの下を `.editor-tabs-section`（`.editor-tabs` + 3 つの `.editor-tab-panel`）に再構成。タブは `<button class="editor-tab" data-tab="size|leading|stroke">`。サイズ・行間タブには `data-editor-scope="single"` を付与し、複数選択時に自動で隠れる。`leading-target-label` は行間パネル内に移動。`text-editor.js setEditorTab(tab)` でタブ切替、`bindEditorTabs` で click 配線（`mousedown.preventDefault` で in-place 編集 textarea のフォーカス維持）。複数選択時は active が single-only なら `setEditorTab("stroke")` で自動切替。

### Photoshop 風ルーラー + ドラッグでガイド線

p. **`src/rulers.js` 新設**: PSD 表示領域の上/左に Photoshop と同じ目盛り付きルーラー帯を表示し、ドラッグでガイド線（cyan）を引ける機能。スコープは Phase A〜C（揮発、永続化なし）。
- データモデル：`Map<psdPath, {h: number[], v: number[]}>` を rulers.js 内部に閉じる（state.js を膨らませず undo/redo にも巻き込まない）。値は PSD pixel 座標。`localStorage` に保存するのは `rulersVisible` のフラグだけ（key: `psdesign_rulers_visible`）。
- 描画：ルーラー帯 = Canvas（HiDPI、`devicePixelRatio` で backing をスケール）、ガイド = `<div>` absolute（1 本 = 1 div、`pointer-events: auto`）。主目盛り間隔は `pickTickStep(pxPerPsd)` で `[1,2,5,10,20,25,50,100,200,250,500,1000,2000,2500,5000,10000]` PSD px の中から「主目盛りが画面 60〜120 CSS px ごとに来る」値を選択、副目盛りは 1/5。
- 回転対応：`axisMappingForRotation(rotation)` を 1 関数に集約し、`{topAxis: "x"|"y", topSign, leftAxis, leftSign}` を返す。ルーラー帯は画面の上/左に固定したまま、目盛り値だけ PSD 軸に応じて切替（Photoshop と同じビュー回転挙動）。
- 入力：上ルーラー mousedown → axis="h"（画面水平のガイド）、左ルーラー mousedown → axis="v"。ドラッグ中はガイド層にプレビュー線、mouseup で canvas 内なら `addGuide`、ルーラー帯内なら破棄。既存ガイドは本体ドラッグで `moveGuide` 連続更新、mouseup でルーラー帯に重なっていれば `removeGuide`（Photoshop と同じ削除 UX）。
- 再描画タイミング：`requestRulerRedraw()`（rAF debounce）に集約。`ResizeObserver`（pane / stage / topCanvas / leftCanvas）+ `#psd-stage` の `scroll` + `onPsdZoomChange` / `onPsdRotationChange` / `onPageIndexChange` + `MutationObserver(documentElement, {attributeFilter:["data-theme"]})` で発火。`spread-view.js` の `redraw()` 末尾でも `requestRulerRedraw()` を呼ぶ（DOM 全壊 → 再構築後の座標再投影）。
- Ctrl+R ショートカット：`settings.js DEFAULT_SETTINGS.shortcuts` に `toggleRulers: { key: "r", modifiers: ["ctrl"] }` 追加。`migrate()` がホワイトリストで穴埋めするので既存 settings は自動互換。`settings-ui.js` は `getAllShortcuts()` を全列挙する造りなので環境設定モーダルに自動で「定規の表示切替」が登場、別キーへのカスタマイズも可。
- WebView2 のリロード抑止：`bindRulerToggle` で `bindZoomTool` と同じく capture フェーズの keydown 内で `matchShortcut(e, "toggleRulers")` を判定して `preventDefault + stopPropagation`。
- DOM：`.spreads-psd-area > .psd-rulers > .psd-ruler-top + .psd-ruler-left + .psd-ruler-corner` と `.spreads-psd-area > .psd-guides-layer`。`.psd-rulers` は `position: absolute; top:0; left:0; width:100%; height:100%`（`inset:0` ショートハンドが Canvas 子の自動幅計算で安定しないため明示指定）、`.psd-ruler-top` は `width: calc(100% - var(--ruler-thick))` で明示幅。
- ルーラー有効時のレイアウト：`.spreads-psd-area.rulers-on { padding-top: var(--ruler-thick); padding-left: var(--ruler-thick) }` で content（`#psd-stage`）を ruler 厚ぶん押し出す。absolute 配置のルーラー帯は padding-box（border 内側）基準なのでパディング変化の影響を受けず、ペイン端 0px から ruler-thick まで密着して描画される。
- ライト/ダークテーマ追従：`getComputedStyle(documentElement).getPropertyValue("--text-muted" / "--panel" / "--border")` で Canvas 描画色を取得、`MutationObserver` で `data-theme` 変化を検知して再描画。

q. **回転ボタンを右下に移動**: `.pdf-rotate-btn` / `.psd-rotate-btn` を `top: 8px` から `bottom: 8px` に変更（PDF / PSD 両ペイン同時）。ルーラー帯と top/left の位置がぶつからない。

> **構造変更まとめ**:
> - 旧: 編集セクション = 縦並び（フォント / サイズ / 行間 / フチ）
> - 新: 編集セクション = フォントの下にタブ（サイズ / 行間 / フチ）、`.editor-tabs-section` + 3 panel
> - 旧: PSD 編集に undo/redo なし、ルーラー / ガイドなし
> - 新: history snapshot stack（max 100）+ ヘッダー Undo/Redo/全削除、Ctrl+R で Photoshop 風ルーラー + ドラッグガイド
> - 旧: 行間は 125% 固定（JSX 側）、UI で調整不可
> - 新: `state.leadingPct`（layer global）+ `lineLeadings: {[lineIndex]: pct}`（per-line override）、in-place 編集中のカーソル行で行ごと leading を変更可能、Photoshop には Action Manager で per-character leading として書き戻し
