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

## 最新セッション（定規ボタン移動 + 表示モード切替 + 立体感）

r. **定規ボタンをサイドツールバーへ移動**: トップツールバー `.toolbar-viewmode` から `#toggle-rulers-btn` を撤去し、サイドツールバーの `#tool-move`（選択ツール）の直下に再配置。`.icon-btn .side-tool-btn` クラスのみで、`.tool-btn` / `data-tool` は付けず（`applyActive` の相互排他選択に巻き込まれないようにするため）、`bindRulerToggle` 側で `aria-pressed` だけ ON/OFF を反映。**`.active` クラスは付与しない**（V/T/Y のような青塗りハイライトはルーラーには不要との要望、トグル状態は aria-pressed と実際のルーラー描画で十分判別可能）。

s. **PDF/PSD 並列 ⇄ PSD のみ 切替トグル**: ヘッダー左、ハンバーガーボタンの**直右**に 2 ボタンのセグメント型トグル（`.sync-segment .view-mode-segment`、既存の同期トグルと同じ視覚スタイルを再利用）を配置。左ボタン（2 つの長方形アイコン）= 並列、右ボタン（単独長方形アイコン）= PSD のみ。
- **state**: `state.parallelViewMode: "parallel" | "psdOnly"` + `getParallelViewMode` / `setParallelViewMode` / `onParallelViewModeChange` を追加（既存 `parallelSyncMode` と同形）。
- **挙動**: `bindParallelViewMode()` がクリックで `.spreads-pdf-area` の `hidden` 属性をトグル（既存の `.spreads-pdf-area[hidden] { display: none; }` ルールが効くので CSS 追加不要）。`psdOnly` に切り替わる瞬間に `getActivePane() === "pdf"` なら `setActivePane("psd")` で死状態（PDF にキー入力が向かい続ける）を回避。`parallelSyncMode` 自体は触らない（並列に戻したとき同期/非同期がそのまま維持される方が驚きが少ない、という設計判断）。
- **永続化**: `localStorage` キー `psdesign_parallel_view_mode`（"parallel" / "psdOnly"）。テーマ・ワークスペース反転と同方針。**PDF の document / pageIndex / pdfZoom / pdfRotation は `hidden` で隠すだけなので完全に保持され**、並列に戻すと切替前の状態でそのまま再表示される。
- **ルーラー / ガイドへの影響なし**: `.psd-rulers` / `.psd-guides-layer` は `.spreads-psd-area` 配下なので PSD のみ表示時もそのまま機能する。

t. **定規表示状態の永続化（実装済みであることを確認）**: `rulers.js` の `loadVisible()` / `saveVisible()` で `localStorage` キー `psdesign_rulers_visible`（"1" / "0"）を読み書き。モジュール load 時に `let rulersVisible = loadVisible();` で復元、`setRulersVisible` 内で値が変化した瞬間に save。`initRulers()` が `applyVisibilityToDom()` を呼んで DOM に反映するため、Ctrl+R で ON にしてからアプリ再起動すると ON のまま立ち上がる。**実装済みなので新規変更なし**、ユーザーから「動かない」と申告された場合の調査軸として：(1) dev / release で WebView2 の userData フォルダが別、(2) PSD 未読込時はルーラー描画対象がなく目盛りが見えないので OFF と勘違い、の 2 点を疑う。

u. **立体感のためのグラデーション**:
- **ヘッダーバー下端**: `.toolbar::after` に `border-bottom` 直上 10px の `linear-gradient(180deg, transparent → var(--section-fade))` を `position: absolute` で重ねる。`pointer-events: none` で操作非干渉、`.toolbar` 側に `position: relative` を追加して anchor を確立。
- **サイドバー各セクションの h2 ヘッダーバー内側**: `.panel-section-h2::after` で同型のグラデを 8px。トグルバーがボタン風に立体的に「上に乗っている」ように見える。`.panel-section-h2` に `position: relative` を追加。
- **CSS 変数 `--section-fade`**: ダーク `rgba(0, 0, 0, 0.28)` / ライト `rgba(0, 0, 0, 0.10)`。テーマ追従。

v. **サイドバーセクション本体を h2 より明るい背景に**: トグルバー（`.panel-section-h2`）は元の `var(--panel)` のまま、本体（`.panel-section` 全体）を `var(--panel-body)` に切替。
- **CSS 変数 `--panel-body`**: ダーク `#2c2c2d`（元 `--panel: #252526` よりやや明るい）、ライト `#f4f4f4`（元 `--panel: #ededed` よりやや明るい）。
- **効果**: h2 が一段濃く、内側の項目（txt-source-dropzone / editor / layer-list）が一段明るく見えるコントラストになり、h2::after グラデーションと組み合わせてトグルバーの立体感を増す。`.panel-section { background: var(--panel-body); } .panel-section-h2 { background: var(--panel); }` の 2 行で済む。

> **構造変更まとめ**:
> - 旧: 定規ボタン = ヘッダーの `.toolbar-viewmode` 内、`.active` 青塗りで状態表示
> - 新: 定規ボタン = サイドツールバー `#tool-move` 直下、`aria-pressed` のみで状態保持（背景色変化なし）
> - 旧: PDF / PSD 表示は常に並列、PDF を一時的に消す手段なし
> - 新: ハンバーガー右に並列 / PSD のみ トグル、`localStorage` 永続化、PDF 状態は隠している間も保持
> - 旧: サイドバー h2 とセクション本体は同じ `var(--panel)`、平面的
> - 新: h2 = `var(--panel)` + `::after` グラデ / 本体 = `var(--panel-body)`（明るめ）、ヘッダーバー（`.toolbar`）下端にも `::after` グラデ → セクションが「上に乗っている」立体感

## 最新セッション（Alt+ドラッグ複製・保存ダイアログ・ガイドロック・環境設定デフォルト等）

### A. テキストレイヤー編集 UX 強化

w. **Alt+ドラッグでレイヤー複製（Photoshop 互換）**: `canvas-tools.js beginMultiLayerDrag` 冒頭で `e.altKey` を判定。Alt 押下時は:
- `beginHistoryTransient()` を開始
- 各選択レイヤーの**同位置に複製を作成**（`new` 層: 全フィールドコピー / `existing` 層: layer + edit を merge して `addNewLayer` でフラットな new 層化、`lineLeadings` は別途 `updateNewLayer` で転写）
- `items` を複製群に差し替え、`setSelectedLayers(newSelections)` で選択も付替え、`renderOverlay` で即時可視化
- ドラッグ中は元のレイヤーは不動、複製がカーソルに追従
- `onUp` で常に `commitHistoryTransient()`（移動量ゼロでも複製は残す）→ Undo 1 回で複製ごと取消
- 視覚フィードバック: ドラッグ中 `document.body.style.cursor = "copy"`
- Shift+Alt の対応は見送り（Shift 単独 = 選択トグルが優先される現行挙動を維持）

x. **Delete / Backspace で選択中の追加テキスト削除**: `canvas-tools.js` に `deleteSelectedLayers()` を export。新規レイヤー（`tempId` を持つ）のみ `removeNewLayer` で削除し、既存 PSD 層は選択から外すだけ（PSD バイナリからの削除は edit モデル外）。`main.js` の keydown 早期判定（矢印 nudge と Ctrl+Delete の間）に挿入、修飾キーなしの Delete/Backspace のみ反応。INPUT/TEXTAREA/contentEditable では発火させず、in-place 編集 textarea の文字削除は引き続き有効。

### B. 文字サイズ表示の基準PSD換算

y. **`state.toDisplaySizePt(actualPt, page)` ヘルパー**: `getReferencePage()` で `state.pages[0]` を基準とし、物理高さ比 `(refHeight/refDpi) ÷ (pageHeight/pageDpi)` を実 pt に乗じて返す。基準と同一 / 未読込 / 不正値はそのまま素通し。**保存値（`exportEdits()` / JSX 出力）は実 pt 不変**で Photoshop 互換を維持し、表示層だけ換算。
- 表示適用箇所:
  - `canvas-tools.js createSizeBadge(sizePt, page)` — 引数に `page` を追加し換算後 pt をバッジ表示
  - `text-editor.js formatDisplayPt(actualPt, page)` ヘルパーで rebuildLayerList の既存・新規レイヤー両方の pt 文字列を換算
- 入力欄（`#size-input`）と内部保存値はすべて実 pt のまま

### C. 保存完了通知をモーダルダイアログに

z. **`ui-feedback.js notifyDialog`**: 既存 `#confirm-modal` DOM を流用し、Cancel ボタンを一時的に `hidden` で隠して単一 OK ボタンのモーダルに転用。`Promise<void>` を返し OK / Esc / Enter / 背景クリックで dismiss。cleanup で Cancel ボタンの hidden 状態を復元するため、後続の `confirmDialog` 呼び出しに副作用なし。
- `main.js runSaveWithMode` の保存成功パスの `toast(...)` を `await notifyDialog(...)` に置換。タイトルは「保存完了」（警告含む結果は「保存完了 ⚠ 警告あり」）。`hasSavedThisSession = true` はダイアログ前に立てる。失敗パスは toast のまま維持。

### D. JSX 新規テキスト配置の位置補正（縦書きアンカー差を解消）

A1. **`textItem.position` のアンカー差補正**: PsDesign 側の `nl.x/nl.y` は bounding-box top-left を意図するが、Photoshop の `textItem.position` は「テキストアンカー」（横書き＝ベースライン左、縦書き＝1 文字目の右上）。`jsx_gen.rs` の `applyToPsd > newLayers` ループで position 設定後に `layerRef.bounds` を読み、direction で分岐:
- **横書き**: `bounds.top-left` を `(nl.x, nl.y)` に揃えるよう translate。
- **縦書き** (`vertical-rl`): `bounds.top-right` を `(nl.x + thick − halfLeading, nl.y)` に揃える。`thick = ptInPx × leadingFactor × lineCount`（editor 側 `layerRectForNew` と同じ式を JSX 内で再計算、`doc.resolution` から DPI 取得）。
- **`halfLeading` の係数調整**: 理論値 `(L − 1) × em / 2` は実機ブラウザの `vertical-rl` line-box（font intrinsic line-gap を加味した拡大幅）と合わず、empirical 反復で `(L − 1) × em × 1`（full extra）に確定。24pt/600dpi/125% 行間の場合 50px 内側にインセット。
- 補正は direction 分岐内で `_fixDx` / `_fixDy` を計算し、`layerRef.translate(...)` で 1 回適用。

### E. Ctrl+H でテキストフレーム表示切替（InDesign 風）

A2. **`framesVisible` 状態 + `toggleFrames` ショートカット**: `state.js` に `framesVisible: true` + `getFramesVisible / setFramesVisible / toggleFramesVisible / onFramesVisibleChange`。`settings.js DEFAULT_SETTINGS.shortcuts` に `toggleFrames: { key: "h", modifiers: ["ctrl"] }` 追加（環境設定 UI でカスタマイズ可）。
- `main.js bindFramesToggle()`: capture フェーズで `matchShortcut(e, "toggleFrames")` を判定し `preventDefault + stopPropagation`（ブラウザ既定の Ctrl+H = 履歴表示を抑止）。トグル時は `document.body.classList.toggle("frames-hidden", !getFramesVisible())` だけ走らせ、DOM は再描画しない（ドラッグ中等の状態を破壊しない）。
- **`styles.css frames-hidden` ルール**: `body.frames-hidden .layer-box:not(.selected)` で border / background / box-shadow を transparent 化。`:not(.selected)` で**選択中レイヤーは装飾を維持**（pt サイズバッジと回転ハンドルは元から「選択中のみ DOM 生成」なので CSS 条件不要）。テキスト本体（`.new-layer-text` / `.existing-layer-text`）は影響なし。`runShortcut` にも `case "toggleFrames"` を追加。

### F. ガイドロック機能 + ボタン

A3. **`rulers.js guidesLocked` 状態**: localStorage 永続化（key: `psdesign_guides_locked`）+ `getGuidesLocked / setGuidesLocked / toggleGuidesLocked / onGuidesLockedChange`。`applyLockedToDom()` で `.spreads-psd-area` に `guides-locked` クラスを付与。
- **ガード**: `beginCreateGuide` と `beginMoveGuide` の冒頭で `if (guidesLocked) { e.preventDefault(); e.stopPropagation(); return; }`。preventDefault と stopPropagation は**必須**（省略するとブラウザの mousedown 既定動作でテキスト選択が開始され、下層のテキストフレーム上を通過したカーソルが「テキストにカーソルが入って固まる」現象を起こす）。
- **`#psd-guides-lock-btn`（index.html）**: `#psd-rotate-btn` の直前に挿入。開いた錠 / 閉じた錠の 2 種類の SVG を `.lock-icon-unlocked` / `.lock-icon-locked` に分け、CSS で `aria-pressed` に応じて `display` を切替。`right: 44px`（回転ボタン 28px + 8px ギャップぶん左隣）。`aria-pressed="true"` でアクセント色塗り。
- **`main.js bindPsdGuidesLock()`**: クリックで `toggleGuidesLocked()`、`onGuidesLockedChange` で `aria-pressed` / `title` / `aria-label` を更新。`onRulersVisibleChange` 購読で**ガイド表示と連動して表示/非表示**を切替。`updatePsdGuidesLockVisibility()` を `bindPsdRotate / loadPsdFilesByPaths / schedulePageRender` 各タイミングで併呼。

### G. 縦ルーラーの目盛り表示バグ修正

A4. **`rulers.js drawRulerOnCanvas` の clip 範囲修正**: 副目盛り・主目盛りの clip 判定 `if (lp < -2 || lp > w + 2) continue;` で**縦ルーラー側でも `w`（横幅 18px）を使っていた**ため、Y 座標が 20px を超える tick が全 skip されていた。
- `along = side === "top" ? w : h`、`across = side === "top" ? h : w` で**主軸方向 / 直交方向**を分離し、clip は `along` で、tick 長さ計算は `across × 0.6 / 0.3` で行うように修正。ラベル offset も `across` を使う。横ルーラーは挙動変化なし、縦ルーラーで全範囲に副目盛り・主目盛り・数値ラベルが描画されるようになった。

### H. 環境設定の刷新

A5. **「デフォルト」タブ追加（新規テキストの初期値設定）**:
- **`settings.js`**: `DEFAULT_SETTINGS.defaults = { textSize: 12, leadingPct: 125, strokeWidthPx: 20, fontPostScriptName: "" }` を追加（`version: 2` に bump）。`migrate()` で旧バージョンの defaults を保全。新 API: `getDefaults / getDefault / setDefault / resetDefaults`。
- **`state.js applyToolDefaults()`**: 設定の defaults を `setTextSize / setLeadingPct / setStrokeWidthPx / setCurrentFont` 経由でツール状態に反映。`clearPages()` 内のハードコード `setStrokeWidthPx(20); setLeadingPct(125);` を撤去し本ヘルパー呼出に置換。state.js が settings.js を import（一方向、循環なし）。
- **`main.js`**: `initSettingsUi()` 直後に `applyToolDefaults()` を呼出 → 起動時に保存値がツール初期値に。
- **`index.html`**: `<button data-tab="defaults">デフォルト</button>` タブ + パネル（文字サイズ pt / 行間 % / フチ太さ px / フォント datalist）+ 「デフォルトに戻す」ボタン。
- **`styles.css`**: `.settings-defaults-list / .settings-default-row / .settings-default-label / .settings-default-input` を追加。
- **`settings-ui.js`**: `syncDefaultsUi()` で値反映、`populateFontDatalist()` で `getFonts()` から PostScript 名を datalist に流し込み（`onFontsRegistered` 購読で非同期登録に追従）。`bindDefaultsInputs()` で各入力の `change` を `setDefault` 保存 → `applyToolDefaults()` で即座にツール状態反映。

A6. **タブ等幅化**: `.settings-tab` に `flex: 1 1 0; text-align: center; white-space: nowrap;` を追加 → 「ショートカット」「ページ送り」「デフォルト」が同じ幅で並ぶ。

A7. **ダイアログサイズ固定 + × → 完了ボタン化**:
- `.settings-card` に `height: 80vh; min-height: 500px;` を追加 → タブ切替でダイアログサイズが揺れない。
- `.key-capture-card` に `height: auto; min-height: 0;` を override で逆指定（小ダイアログのまま維持）。
- `index.html`: `#settings-close-btn` を SVG × アイコンから `<button class="settings-done-btn">完了</button>` に置換（ID は維持して JS 配線は無変更）。
- `styles.css`: `.settings-done-btn` を accent 塗りの primary ボタン風に。旧 `.settings-close-btn` ルールは撤去。

### I. アイコン刷新

A8. **PSD / TXT ボタンを「形状 + 種別ラベル」に統一**: index.html の 3 つの open ボタンと `spread-view.js` の空状態アイコン、`#txt-source-empty-icon` を以下のデザインに揃え:
- **PSD 系（フォルダ + 「PSD」テキスト）**: `#open-folder-btn` + `.spreads-empty-icon`。複数ファイル開く操作なのでフォルダ形状。
- **PDF 系（ファイル + 「PDF」テキスト）**: `#open-pdf-btn`。既存スタイルを維持。
- **TXT 系（ファイル + 「TXT」テキスト）**: `#open-txt-toolbar-btn` + `#txt-source-empty-icon`。単一ファイルなのでファイル形状。
- 全て `viewBox="0 0 24 24"` に統一、`<text>` は `font-size="7"` `text-anchor="middle"` `font-family: sans-serif; font-weight: 700;`。

A9. **ツールバー open ボタンとセーブボタンの大型化**: `index.html` の `#open-pdf-btn / #open-folder-btn / #open-txt-toolbar-btn / #save-btn` に **`file-open-btn`** クラス追加。SVG 幅を 18→**22**px に。`styles.css` に `.icon-btn.file-open-btn { width: 38px; height: 32px; min-width: 38px; }` + `svg { width: 22px; height: 22px; }`。他の `.icon-btn`（undo/redo/zoom 等）には影響しない。

### J. ウインドウコントロール hover 修正

A10. **最小化・最大化ボタンの青塗り抑止**: `styles.css` のグローバルルール `button:hover:not(:disabled) { background: var(--accent); ... }`（specificity 0,2,1）が `.window-ctrl-btn:hover` (0,2,0) を上書きしていたため青塗りになっていた。`.window-controls .window-ctrl-btn:hover:not(:disabled)`（0,3,1）で override し `background: rgba(0, 0, 0, 0.18)` に変更（半透明黒オーバーレイ → 現在の背景から少し濃くなる、ライト/ダーク両テーマで自然追従）。閉じるボタンの hover も同 specificity で `#e81123` に維持し、border も赤に揃えて青の漏れを防止。

> **構造変更まとめ**:
> - 旧: 新規テキスト配置の位置と Photoshop 保存後の位置がアンカー差でずれる、複製手段なし、フレーム ON/OFF なし、ガイドロックなし
> - 新: Alt+ドラッグで複製、Ctrl+H でフレーム ON/OFF（InDesign 風 = テキストは残す）、ガイドロックボタン（ガイド表示と連動）、保存完了は中央モーダル
> - 旧: 文字サイズ pt は実値直表示、新規テキストの初期値はハードコード
> - 新: 基準PSD（最初の読込）に対する物理高さ比で表示換算、環境設定「デフォルト」タブで初期値カスタマイズ
> - 旧: 縦ルーラーの目盛りが描画されない（clip range バグ）、JSX 縦書き保存位置が右ズレ、ウインドウコントロール hover が青
> - 新: 縦ルーラー全範囲に目盛り、JSX で empirical halfLeading=`(L-1)×em` で位置一致、最小化・最大化は半透明黒 hover

---

## v1.1.0: AI セリフ自動抽出 (mokuro 統合)

### 概要

Tauri アプリ `serifu-memo` (Ina986/serifu-memo v0.1.1) を本体に統合。漫画 PDF / 画像から吹き出しテキストを `manga-ocr` + `comic-text-detector` (mokuro パイプライン経由) で自動抽出し、結果を既存の TXT パネルに流し込む。AI モデルのインストールは「AIインストール」ボタンから明示的に行う設計。

### ユーザー設計判断 (確定)

- **内部実装は mokuro 維持** — UI 上は `comic-text-detector` と `manga-ocr` を 2 モデル表示する
- **OCR トリガ**: TXT パネル内の「AIで読み取り」ボタン (`#ai-ocr-btn`)
- **AI インストールボタン**: ハンバーガーメニュー footer (`#ai-install-btn`)
- **UI 技術**: React は持ち込まず、既存の Vanilla JS + `ui-feedback.js` パターンに統一

### 主な追加ファイル

**Rust 側**
- [src-tauri/src/ocr.rs](src-tauri/src/ocr.rs) — serifu-memo 由来。コマンド `check_ai_models` / `install_ai_models` / `run_ai_ocr` / `export_ai_text` を提供。元の `setup_mokuro_runtime` 等から rename 済
- [src-tauri/scripts/install-ai-models.ps1](src-tauri/scripts/install-ai-models.ps1) — Python 3.13 embeddable + pip + comic-text-detector / manga-ocr / mokuro / PyTorch CUDA を `%LOCALAPPDATA%\PsDesign\ai-runtime\` にセットアップ
- [src-tauri/resources/pdfium/pdfium.dll](src-tauri/resources/pdfium/pdfium.dll) — PDF を 300 DPI で JPEG 化するための pdfium-render バイナリ

**フロント側**
- [src/normalize.js](src/normalize.js) — テキスト正規化 (三点リーダー集約 + 置換ルール、localStorage キー `psdesign-ai-normalize-v1`)
- [src/ai-install.js](src/ai-install.js) — Vanilla 版セットアップウィザード。Phase 検出 / pip 進捗パース / 速度・ETA 表示
- [src/ai-ocr.js](src/ai-ocr.js) — OCR 実行 → MokuroDocument → ページマーカー付きテキスト → TXT パネル流し込み
- [src/txt-source.js](src/txt-source.js) に `loadTxtFromContent(name, content)` を追加 (AI OCR 結果の流し込み口)
- [index.html](index.html) — `#ai-ocr-btn` (TXT パネル下) / `#ai-install-btn` (ハンバーガー footer) / `#ai-install-modal` を追加
- [src/styles.css](src/styles.css) — `.ai-install-card` / `.ai-phase-list` / `.ai-meta-badge` / `.ai-log-viewer` 等の専用スタイル末尾追加

### 統合元から「明示的に変更してから移植した」点

- **Phase 4 を 3 段に分割** — `setup-mokuro-runtime.ps1` は `pip install mokuro` 一発だったが、`install-ai-models.ps1` では `Phase 4a. comic-text-detector` (依存ライブラリ群を先行 install) → `Phase 4b. manga-ocr` → `Phase 4c. mokuro` の 3 段。pip キャッシュにより重複ダウンロードは発生せず、UI の 2 モデル表示が「演出」ではなく実際の進捗反映になる
- ランタイム配置先: `serifu-memo/mokuro-runtime` → `PsDesign/ai-runtime`
- Tauri コマンド rename: `setup_mokuro_runtime` → `install_ai_models`、`check_mokuro_runtime` → `check_ai_models`、`run_mokuro` → `run_ai_ocr`、`export_text_memo` → `export_ai_text`
- イベント rename: `setup:*` → `ai_install:*`、`mokuro:*` → `ai_ocr:*`
- localStorage キー: `serifu-memo-normalize-v1` → `psdesign-ai-normalize-v1`

### 依存追加

**Cargo.toml**
- `pdfium-render = "0.8"` (PDF → JPEG 変換)
- `image = "0.25"` (画像エンコード)
- `tauri-plugin-fs = "2"`
- `[profile.dev.package.pdfium-render] opt-level = 3` / `[profile.dev.package.image] opt-level = 3`

**capabilities/default.json**
- `core:event:default` (Tauri イベント emit/listen)
- `dialog:allow-save` (将来の TXT 保存ダイアログ用)
- `fs:default`

**tauri.conf.json**
- `bundle.resources` に `resources/pdfium/pdfium.dll` と `scripts/install-ai-models.ps1` を追加

### 主要イベント仕様

| イベント | ペイロード | 発行元 |
|---|---|---|
| `ai_install:start` | `string` (target dir) | Rust `install_ai_models` |
| `ai_install:log` | `{ line, stream: "stdout"\|"stderr" }` | Rust |
| `ai_install:done` | なし | Rust |
| `ai_ocr:start` | `string` (volume name) | Rust `run_ai_ocr` |
| `ai_ocr:log` | `{ line, stream }` | Rust |
| `ai_ocr:progress` | `{ phase: "pdf"\|"ocr", current, total }` | Rust |

### UI フロー

1. ハンバーガーメニュー → 「AIインストール」 (`#ai-install-btn`)
2. モーダル `#ai-install-modal` 展開 → ステータスバッジで現状確認
3. 「インストール開始」押下 → `install_ai_models` 起動
4. Phase 検出ロジックが PowerShell ログから `base / ctd / mocr / torch` の 4 グループを順に active → done
5. pip ログから `parseDownload()` でダウンロード速度・ETA を抽出 → 250ms 間隔で再描画
6. 完了 → ハンバーガーの赤バッジが消え、TXT パネルの「AIで読み取り」が利用可能に
7. PDF を開いた状態で「AIで読み取り」 → `run_ai_ocr` → MokuroDocument → `mokuroDocToText()` で `<<NPage>>` 区切り COMIC-POT 形式に整形 → `loadTxtFromContent()` で TXT パネルへ流し込み

### 触らなかった既存機能

- 並列 PDF / PSD ビューア (`spread-view.js` / `pdf-loader.js` / `psd-loader.js`)
- Photoshop ExtendScript 経由の編集適用 (`photoshop.rs` / `jsx_gen.rs`)
- フォント列挙 (`fonts.rs`)
- 既存ショートカット・ページ送り・テキストツール (V/T/Y)・ガイド・ルーラー

---

## v1.2.0: 吹き出し検出 × TXT 自動配置

### 概要

v1.1.0 の `MokuroDocument`（comic-text-detector の吹き出し座標 + manga-ocr の OCR テキスト）を活用し、ユーザー保有の正準スクリプト (TXT、`<<NPage>>` マーカー付) を PSD の吹き出し位置に自動で配置する機能を追加。手作業の「ブロック選択 → 吹き出し位置クリック」を全ページ自動化する。

### 設計判断 (確定)

- **トリガー**: TXT パネル内、「画像スキャン」ボタンの右隣の **「自動配置」ボタン** (`#ai-place-btn`、lucide `wand-sparkles` アイコン)
- **確認フロー**: 確認モーダル (件数サマリ表) → `addNewLayer()` 一括 → `state.newLayers` に積まれて in-app overlay に即時表示 → ユーザーが目視確認 → 既存 Ctrl+S で Photoshop 保存
- **件数不一致**: シーケンス順に `min(TXT, 吹き出し)` 件を 1:1 配置、余りはモーダル右下の合計サマリと状態列に表示
- **フォントサイズ**: ツール状態 (`getCurrentFont() / getTextSize() / getLeadingPct() / getStrokeColor() / getStrokeWidthPx() / getFillColor()`) を全レイヤーに一括適用 — 予測可能な UX を優先し、mokuro の `font_size` 検出値は使わない
- **Rust 側変更ゼロ**: 既存の `addNewLayer` → `apply_edits_via_photoshop` パイプラインをそのまま流用

### 主な追加・変更ファイル

| 区分 | ファイル |
|---|---|
| 新規 | [src/ai-place.js](src/ai-place.js) — 自動配置メイン (sort / map / buildPlan / showReviewModal / applyPlan) |
| 改修 | [src/state.js](src/state.js) — `aiOcrDoc` スロット + `getAiOcrDoc / setAiOcrDoc / clearAiOcrDoc`、`clearPages` 連動 |
| 改修 | [src/ai-ocr.js](src/ai-ocr.js) — OCR 完了時に `setAiOcrDoc(doc, sourcePath)` 保存、外部から呼べる `runAiOcrForFiles()` を export |
| 改修 | [src/txt-source.js](src/txt-source.js) — `parsePages` を export 化 |
| 改修 | [src/main.js](src/main.js) — `bindAiPlaceButton()` を init に追加 |
| 改修 | [index.html](index.html) — `#ai-place-btn` (TXT パネル) + `#ai-place-review-modal` (body) |
| 改修 | [src/styles.css](src/styles.css) — `.ai-place-btn` / `.ai-place-review-modal` / `.ai-place-review-table` / `.ai-place-status-{ok,warn,error}` |
| バージョン | `package.json` / `Cargo.toml` / `tauri.conf.json` 全て **v1.2.0** |

### コアロジック

**1. 読み順ソート (縦書き漫画: 右上 → 左下)** — `sortBlocksMangaOrder(blocks)`
- y-中心が近いブロックを行クラスタに束ねる (バンド = 平均ブロック高 × 0.5)
- 行は上→下、行内は右→左
- 横書き混在時もこの順序が漫画読み順と整合

**2. 1:1 シーケンス割当**
- `min(txt.length, sortedBubbles.length)` 件を順番にペアリング
- 余り TXT / 余り吹き出しは確認モーダルの状態列に表示

**3. NewLayer 変換** — `mapBlockToNewLayer(block, mokuroPage, psdPage, contents, defaults)`

`canvas-tools.js` の `placeTxtSelectionAt` + `centerTopLeft` + `layerRectForNew` と完全に同じ手順で「クリック位置 = bubble 中心」のセマンティクスを再現する:
```
sx = psdPage.width  / mokuroPage.img_width
sy = psdPage.height / mokuroPage.img_height
direction = block.vertical ? "vertical" : "horizontal"
// (1) bubble bbox 中心 → PSD 座標
cx = ((box[0] + box[2]) / 2) * sx
cy = ((box[1] + box[3]) / 2) * sy
// (2) estimateLayerSize() で文字サイズ・行数・行間からレイヤー矩形 (thick / long) を算出
//     thick = max(24, ptInPsdPx * leadingFactor * lineCount)
//     long  = min(maxLong, max(ptInPsdPx*2, ptInPsdPx*1.05*chars))
//     vertical: width = thick, height = long
//     horizontal: width = long,  height = thick
// (3) top-left を中心合わせ (centerTopLeft の式)
x = cx - width  / 2
y = cy - height / 2
```
nl.x / nl.y は jsx_gen.rs:589-625 が期待する **vertical/horizontal とも bounding-box top-left**。縦書きの右端基準補正 (`_boxRight = nl.x + thick - halfLeading`) は JSX 側が自動で行う。

**4. 確認モーダル** — `#ai-place-review-modal`
- 表構成: ページ / PSD ファイル名 / 吹き出し数 / TXT ブロック数 / 配置数 / 状態
- 状態色分け: `✓ 一致` (緑) / `⚠ TXT 余` `⚠ 吹き出し余` (オレンジ)
- フッター: 配置予定合計 + 余り件数 + 「キャンセル / 配置を実行」ボタン
- Esc キャンセル / Enter 確定 / 背景クリックでキャンセル

**5. 配置適用** — `applyPlan(plan)`
- 各 NewLayer を `addNewLayer()` でストアに積む → `pushHistorySnapshot()` 自動発火 (Undo 可能)
- `renderAllSpreads()` + `rebuildLayerList()` を呼び in-app プレビューに即反映
- ユーザーは spread-view 上で位置・テキストを確認、必要なら手動微調整 → Ctrl+S で Photoshop 書き出し

### OCR キャッシュ寿命

OCR 結果 (`state.aiOcrDoc = { doc, sourcePath }`) は **PDF (sourcePath) に紐付く** ものとして扱う。

- `clearPages()` (PSD フォルダ切替) では **キャッシュを消さない**。OCR は PSD ではなく PDF に対して行ったものなので PSD を入れ替えても結果は有効
- 自動配置押下時に `ai-place.js` 側で `cache.sourcePath === getPdfPath()` を比較し、**一致するなら絶対に再 OCR しない**
- PDF を別ファイルに切り替えた / 何も開いていない状態 → sourcePath 不一致で自動再スキャン
- 結果として「画像スキャン → 自動配置」を同一 PDF で繰り返す通常フローでは OCR は 1 回しか走らない

### エッジケース

- **OCR キャッシュなし or sourcePath 不一致**: `runAiOcrForFiles([currentPdf])` を自動呼び出して画像スキャン → 完了後そのままマッチングへ進行
- **TXT / PSD 未読込**: `notifyDialog` で個別に案内し中断 (ボタン自体は disabled にしない)
- **PSD 数 ≠ OCR ページ数**: `min(N, M)` まで処理、末尾サマリで「PSD K 枚は OCR 結果なし」「OCR K ページは PSD なし」を表示
- **空ページ (吹き出し 0 件)**: 配置なし、状態列に「⚠ 吹き出しなし」
- **PDF と PSD のキャンバス比率不一致 (bleed 込み PSD vs trim のみ PDF など)**: 単純なスケール比 (`psd.w/img.w`) では補正できず、配置位置が一定オフセット分ずれる。現状は PDF を PSD と同じトンボ込み寸法で書き出してもらう運用前提。トンボ位置を使った自動補正は将来の拡張
- **ルビ表記 `親（ふりがな）`**: TXT に含まれていれば contents にそのまま流す (text-editor のレンダリングに依存)

### v1.2.0 リリース後のバグ修正 (2026-04-28 追記)

実機テストで以下を発見・修正:

1. **モジュール読み込み失敗で全ボタン無反応** ([src/ai-place.js](src/ai-place.js)): `getTxtSource` を `txt-source.js` から import していたが、実エクスポート元は `state.js` のみ。Vite が `SyntaxError: does not provide an export named 'getTxtSource'` を投げ、main.js のチェーンが ESM 段階で失敗 → `addEventListener` が一切登録されない症状。`disabled` 既定だった他ボタンはグレーアウトのまま、disabled 未指定だった「自動配置」だけ見た目クリック可能だが何も起きない、という分かりにくい挙動になっていた。修正: import を `state.js` に統一
2. **OCR の重複実行** ([src/state.js](src/state.js) + [src/ai-place.js](src/ai-place.js)): `clearPages()` で `clearAiOcrDoc()` を呼んでいたため、PSD フォルダの再読込で OCR キャッシュが消失して自動配置押下時に毎回再 OCR が走っていた。修正: clearPages から削除し、ai-place.js 側で `sourcePath` と現在の PDF を比較してキャッシュ有効性を判定
3. **vertical テキストの位置ズレ** ([src/ai-place.js](src/ai-place.js) `mapBlockToNewLayer`): bbox の右端 (`box[2]`) を nl.x として渡していたが、`jsx_gen.rs:589-625` の仕様は **vertical/horizontal とも nl.x = bbox top-left** を要求 (縦書きの右端基準補正は JSX 側が `nl.x + thick` で自動算出)。さらに既存ツール `canvas-tools.js:639 placeTxtSelectionAt` は **「クリック位置 = bubble 中心」 → centerTopLeft で width/2 を引いて top-left に変換** するセマンティクス。修正: bubble 中心を計算 → `estimateLayerSize()` (canvas-tools.js の `layerRectForNew` と同一式) でレイヤー矩形を推定 → `nl.x = cx - width/2`, `nl.y = cy - height/2` で中心合わせに統一

### Verification

1. `npm run tauri dev` で起動。既存機能 (画像スキャン / AIインストール / V/T/Y ツール / Photoshop 保存) にリグレッションがないこと
2. 1 PDF + 同名 PSD + 各ページ吹き出し数と一致した TXT を読み込み → 「自動配置」 → 確認モーダル「✓ 一致」 → 「配置を実行」 → spread-view に新規テキストレイヤーが正しい位置 (吹き出し内) に出現
3. Ctrl+S で Photoshop が起動し、PSD に新規テキストレイヤーが書き込まれる
4. 不一致ケース (TXT 過多) で一致分のみ配置 + モーダルに余り表示
5. OCR キャッシュなしで押下 → 画像スキャンが自動実行 → 配置に進む
6. PSD/TXT 未読込で押下 → notifyDialog で適切に中断
7. バージョン同期: `package.json` / `Cargo.toml` / `tauri.conf.json` がすべて `1.2.0`

---

## 最新セッション（OCR 進捗・AI ボタン UX・見本ファイル拡張）

### A. OCR プログレスバーの停滞解消

A1. **mokuro tqdm の `\r`-only 出力を行として yield する** ([src-tauri/src/ocr.rs](src-tauri/src/ocr.rs)): 旧実装は `BufReader::lines()`（`\n` 区切り）で stdout/stderr を読んでおり、tqdm が `\r` だけでバーを refresh するため **mokuro が exit するまで一行も yield されず、UI 上は OCR フェーズに入ったまま「PDF 展開中… 10/10」で固まり、終了の瞬間に一気に 100% へジャンプ**していた。`read_chunks_cr_lf<R, F>(reader, on_line)` を追加してバイトを直接バッファ読みし、`\n` / `\r` のいずれを区切りとしても chunk を on_line に送るよう変更。これで tqdm の 10Hz 更新がそのまま `ai_ocr:progress` イベントとして UI に流れる。`install_ai_models` の reader は PowerShell 出力 (`\n` 終端) なので `BufReader::lines()` のまま。

A2. **tqdm `[time<eta]` を抜き出して送信** ([src-tauri/src/ocr.rs](src-tauri/src/ocr.rs)): `parse_mokuro_progress` の戻り値を `(u32, u32)` → `(u32, u32, Option<String>)` に拡張、`segment` 内の `[...]` を rfind して eta 文字列をそのまま送る。`ProgressEvent` に `eta: Option<String>` を追加（`#[serde(skip_serializing_if = "Option::is_none")]`）。PDF 展開フェーズの emit 全箇所も `eta: None` で揃える。

A3. **無音時間の埋め合わせと ETA 表示** ([src/ai-ocr.js](src/ai-ocr.js)): `phase` を `"pdf"` / `"starting"` / `"ocr"` の三状態管理に変更。
- `ai_ocr:start` listener を新設 → 「OCR エンジンを起動中…」+ indeterminate
- `ai_ocr:log` listener で `detectStartupPhase(line)` をかけ、`text detection model` / `OCR model` / `Processing volume` を検知して「テキスト検出モデルを読み込み中…」「OCR モデルを読み込み中…」「ボリュームを処理中…」を順に出す（`phase === "ocr"` 入り後はログ更新スキップ＝tqdm 進捗を上書きしない）
- 進捗 detail を `OCR 実行中… ${current}/${total}` の形式に変更し、`p.eta` があれば `formatEta` で `00:30` → `30秒` / `01:20` → `1分20秒` に整形して付記

### B. 自動配置ボタンの UX 強化

B1. **PSD 未読込時の自動 PSD 読込** ([src/ai-place.js](src/ai-place.js)): 旧挙動は notifyDialog で「先に PSD フォルダを開いてください」と止めていたが、`runAutoPlace` 冒頭の PSD 未読込分岐を **動的 import で `main.js` の `pickPsdFiles()` / `loadPsdFilesByPaths()` を呼び出し、ファイル選択 → 読込 → そのままプラン構築〜確認モーダルへ進行** という直列フローに変更。`main.js ↔ ai-place.js` の循環参照は静的 import では `bindAiPlaceButton` が読めなくなるため、`ai-place.js` 側を `await import("./main.js")` で動的 import に。`pickPsdFiles` / `loadPsdFilesByPaths` を [src/main.js](src/main.js) で `export` 化（モジュール内 `let hasSavedThisSession` 等の closure 状態は維持されるため挙動不変）。

B2. **OCR 結果が無いうちは自動配置ボタンをグレーアウト** ([src/state.js](src/state.js) + [src/ai-place.js](src/ai-place.js)): state に `aiOcrDocListeners: new Set()` を追加、`setAiOcrDoc` / `clearAiOcrDoc` で listener を発火（`clearAiOcrDoc` は冪等化：既に null なら notify せず）、`onAiOcrDocChange(fn)` を export。`bindAiPlaceButton` で listener 購読し、`getAiOcrDoc()?.doc?.pages?.length > 0` を `disabled` 反転条件に。tooltip も「先に画像スキャンを実行してください」⇄「OCR 結果と原稿テキストを吹き出し位置に自動配置」で切替。OCR 中（`run_ai_ocr` 実行中）は `setAiOcrDoc` まだ呼ばれていないので disabled のまま、失敗時も維持される。

B3. **画像スキャンボタンと配色・配置を統一** ([src/styles.css](src/styles.css)): `.ai-place-btn` の `background` を `var(--accent)` → `var(--panel-hover)`、`border` を `var(--accent)` → `var(--border)`、`color` を `#fff` → `var(--text)`、hover 時に accent 反転。`margin-top: 4px` → `6px`、`margin-left: 6px` 削除で画像スキャンの真下に左揃え。

### C. 「見本」ファイルの拡張（JPEG/PNG + 複数ファイル）

C1. **PDF アイコンを Comic-Bridge の TIFF 化アイコン（lucide-react `FileImage`）に統一**: ツールバー `#open-pdf-btn` のラベルを「見本を読み込み」に変更し、SVG を `FileImage` の 4 パス（書類 + 画像枠 + 丸 + 折れ線）に置換。`<text>PDF</text>` 内蔵ラベルは廃止。`pdf-view.js` の空状態 / out-of-range 両方の `pdf-empty-icon` も同じ FileImage に統一。実 SVG パスは `node_modules/lucide-react/dist/esm/icons/file-image.js` の `__iconNode` から直接コピーして Comic-Bridge と完全同形に。

C2. **`#open-pdf-btn` を JPEG / PNG 対応に** ([src/pdf-loader.js](src/pdf-loader.js)): 旧 `pickPdfFile` のフィルタを `pdf` → `pdf, jpg, jpeg, png` に拡張、ダイアログタイトルを「見本を読み込み」に。`REFERENCE_EXTENSIONS` / `REFERENCE_EXT_REGEX` / `IMAGE_EXT_REGEX` を export 定義。
- **`makeImagePage(bitmap)`**: ImageBitmap を pdfjs Page 互換オブジェクトに包む。`getViewport({scale, rotation})` で 90/270° 回転時に幅高さ swap、`render({canvasContext, viewport})` で viewport 中心起点に `ctx.translate / ctx.rotate` → ネイティブ寸法で `drawImage` 中央配置。Promise + cancel() を備え `RenderingCancelledException` も模擬するので、`pdf-view.js` の `currentRenderTask.cancel()` パスとも互換。
- **PDF 経路は `pdfjsLib.getDocument({ data })` のまま**で `ensureWorker()` を呼ぶ。
- 横長判定（`detectLandscape`）は `doc.getPage(1)` → `getViewport({scale:1, rotation: page.rotate})` で行うので、image / pdf 両方で同じ式が使える。

C3. **複数ファイル D&D / 複数選択読込** ([src/pdf-loader.js](src/pdf-loader.js) + [src/main.js](src/main.js)): 単一 doc しか保持できない既存の state モデルに合わせ、複数の見本ファイルを **1 つの「合成 doc」にフラット化** する戦略を採用。
- **`makeCompositeDoc(sources)`**: `sources = Array<{ type: "image", bitmap } | { type: "pdf", doc, pageNum }>` を受け取り、`numPages = sources.length` の擬似 doc を返す。`getPage(n)` は n 番目のソースに応じて `makeImagePage(bitmap)` か `src.doc.getPage(src.pageNum)` をディスパッチ。`destroy()` は ImageBitmap.close() と pdfjs doc.destroy() を `seenDocs` Set で重複排除しつつ実行。
- **`pickReferenceFiles()` (`multiple: true`)** と **`loadReferenceFiles(paths)`** を新設。`loadReferenceFiles` は `Intl.Collator(undefined, { numeric: true, sensitivity: "base" })` でファイル名自然順ソート（page1 → page2 → page10）してから順次読込し、PDF は全ページを fan-out、画像は 1 ページずつ追加。失敗ファイルは `failures[]` に記録して残りを続行、最終トーストで成功/失敗件数を通知。`setPdf(compositeDoc, sorted[0])` で path には先頭ファイル path を入れる（`getPdfPath()` を参照する ai-ocr / ai-place の既存連携を維持）。
- 旧 `pickPdfFile` / `loadPdfByPath` / `wrapImageAsDoc` / `loadImageAsDoc` は薄いエイリアス or 削除。`main.js` の `handleOpenPdf` と `handleDroppedPaths` の見本ファイル経路を新 API 経由に切替、`/\.pdf$/` → `/\.(pdf|jpe?g|png)$/i` に拡張、「1 つだけ読み込みました」トースト撤去。

C4. **空状態文言の更新** ([src/pdf-view.js](src/pdf-view.js)): `pdf-empty-text` を「『見本を読み込み』で見本画像を選択、またはこのウィンドウにドロップしてください。（PDF、JPEG、PNG）」に。out-of-range は「PDF にこのページはありません」→「見本にこのページはありません」。

### D. PSD の複数ファイル D&D を自然順に

D1. **`loadPsdFilesByPaths` に自然順ソートを追加** ([src/main.js](src/main.js)): 関数冒頭で `Intl.Collator(numeric: true)` を用いて `files` を basename で自然順ソート。Rust 側 `list_psd_files` の字句順 `.sort()` は `page10` が `page2` より先に来てしまうが、JS 側で再ソートすることで OS ダイアログ / D&D / フォルダ展開のすべてが `page1 → page2 → page10` の順で読み込まれる。`parentDir(files[0])` は同一フォルダ前提なら影響なし。

### E. 画像スキャン UX のメッセージ刷新

E1. **OCR 完了通知をモーダルダイアログに** ([src/ai-ocr.js](src/ai-ocr.js)): `runAiOcr(files, { notifyOnComplete = false } = {})` にオプションを追加し、成功時の toast を撤去。`notifyOnComplete: true` のときだけ `notifyDialog` で「画像スキャン完了 / テキスト抽出が完了しました。\n自動配置を行ってください。」を表示。**画像スキャンボタン経由のとき** だけ `notifyOnComplete: true` を渡す（次の操作を案内する目的）。**ai-place.js から `runAiOcrForFiles(files)` 経由で呼ぶ自動トリガー時** は false（そのまま自動配置の確認モーダルへ遷移するので案内不要）。

E2. **OCR ファイル選択ダイアログのタイトル変更** ([src/ai-ocr.js](src/ai-ocr.js)): `pickInputFiles` 内の `title: "OCR する PDF / 画像を選択"` → `"テキストスキャンする見本画像を選択"`。「画像スキャン」ボタン押下時に PDF / 画像が未読込のときだけ開くダイアログ。

### F. AI ボタンの配置とサイドバー先頭への移動

F1. **画像スキャン + 自動配置の横並び** ([index.html](index.html) + [src/styles.css](src/styles.css)): 旧構造は `.txt-source` の flex column 内で 2 ボタンが上下積み。`<div class="ai-actions-row">` でラップし、`display: flex; gap: 6px` で横並びに。

F2. **`.ai-actions-row` をサイドパネル先頭（panel-header 直下）へ移動**: HTML 上、`<div class="ai-actions-row">…</div>` を `<aside class="side-panel">` 配下、`<div class="panel-header">` の直後に配置（`<section class="panel-section txt-source">` の外）。`.side-panel.collapsed > *:not(.panel-header) { display: none }` 既存ルールにより、サイドバー折り畳み時は自動的に隠れる。

F3. **ボタン幅をサイドバー幅にフィット** ([src/styles.css](src/styles.css)): `.ai-actions-row` を `padding: 6px 8px 8px; border-bottom: 1px solid var(--border); background: var(--panel)` で panel-header と一体感を持たせつつ後続セクションと区切る。子ボタン (`.ai-ocr-btn` / `.ai-place-btn`) に `flex: 1 1 0; min-width: 0; justify-content: center` を当てて 2 ボタンが等幅でサイドバー幅を分け合うように。`margin-top` は 0 に上書き（行コンテナ側の padding で間隔を統一）。

> **このセッションの構造変更まとめ**:
> - 旧: 画像スキャン / 自動配置 = `.txt-source` セクション内に縦積み、各ボタンが `inline-flex` で intrinsic width
> - 新: サイドパネル先頭 `<div class="ai-actions-row">` 内に横並び、各ボタン `flex: 1 1 0` で等幅
> - 旧: 見本 = PDF のみ、単一ファイル、tqdm 出力が `\r` で stuck
> - 新: 見本 = PDF / JPEG / PNG / 複数ファイル混在、合成 doc で 1 つの仮想ドキュメントとして閲覧、tqdm 進捗が 10Hz でリアルタイム反映
> - 旧: 自動配置ボタンは常時押下可能、PSD/OCR 未準備時は notifyDialog で停止
> - 新: OCR 結果が無いうちはグレーアウト、PSD 未読込時はファイル選択ダイアログ → 読込 → 確認モーダルへ自動遷移

---

## v1.3.0: ホーム復帰修正・edit-font ブラシモード・編集パネル UI 刷新

### A. ホーム画面復帰時の状態リセット漏れ修正

A1. **OCR doc キャッシュのクリア漏れ** ([src/hamburger-menu.js](src/hamburger-menu.js)): `goHome()` が `clearAiOcrDoc()` を呼んでおらず、前のファイルの OCR 結果（`state.aiOcrDoc`）が残留。これにより自動配置ボタンのグレーアウト解除条件 (v1.2.0 の B2 で listener 監視中) が壊れ、再ロード後に古い OCR が使われる不具合があった。`import { clearAiOcrDoc, ... } from "./state.js"` に追加し、`clearTxtSource()` の隣で呼出し。

A2. **TXT パネルの再描画漏れ** ([src/txt-source.js](src/txt-source.js) + [src/hamburger-menu.js](src/hamburger-menu.js)): `clearTxtSource()` は state を null にするだけで TXT パネル DOM は再描画されず、ファイル名・viewer・削除ボタンが残留。ゴミ箱クリックも `if (!getTxtSource()) return` で early return → 「押せない」状態。`txt-source.js` 内部関数 `renderViewer` の薄い wrapper として `renderTxtSourceViewer()` を export し、`goHome()` の `rebuildLayerList()` 直後に呼出し。viewer 非表示・empty placeholder 表示・削除ボタン hidden を強制同期。なおサイドバーの「テキストのクリア」ボタンは TXT 原稿だけを消す責務（OCR から再生成したい場面があるため）なので OCR doc は触らず、修正対象外。

A3. **edit-font ブラシモードのリセット**: `setFontPickerStuck(false)` を `goHome()` 内で呼び出し（B 節で詳述）。

### B. edit-font ブラシモード（連続適用 + マーキー対応）

B1. **設計**: edit-font 欄でユーザーが能動的にフォントを選んだ後（`commitFont` 経由）、選択ツール (move) でテキストフレームをクリック、または マーキーで複数選択した瞬間、選んだフォントを対象フレームに自動適用する「ブラシ」操作を追加。`populateEditor()` は元々「フレームのフォントを edit-font 欄に同期するインスペクタ」だったため、**「ユーザーが能動的にピックした」 vs 「フレームから同期した」を区別する** ために `state.fontPickerStuck: boolean` フラグを新設 ([src/state.js](src/state.js))。`commitFont()` で true、`goHome()` で false にリセット。`populateEditor` 自体は変更せず、apply → rebuildLayerList → populateEditor の順で走るようにすることで、layer.font が currentFont と一致した状態で sync が呼ばれ no-op になり、ブラシが自然に持続する設計。

B2. **state とフラグ管理** ([src/state.js](src/state.js)): `state` オブジェクトに `fontPickerStuck: false` を追加、`getFontPickerStuck()` / `setFontPickerStuck(v)` を export（listener 機構なし — ボタン UI は未追加なので不要）。

B3. **commit 時の sticky 化** ([src/text-editor.js](src/text-editor.js)): `commitFont(font)` の `setCurrentFont(font.postScriptName)` 直後に `setFontPickerStuck(true)` を 1 行追加。フォント未選択時に edit-font 欄を変更しても commitField は resolveSelection が null で early return するため、`setCurrentFont + setFontPickerStuck(true)` だけ実行され、値は次の move-click で適用される。

B4. **multi-select 対応のフォント一括適用関数** ([src/text-editor.js](src/text-editor.js)): `commitFontToSelections(ps)` を export 追加。`commitStrokeFields` / `commitFillField` と同じ multi-select パターン（`beginHistoryTransient` → 全選択 iterate → 既同フォントは skip → 1 件以上 mutate なら `commitHistoryTransient` + `rebuildLayerList` + `refreshAllOverlays`）。返り値で「mutate したか」を示し、呼び出し側が二重 rebuild を避けられる。同フォントのレイヤーは無駄な undo ステップを作らずスキップ。

B5. **クリック時の apply** ([src/canvas-tools.js](src/canvas-tools.js)): `maybeApplyStickyFont()` ヘルパーを追加（sticky && currentFont があれば `commitFontToSelections` を呼ぶ薄い wrapper）。`onExistingLayerMouseDown` / `onNewLayerMouseDown` の単独選択分岐 (`setSelectedLayer` 直後) で呼び、apply 失敗 (false) のときだけ `rebuildLayerList()` を別途実行。shift-click（toggle 多重選択）と既選択 layer の re-click（drag 開始）パスでは apply しない（複数選択は塗り対象外、re-click は選択イベントではないため）。

B6. **マーキー対応** ([src/canvas-tools.js](src/canvas-tools.js)): `finalizeMarquee()` の `setSelectedLayers(final)` 直後にも `maybeApplyStickyFont()` を挿入。これでドラッグで囲んだ全フレームに一括適用、shift+drag (additive) でも既存選択 + 追加分の全レイヤーに適用される（同フォントは skip）。Ctrl+Z で multi-apply が `beginHistoryTransient` で 1 グループ化されているので 1 ステップで戻る。

### C. 編集パネル UI 仕様変更（編集 → テキスト編集統合）

C1. **トグル文言の変更** ([index.html](index.html)): `<span>編集</span>` → `<span>テキスト編集</span>`。

C2. **サイドバー縦横スイッチを廃止** ([index.html](index.html) + [src/styles.css](src/styles.css) + [src/text-editor.js](src/text-editor.js)): サイズタブ内 `.direction-toggle` div とその 2 ボタン (`#dir-vertical-btn` / `#dir-horizontal-btn`) を削除。CSS の `.direction-toggle` / `.dir-toggle-btn` ルールも dead code として削除。`dirVerticalBtnEl` / `dirHorizontalBtnEl` / `syncDirectionToggle` / `bindDirButton` を text-editor.js から削除し、`populateEditor` の `effectiveDirection` 算出も整理（per-layer toggle が読み取るので populateEditor で同期する必要がない）。

C3. **テキストレイヤーセクションを統合** ([index.html](index.html) + [src/main.js](src/main.js) + [src/styles.css](src/styles.css)): `<section class="panel-section" data-section="layers">` を廃止し、`<ul id="layer-list">` と `<div class="layer-list-footer">` を `<section data-section="editor">` 内（`<div id="editor">` の直後）へ移動。`bindSectionToggles` の iteration から `"layers"` を削除、defaults からも除外。`.panel-section[data-section="editor"]` に `display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0` を適用し、内包する layer-list が残余高を吸収しスクロール可能になるよう調整（旧 layers セクションが持っていた sizing をそのまま editor へ移植）。

C4. **レイヤーごとの縦／横トグル** ([src/text-editor.js](src/text-editor.js) + [src/styles.css](src/styles.css)):
- `dirToggleHtml(direction)` ヘルパー（`<div class="layer-dir-toggle">` + 縦/横 SVG ボタン 2 つ、`data-direction="vertical"|"horizontal"`、active クラスで現在方向を表現）と `bindLayerDirToggle(li, kind, page, layerOrNl)` を追加。
- toggle ボタンクリックは `e.stopPropagation()` で li の選択ハンドラに伝播させず、**選択は変えずに対象レイヤーの direction のみ更新** （existing → `setEdit`、new → `updateNewLayer`）→ `rebuildLayerList()` + `refreshAllOverlays()`。
- `rebuildLayerList()` で各 li を `<div class="layer-item-body">` (テキスト+メタ) と `<div class="layer-dir-toggle">` の 2 子で flex 配置。
- CSS は `.layer-list li` に `display: flex; align-items: center; gap: 8px`、ヘッダ li は `.layer-list-header` クラスで `display: block` 復帰。
- `.layer-dir-btn` は 26×26、SVG 14×14 (lucide 由来 type-vertical / type-horizontal SVG)。選択中 li (`accent` 背景) 上では枠と背景を浮かせて視認性確保（`border-color: rgba(255,255,255,0.4); background: rgba(0,0,0,0.18)`、active は `background: #fff; color: var(--accent)`）。

C5. **新規レイヤー meta 削除と「+」プレフィックス削除** ([src/text-editor.js](src/text-editor.js)): 新規レイヤー li の `<div class="layer-meta">新規テキスト …pt</div>` 行を削除（既存レイヤーの meta はフォント名 + サイズ + 編集済マークが情報として有用なので維持）。`＋ ${...}` の `＋ ` プレフィックスも削除し、テキストのみ表示。

C6. **layer-list 背景色を txt-source-viewer と統一** ([src/styles.css](src/styles.css)): `.layer-list li` に `background: var(--bg)` (`#1e1e1e`) を追加し、`.txt-source-viewer` (同じ `var(--bg)`) と同じ色に。`.layer-list li.layer-list-header` だけは `background: var(--panel)` (`#252526`) でファイル名見出しの区切りを保つ。hover (`var(--panel-hover)`) と selected (`var(--accent)`) の既存ルールはそのまま効く。

> **このセッションの構造変更まとめ**:
> - 旧: ホーム復帰時 OCR doc / TXT パネル DOM が残留 → 新: `clearAiOcrDoc` + `renderTxtSourceViewer` で完全クリア
> - 旧: フォントピッカーは選択中フレームのフォントを表示するだけのインスペクタ → 新: ユーザーがピックすれば「ブラシ」化し、move ツールでクリックしたフレームやマーキーで囲んだ全フレームに連続適用（同フォントは skip、Ctrl+Z で 1 ステップで戻る）
> - 旧: 「編集」+「テキストレイヤー」 = 2 つの折り畳みセクション、サイドバーに縦横スイッチが共存 → 新: 「テキスト編集」 1 セクションに統合、縦横スイッチは layer-list の各行に分散
> - 旧: layer-list 項目は `var(--panel)` 背景、新規行に `＋ ` プレフィックスと「新規テキスト 12pt」メタ → 新: `var(--bg)` 背景（txt-source-viewer と同色）、テキストのみのフラットな表示

---

## v1.4.0: 校正パネル・ブラシ系UX強化・絵文字SVG化

### A. 自動配置ワークフローの強化

A1. **同一テキスト警告ダイアログ** ([src/ai-place.js](src/ai-place.js)): 直近に適用したプランのテキスト内容を `lastPlacedFingerprint`（`JSON.stringify` 形式）で記録、次回ボタン押下時に内容が完全一致なら `confirmDialog`（「テキスト内容が同一です／前回と同じテキスト内容で自動配置しようとしています。自動配置を行いますか？」）を出して中断可能に。`applyPlan` 成功時のみ fingerprint を更新するので、ユーザーがキャンセルしたケースは次回も警告対象として残る。

A2. **PSD 未読込時の自動誘導** ([src/ai-place.js](src/ai-place.js)): 自動配置押下時に PSD が無ければ `notifyDialog` で止めず、`pickPsdFiles()` → `loadPsdFilesByPaths()` を動的 import 経由で呼び、PSD 読込→確認モーダル→配置 へ一気通貫で進める。`main.js ↔ ai-place.js` の循環参照は `await import("./main.js")` で回避。

A3. **OCR キャッシュなし時の自動グレーアウト** ([src/state.js](src/state.js) + [src/ai-place.js](src/ai-place.js)): `aiOcrDocListeners` を新設、`setAiOcrDoc` / `clearAiOcrDoc` が listener を発火（後者は冪等化）。`bindAiPlaceButton` で `onAiOcrDocChange` 購読 → ボタン disabled とツールチップを動的に切替（OCR 未実行時は「先に画像スキャンを実行してください」、実行後は通常文言）。

A4. **OCR キャッシュ判定の sourcePath チェック撤廃** ([src/ai-place.js](src/ai-place.js)): 画像スキャンが「常にユーザーが明示的に選んだファイル」になったため、`cache.sourcePath === currentPdf` の一致チェックを削除。キャッシュにドキュメントとページがあれば常に有効扱いに。これで「画像スキャン後 → 自動配置」の流れで再 OCR が走らない（v1.2.0 の挙動を破壊していた sourcePath 不一致による再 OCR を完全解消）。

### B. 文字サイズ刻みの環境設定

B1. **設定値**: [src/settings.js](src/settings.js) の `DEFAULT_SETTINGS.defaults.textSizeStep = 0.1` を新設（version 2 → 維持、`migrate()` で 0.1 / 0.5 のみ受け入れる検証付き）。

B2. **UI**: [src/settings-ui.js](src/settings-ui.js) + [index.html](index.html) のデフォルトタブに `<select id="default-text-size-step">` を追加。change で `setDefault("textSizeStep", v)` 保存。

B3. **適用箇所**:
- **+/- ボタン** ([src/main.js](src/main.js) `bindSizeTool`): `getSizeStep()` が `getDefault("textSizeStep")` を読み 0.1 / 0.5 を返す。+/- は `() => stepTextSize(±1)` で毎クリック評価。input の HTML `step` も同期。`onSettingsChange` 購読で設定変更時に `step` 属性を更新。
- **マウスホイール** ([src/canvas-tools.js](src/canvas-tools.js) `onLayerWheel`): hardcoded `e.shiftKey ? 10 : 1` を `baseStep × multiplier` に置換。Shift で 10×（0.5 設定なら 5pt、0.1 設定なら 1pt）。
- **`[`/`]` ショートカット**: ±2pt を維持しつつ `multiplier = round(2 / baseStep)` で小ステップ前提に折り合わせ（0.1×20、0.5×4）。

B4. **オフグリッド値スナップ** ([src/canvas-tools.js](src/canvas-tools.js) `snapNextSize`): 既存 0.1 刻みで配置したテキスト（例：12.3pt）に後から 0.5 刻みを適用すると「現在 +0.5 = 12.8」のまま off-grid に取り残されるバグを修正。`snapNextSize(cur, baseStep, sign, multiplier)` を新設し、グリッド外の値を sign 方向の最寄りグリッドにスナップ（`Math.ceil` / `Math.floor`）してから multiplier−1 ぶん追加。`resizeSelectedLayers` も同関数経由でレイヤーごと独立スナップ。

> 動作例（0.5 刻み・現在 12.3pt）: + で 12.5（13.0 ではない）、− で 12.0、Shift+ホイールで 17.5。

### C. アプリアイコン

C1. **ロゴ画像をアプリアイコンに反映**: [logo/PsDesign_icon.png](logo/PsDesign_icon.png) を [public/PsDesign_icon.png](public/PsDesign_icon.png) にコピー（Vite public で `/PsDesign_icon.png` 配信）。`tauri icon logo/PsDesign_icon.png` で [src-tauri/icons/](src-tauri/icons/) 配下の ico / icns / 各 PNG / Square*Logo / Android / iOS を一括再生成。

C2. **アプリ内タイトルバーのロゴ** ([index.html](index.html) + [src/styles.css](src/styles.css)): 旧 `<span class="app-logo-icon">Pd</span>` の紫バッジ CSS 装飾を撤去。`<img src="/PsDesign_icon.png">` に置換、`object-fit: contain` + `border-radius: 5px` の素直な画像表示に。`pointer-events: none` でクリックは親 `<h1>` に上昇（`data-tauri-drag-region` を維持）。

### D. OCR 進捗バーの安定化

D1. **tqdm `\r`-only 出力対応** ([src-tauri/src/ocr.rs](src-tauri/src/ocr.rs)): mokuro が `\r` だけでバーを refresh するため、`BufReader::lines()`（`\n` 区切り）では mokuro 終了まで一行も yield されず UI が固まる問題を解消。`read_chunks_cr_lf<R, F>(reader, on_line)` を新設しバイト列を直接読みつつ `\n` / `\r` のいずれを区切りとしても chunk を `on_line` に流す。これで tqdm の 10Hz 更新がそのまま `ai_ocr:progress` イベントになる。`install_ai_models` 側は `\n` 終端の PowerShell 出力なので従来 `BufReader::lines()` のまま。

D2. **tqdm `[time<eta]` の eta 抽出** ([src-tauri/src/ocr.rs](src-tauri/src/ocr.rs)): `parse_mokuro_progress` の戻り値を `(u32, u32, Option<String>)` に拡張、`segment` 内の `[...]` を rfind して eta 文字列を抽出。`ProgressEvent` に `eta: Option<String>` を追加（`#[serde(skip_serializing_if = "Option::is_none")]`）。

D3. **JS 側の段階表示** ([src/ai-ocr.js](src/ai-ocr.js)): `phase` を `"pdf"` / `"starting"` / `"ocr"` に拡張。`ai_ocr:start` listener で「OCR エンジンを起動中…」、ログから `text detection model` / `OCR model` / `Processing volume` を `detectStartupPhase` で検知して順に詳細を更新。`formatEta` で `00:30` → `30秒` / `01:20` → `1分20秒` に整形。

D4. **「未確定状態」の非表示** ([src/ai-ocr.js](src/ai-ocr.js)): tqdm 初期出力 `0/5 [00:00<?, ?it/s]` の `?` を含む eta は `formatEta` で空文字化し、未確定とみなして `OCR 実行中…` のみ indeterminate 表示（カウント・残り時間ともに非表示）。最初の正常 `[MM:SS<MM:SS, R.RRit/s]` で初めて `OCR 実行中… 1/5 (残り 2分)` の確定表示に切替。

### E. OCR 失敗の安定化

E1. **ファイル待ち合わせポーリング** ([src-tauri/src/ocr.rs](src-tauri/src/ocr.rs) `wait_for_mokuro_file`): mokuro 終了直後に `volume.mokuro` が見えないケース（Windows Defender スキャン / FS flush 遅延）対策で、最大 ~1.5 秒（150ms × 10 回）の rAF 風ポーリング。即時 `exists()` で諦めず一定時間待機する。

E2. **fallback 検索** (`find_any_mokuro_file`): 期待パスに無い場合は親ディレクトリ内の `*.mokuro` を走査して同 volume_name を優先採用、なければ任意の `.mokuro` を採用（mokuro バージョン差対策）。

E3. **診断情報付きエラー** (`list_dir_for_diag`): 上記でも見つからない場合、親ディレクトリの中身を列挙してエラーメッセージに含める（GPU メモリ不足 / 画像形式 / Defender ブロック等の原因切り分けを助ける）。

### F. 見本ファイル拡張（PDF + JPEG + PNG + 複数）

F1. **「見本を読み込み」ボタン化** ([index.html](index.html) + [src/pdf-view.js](src/pdf-view.js)): ツールバー `#open-pdf-btn` を「PDF」テキスト入りアイコンから lucide `FileImage` 4 パスに統一、ラベルを「見本を読み込み」に。`pdf-empty-icon` も同型に。

F2. **JPEG / PNG 対応** ([src/pdf-loader.js](src/pdf-loader.js)): `pickPdfFile` のフィルタを `pdf, jpg, jpeg, png` に拡張。`makeImagePage(bitmap)` で ImageBitmap を pdfjs Page 互換オブジェクトに包む（`getViewport` で 90/270° 回転時 W/H swap、`render` で viewport 中心起点に `ctx.translate / ctx.rotate` → 中央配置 `drawImage`、cancel + `RenderingCancelledException` 模擬で `pdf-view.js` の `currentRenderTask.cancel()` パスとも互換）。

F3. **複数ファイル合成 doc** (`makeCompositeDoc`): `sources = Array<{ type: "image", bitmap } | { type: "pdf", doc, pageNum }>` を受け取り `numPages = sources.length` の擬似 doc を返す。`getPage(n)` でソース別にディスパッチ、`destroy()` は `seenDocs` Set で重複排除して ImageBitmap.close() / pdfjs doc.destroy()。

F4. **複数選択 + 自然順ソート** (`pickReferenceFiles` / `loadReferenceFiles`): `Intl.Collator(undefined, { numeric: true, sensitivity: "base" })` で `page1 → page2 → page10` 順にソートしてから順次読込。失敗ファイルは `failures[]` に積んで残りを継続、最終トーストで成功/失敗件数を通知。`setPdf(compositeDoc, sorted[0])` で path には先頭ファイルを入れる。

F5. **PSD 複数 D&D も自然順** ([src/main.js](src/main.js) `loadPsdFilesByPaths` 冒頭): `Intl.Collator(numeric: true)` で basename 自然順ソート。Rust `list_psd_files` の字句順 `.sort()` が `page10 < page2` と並べる問題を JS 側で再ソートして解消。

### G. 完了通知のグリーンチェックモーダル

G1. **`notifyDialog` の `kind: "success"`** ([src/ui-feedback.js](src/ui-feedback.js)): タイトル要素に SVG check-circle + テキストを差し込み、`notify-title-success` クラスでタイトル色を緑（`#3ca86b`）に。cleanup で次回呼び出し用に plain テキスト状態へ復帰。

G2. **画像スキャン完了** ([src/ai-ocr.js](src/ai-ocr.js)): `runAiOcr(files, { notifyOnComplete = false })` オプション追加。**画像スキャンボタン経由のとき** だけ `notifyOnComplete: true` で「画像スキャン完了 / テキスト抽出が完了しました。\n自動配置を行ってください。」モーダル表示。**自動配置から `runAiOcrForFiles(files)` 経由の自動トリガー時** は false（そのまま確認モーダルへ遷移）。

G3. **自動配置完了** ([src/ai-place.js](src/ai-place.js)): 旧 toast を `notifyDialog({ title: "自動配置完了", message: "${added} 件のテキストレイヤーを追加しました。", kind: "success" })` に置換。`toast` import も撤去。

### H. 画像スキャンは見本流用しない

H1. **常にファイル選択ダイアログ** ([src/ai-ocr.js](src/ai-ocr.js)): `bindAiOcrButton` の click handler から `getPdfPath()` 優先ロジックを撤去し、毎回 `pickInputFiles()` を起動する運用に変更。「見本ビューアは表示用、OCR 対象は別ファイルを意識的に選ぶ」設計判断。ツールチップは「PDF / 画像を選択して AI で画像スキャン」固定文言に。`onPdfChange` 購読も撤去。

H2. **ファイル選択ダイアログのタイトル**: 「テキストスキャンする見本画像を選択」に変更。

### I. 原稿テキスト ダブルクリックで該当フレームを in-place 編集

I1. **`enterInPlaceEditForLayer(pageIndex, layerKey, options)` 追加** ([src/canvas-tools.js](src/canvas-tools.js)): `startInPlaceEdit(ctx, target)` のラッパー。
- ページ移動が必要なら `setCurrentPageIndex(pageIndex)` を呼び、`mounts.get(pageIndex)` を最大 10 frame の rAF ポーリングで待機（spread-view の rAF debounce で何 frame 後にレンダーされるかは決め打ちできないため、固定 rAF×N より polling が安全）
- `layerKey` の型（数値 = 既存 / 文字列 = tempId）でターゲット構築
- direction（縦/横）に応じて T/Y ツールへスイッチ（既存 in-place 編集と同じくコミット後はツールを戻さない）
- `setSelectedLayer` でハイライト → `startInPlaceEdit(ctx, target, options)`

I2. **`startInPlaceEdit` に afterCommit hook 追加**: `options.afterCommit?: (value: string) => void`。`createTextFloater` の `onCommit` で layer 更新後に呼ばれる（Esc キャンセル時は呼ばれない）。原稿テキスト側を同期するためのフック。

I3. **`txt-source.js` の dblclick 配線** ([src/txt-source.js](src/txt-source.js)): 各 `.txt-block` に `dblclick` リスナー追加 → `runDoubleClickEdit(paragraph, pageNumber, viewer)` を呼ぶ。マッチ無しは `toast`、マッチ時は **TXT selection を明示クリア**（`onPageIndexChange` 経由のクリアは別ページ移動時のみ走るため、同ページ dblclick 後の「次クリックで再配置」事故を防ぐ）してから `enterInPlaceEditForLayer` を呼ぶ。

I4. **`findPlacedLayerByText(text)`**: ページ：現在ページを最優先 → 残り index 昇順、ページ内：既存（PSD 元レイヤー）→ 新規（auto-place / T ツール配置）の順で線形検索。`normalizeForMatch`（CRLF→LF + 前後 \n の trim）で比較。複数マッチは `console.info` で記録（運用中の頻度把握用）。

I5. **打ち換え後の txt-source-viewer 同期** ([src/txt-source.js](src/txt-source.js) `updateTxtSourceBlock` + `replaceBlockInContent`): in-place 編集確定時に `afterCommit` hook で原稿テキストの該当ブロックも置換。`replaceBlockInContent(content, pageNumber, oldText, newText)` でページマーカー範囲内（`<<NPage>>` で区切られたセクション）の最初の出現を置換、`setTxtSource` → `renderViewer()` で UI 更新。マーカー無し原稿は content 全体が対象。改行は内部で LF 統一して比較・置換。

> 循環 import: `txt-source.js` ↔ `canvas-tools.js` は遅延参照（dblclick / canvas クリック内）でのみ使われるため、ES モジュールの live binding で正しく解決される。

### J. 校正パネル（Comic-Bridge / MojiQ 互換）

J1. **新規モジュール `src/proofread.js`**: Comic-Bridge `ProofreadPanel` 相当を pdf-stage 上にオーバーレイ表示する 約 500 行のモジュール。

**JSON 形式（どちらにも対応）:**
- ネスト形式: `{ work, checks: { simple: { items: [...] }, variation: { items: [...] } } }` — simple = correctness、variation = proposal
- フラット配列: `[{ category, page, excerpt, content, checkKind }, ...]` — 全件 correctness 扱い、`checkKind` があれば優先

**状態:**
- `checkData`: 読込済み JSON のパース結果（title / fileName / filePath / allItems / correctnessItems / proposalItems）
- `checkTabMode`: `"correctness" | "proposal" | "both"`
- `viewMode`: `"empty" | "results" | "browser"`
- `browserCurrentPath` / `browserNavStack` / `browserForwardStack`: フォルダブラウザ履歴（後述）

**機能:**
- 3 タブ切替（正誤 / 提案 / 全て）。`both` モードで 2 カラム並列表示
- 項目行：カテゴリ色バッジ（10 色パレット、`getCategoryColor` で `^(\d+)\.` から index 抽出）+ ページ + 種別バッジ + excerpt + content
- 項目クリック → `setCurrentPageIndex(parseInt(item.page) - 1)` で PSD ページ連動

J2. **JSON 読込パスは MojiQ 互換** ([src/proofread.js](src/proofread.js)): `PROOFREAD_BASE_PATH = "G:\\共有ドライブ\\CLLENN\\編集部フォルダ\\編集企画部\\写植・校正用テキストログ"`（MojiQ `electron/main.js` の `TXT_FOLDER_BASE_PATH` と完全一致）。

J3. **アプリ内フォルダブラウザ** (Tauri 環境では OS の `open()` を使わず自前 UI):
- 新 Rust コマンド `list_directory_entries(path) -> Vec<DirEntry>` ([src-tauri/src/lib.rs](src-tauri/src/lib.rs))。`#[serde(rename = "isDirectory")]` 等で JS 側 camelCase で受け取り
- `loadBrowserFolder(dirPath)`：純粋なロード関数（`list_directory_entries` で取得 → `renderBrowserList`）。スタック管理は呼出側へ委譲
- `browserNavigateInto(dirPath)`：「直接降りる」エントリ。`navStack.push(current); forwardStack = [];`
- `browserGoUp` / `browserGoForward`：戻る/進む（典型的なブラウザ履歴セマンティクス）
- **MojiQ 互換の「校正チェックデータ」自動スキップ**: サブフォルダがそれ 1 つだけなら自動的に降りる

J4. **校正トグルボタン** ([index.html](index.html) panel-section-h2): 原稿テキスト見出しに `<button id="proofread-toggle-btn" class="panel-h2-action-btn">` を追加。**MojiQ Pro と同じ check-square SVG**（[HeaderBar.tsx ProofreadingModeIcon](C:\Users\noguchi-kosei\Desktop\MojiQ_開発\MojiQ Pro_1.0\src\components\HeaderBar\HeaderBar.tsx#L233) と完全一致するパス）+ ラベル「校正」の inline-flex 構成。`aria-pressed="true"` で accent 塗り。

J5. **proofread-panel-header 構成**:
- 結果/空状態時: タブ（正誤/提案/全て）+ JSON読込ボタン
- ブラウザモード時: 戻る ← / 進む → / キャンセル（`viewMode` 切替で `hidden` 属性を付け替え）
- 閉じるボタン (×) は無し（校正トグルボタンで開閉できるため省略）
- パンくず（`proofread-browser-breadcrumb`）も無し（ブラウザモードを最小構成に）

J6. **proofread-empty 表示**: アイコン（**MojiQ ver_2.24 の `proofreadingLoadBtn` と同じ list-checks SVG**、64×64、`color: var(--text-muted); opacity: 0.55`）+ メッセージ「校正チェックJSONを読み込んでください」。読込ボタンは header に集約済みなのでここには置かない。

J7. **CSS** ([src/styles.css](src/styles.css)): `.proofread-panel`（`position: absolute; inset: 0; z-index: 50` で `.spreads-pdf-area` を覆う overlay）、`.proofread-panel-header`、`.proofread-tabs / .proofread-tab`、`.proofread-actions`、`.proofread-load-btn`、`.proofread-browser-nav / .proofread-nav-btn`、`.proofread-browser-list / .proofread-browser-row`、`.proofread-2col / .proofread-col`、`.proofread-item`（カテゴリバッジ + page + kind + excerpt + content）、`.proofread-empty / .proofread-empty-icon` 等。

### K. 絵文字を SVG アイコンに置換

K1. **`notifyDialog` の `kind: "warning"` 追加** ([src/ui-feedback.js](src/ui-feedback.js) + [src/styles.css](src/styles.css)): 既存 `kind: "success"`（緑 + check-circle）の隣に warning（オレンジ `#d97706` + alert-triangle）を追加。cleanup で `notify-title-success` / `notify-title-warning` 両クラスをクリア。

K2. **保存完了モーダル** ([src/main.js](src/main.js)): 旧 `title: "保存完了 ⚠ 警告あり"` を `kind: hasWarn ? "warning" : "success"` + title「保存完了 / 保存完了（警告あり）」に置換。⚠ 絵文字撤去。

K3. **校正パネルの列見出し** ([src/proofread.js](src/proofread.js) `COL_ICON_SVG`): `✅ 正誤チェック` → check-circle SVG + 「正誤チェック」、`📝 提案チェック` → file-text SVG + 「提案チェック」。stroke は `currentColor` で既存色を継承。

K4. **自動配置確認モーダル** ([src/ai-place.js](src/ai-place.js) `STATUS_LABEL`): `✓ 一致` → check SVG（緑）、`⚠ TXT 余 / 吹き出し余 / TXT なし / 吹き出しなし` → alert-triangle SVG（オレンジ）。`renderPlanReviewTable` の innerHTML 内で SVG を直接挿入、テキストは `<span class="ai-place-status-text">` 側に。

K5. **ショートカット衝突警告** ([src/settings-ui.js](src/settings-ui.js) `refreshCaptureConflict`): `⚠ ...` テキスト → alert-triangle SVG + `<span>` テキスト。textContent → innerHTML（XSS 対策のため `description / with` の本文は span.textContent で挿入）。`.key-capture-conflict` を flex に拡張、icon 用クラス追加。

> アイコンは全て **lucide ベース**（check / check-circle / file-text / alert-triangle / list-checks / check-square）で統一感を確保。`stroke="currentColor"` でテーマ色追従。`grep` で残存 emoji を検索してゼロ件確認済み。

### L. その他のセッション内変更（細々したもの）

- **画像スキャン中のファイル選択ダイアログタイトル**: 「OCR する PDF / 画像を選択」→「テキストスキャンする見本画像を選択」
- **画像スキャン / 自動配置ボタンを横並びに**: サイドパネル先頭の `.ai-actions-row` で `flex: 1 1 0` の等幅 2 ボタン（画像スキャンの直右に自動配置）
- **画像スキャンと自動配置のボタンスタイル統一**: `var(--panel-hover)` 背景 + `var(--border)` 枠で控えめに、ホバーで accent 色

### この v1.4.0 で実装した「触らなかった既存機能」

- Photoshop ExtendScript 経由の編集適用（[src-tauri/src/photoshop.rs](src-tauri/src/photoshop.rs) / [src-tauri/src/jsx_gen.rs](src-tauri/src/jsx_gen.rs)）
- フォント列挙（[src-tauri/src/fonts.rs](src-tauri/src/fonts.rs)）
- 既存ショートカット・ページ送り・テキストツール (V/T/Y)・ガイド・ルーラー
- AI モデルインストール ([src-tauri/scripts/install-ai-models.ps1](src-tauri/scripts/install-ai-models.ps1))

> **構造変更まとめ**:
> - 旧: 校正データを表示する場所なし → 新: pdf-stage 上にオーバーレイする校正パネル（Comic-Bridge / MojiQ 互換 JSON）
> - 旧: 原稿テキスト dblclick = ノーオペ → 新: 該当テキストフレームに移動 + in-place 編集起動 + 確定で原稿側も同期更新
> - 旧: サイズ刻みは固定（ボタン ±1pt / ホイール ±1pt） → 新: 環境設定で 0.1 / 0.5 を選択、グリッドスナップ付き
> - 旧: 完了通知は toast / プレーンタイトル + 絵文字 → 新: 中央モーダル + 緑チェック / オレンジ警告の SVG アイコン
> - 旧: 画像スキャンは現在の見本を流用 → 新: 常にファイル選択（毎回意識的に対象を選ぶ）+ 結果は sourcePath 不問で再利用

---

## v1.4.1: 原稿テキスト編集の Undo 同期・サイズバッジにフォント併記

### A. 原稿テキスト dblclick 編集の Undo/Redo 同期

A1. **問題**: txt-source-viewer の段落を dblclick → in-place 編集 → 確定 で原稿テキスト側のブロックを書き換えた後に Ctrl+Z で巻き戻すと、テキストフレーム側は元のテキストに戻るが **txt-source-viewer の表示は新しいテキストのまま** で乖離する。原因は履歴スナップショット (`snapshotState`) が `edits / newLayers / nextTempId` のみを保存しており、`txtSource` が undo 対象外だったため。

A2. **`state.txtSource` を履歴スナップショットに含める** ([src/state.js](src/state.js)):
- `snapshotState()` に `txtSource: state.txtSource ? { ...state.txtSource } : null` を追加（name / content をシャローコピー）
- `restoreSnapshot()` で `Object.prototype.hasOwnProperty.call(snap, "txtSource")` チェック付きで復元（古い snapshot との forward 互換）。`txtSourceEqual(a, b)` で同値判定し、変化があるときだけ `txtSelection` / `txtSelectedBlockIndex` をクリア + listener 発火（不要再描画を抑制）。
- `setTxtSource` / `clearTxtSource` を内容変化時のみ listener 発火 + `pushHistorySnapshot()` 呼出に変更。`txtSourceListeners: new Set()` + `onTxtSourceChange(fn)` API を追加。
- 副作用: TXT ファイルロード / clearTxtSource もこれで undo 可能になるが、history baseline は `clearPages()` 末尾の `resetHistoryBaseline()` で常にリセットされるため、PSD 切替後に古いロード履歴が残ることはない。

A3. **txt-source.js の listener 購読** ([src/txt-source.js](src/txt-source.js)):
- `initTxtSource()` で `onTxtSourceChange(() => renderViewer())` を購読 → undo/redo で `txtSource` が復元されたとき viewer が自動で再描画される。
- `updateTxtSourceBlock` 内の明示 `renderViewer()` 呼出は撤去（listener 経由で同期描画されるため不要）。

A4. **dblclick 編集の history transient 化** ([src/canvas-tools.js](src/canvas-tools.js) `startInPlaceEdit.onCommit`):
- `options.afterCommit` が指定されているケース（dblclick 経由）は `beginHistoryTransient()` … `commitHistoryTransient()` で `setEdit` / `updateNewLayer` + `afterCommit(value)`（→ `setTxtSource`）を囲む。これにより**レイヤーテキスト編集と原稿テキスト書換が 1 つの history snapshot にまとまり、Ctrl+Z 1 回で両方同時に巻き戻る**。
- afterCommit 無し（通常の T ツール in-place 編集など）は従来通り `setEdit` / `updateNewLayer` の中で個別 push される。

### B. テキストフレーム下のサイズバッジ刷新

B1. **フォント名を併記** ([src/canvas-tools.js](src/canvas-tools.js) `createSizeBadge`):
- 引数を `(sizePt, page)` → `(sizePt, page, fontPostScriptName)` に拡張。呼出側で既存レイヤー = `edit.fontPostScriptName ?? layer.font ?? null`、新規レイヤー = `nl.fontPostScriptName ?? null` を渡す。
- `getFontDisplayName(psName)` でフォントの表示名を解決し、`{フォント名} · {N}pt` 形式で表示。フォント未指定時は従来どおり `{N}pt` のみ。

B2. **テキストフレームから余白を取る** ([src/styles.css](src/styles.css) `.layer-size-badge`):
- `margin-top: 2px` → `10px`。バッジが枠に密着していて視認性が悪かったのを改善。`top: 100%` 基準で枠下中央外側に張り出す配置はそのまま。

### バージョン

C1. **1.4.0 → 1.4.1** ([package.json](package.json) / [src-tauri/Cargo.toml](src-tauri/Cargo.toml) / [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) を同期更新)。Cargo.lock も自動追従。

> **構造変更まとめ**:
> - 旧: 履歴スナップショットは `edits / newLayers / nextTempId` のみ → 新: `txtSource` も含める。`onTxtSourceChange` listener で UI 再描画を駆動
> - 旧: dblclick 編集は setEdit と setTxtSource が別々に snapshot を push → 新: `beginHistoryTransient` で 1 snapshot に束ね、Ctrl+Z 一発で両方巻き戻る
> - 旧: サイズバッジ = `{N}pt` のみ、`margin-top: 2px` で枠に密着 → 新: `{フォント名} · {N}pt`、`margin-top: 10px` で枠から離して視認性向上

---

## v1.4.2: 画像スキャン オフライン化 + 校正パネル ページ番号ハイパーリンク

### A. 画像スキャン (mokuro OCR) のネット切断耐性

A1. **問題**: ネットを切断（または不安定な環境）で画像スキャンすると高確率で `_ocr/` フォルダだけ作成されて `.mokuro` が出ず「mokuro が画像を処理できなかった可能性があります」エラーで失敗する。原因は `manga-ocr` 内部の `transformers` ライブラリが、キャッシュ済みモデル（`~/.cache/huggingface/hub/models--kha-white--manga-ocr-base/`）を持っていても **起動時に毎回 HuggingFace Hub へ HEAD リクエスト**し、タイムアウトで `from_pretrained()` が落ちるため。

A2. **mokuro 起動時にオフラインモードを強制** ([src-tauri/src/ocr.rs](src-tauri/src/ocr.rs) `run_ai_ocr`):
- `Command::new(&mokuro_path)` の env に `HF_HUB_OFFLINE=1` / `TRANSFORMERS_OFFLINE=1` を追加
- これでキャッシュのみを使い HuggingFace へ一切問い合わせない動作になる。ネット切断・不安定どちらの環境でも安定。
- 既存 env (`PYTHONUNBUFFERED=1` / `PYTHONUTF8=1`) と並列に追加するだけの最小修正

A3. **インストール時にモデル重みを事前ダウンロード** ([src-tauri/scripts/install-ai-models.ps1](src-tauri/scripts/install-ai-models.ps1) Phase 6b 新設):
- 旧 `install-ai-models.ps1` は **Python ライブラリ** (`manga-ocr` / `mokuro` / `torch` 等) しかインストールしておらず、AI モデルの重みファイル（~500MB）は初回スキャン時に遅延ダウンロードされる仕組みだった。A2 でオフライン強制したため、キャッシュが無いと永遠に動かない。
- Phase 6 (Verify) 直後に Phase 6b を追加し、`& $PythonExe -u -c "from manga_ocr import MangaOcr; MangaOcr()"` を実行して **インストール時にネットがあるタイミングで重みを取得**しキャッシュ (`%USERPROFILE%\.cache\huggingface\`) に置く
- 既にキャッシュ済みなら no-op で即終了。失敗時は `LASTEXITCODE` で throw

> **運用結果**: 「インストール時のみネット必須／日常運用は完全オフライン」という分かりやすい構成になった。社内ネット不安定環境での画像スキャン失敗を根絶。

### B. 校正パネル ページ番号ハイパーリンク化（MojiQ 互換）

B1. **問題**: 校正項目をクリックするとどの行を選んでも常に **1 ページ目** に飛んでしまう（ジャンプ機能が事実上壊れていた）。
- 校正 JSON の `page` フィールドは `"1巻 16ページ"` のような複合表記が一般的だが、旧 [proofread.js:451-452](src/proofread.js) は `parseInt("1巻 16ページ", 10)` で値を取っていた → JS の `parseInt` 仕様で先頭の `1` を返し、常に `setCurrentPageIndex(0)` を呼んでいた

B2. **`parsePageNumber()` ヘルパー** ([src/proofread.js](src/proofread.js) 冒頭) — MojiQ `proofreading-panel.js` の `formatPage` / `jumpToPage` 互換:
- `/(\d+)\s*(?:ページ|P|p)/` で「ページ」「P」サフィックス付き数字を最優先で拾う → `"1巻 16ページ"` → 16
- マッチしない場合は `/^\s*(\d+)/` で先頭の数字を拾う → `"5"` → 5
- 両方失敗で null（`""` / `"—"` 等の数値化不能な値はリンク化しない）

B3. **ページ番号を `<button>` リンク化** ([src/proofread.js](src/proofread.js) `renderItem`):
- 旧: `<span class="proofread-page">p.{item.page}</span>`（グレー、リンクに見えない）
- 新: `<button class="proofread-page proofread-page-link">` に変更し、専用クリックハンドラに `e.stopPropagation()` を入れて行クリックとの二重発火を防止
- `parsePageNumber` がパース失敗を返した場合は従来通り `<span>` で押せない通常表示にフォールバック（誤解防止）
- 行 (`el`) 全体のクリックハンドラも `parsePageNumber` ベースに書き換え（行のどこをクリックしても正しいページに飛ぶ）

B4. **CSS** ([src/styles.css](src/styles.css)):
- `button.proofread-page-link` を追加: 青文字 (`color: var(--accent)` = `#0078d4`) + `cursor: pointer` + `hover { text-decoration: underline }` + transparent background + border 0 padding 0 で純粋テキストリンク化
- 既存 `.proofread-page`（グレー）はパース失敗時のフォールバック用に温存

### バージョン

C1. **1.4.1 → 1.4.2** ([package.json](package.json) / [src-tauri/Cargo.toml](src-tauri/Cargo.toml) / [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) を同期更新)。Cargo.lock も自動追従。

> **構造変更まとめ**:
> - 旧: mokuro は HuggingFace へ毎回 HEAD → ネット切断で from_pretrained 失敗 → 新: HF_HUB_OFFLINE=1 / TRANSFORMERS_OFFLINE=1 でキャッシュのみ使用
> - 旧: モデル重みは初回スキャン時に遅延 DL → 新: install-ai-models.ps1 Phase 6b でインストール時に事前 DL
> - 旧: 校正項目クリックは常に 1 ページ目 (`parseInt("1巻 16ページ")` = 1) → 新: `parsePageNumber()` で「ページ」「P」付き数字を最優先、`"1巻 16ページ"` → 16
> - 旧: ページ番号 = グレー `<span>` (リンクに見えない) → 新: 青文字 `<button>` + ホバー下線 + stopPropagation で MojiQ 互換ハイパーリンク

## v1.4.3 — 非表示レイヤーのプレビュー除外 + 配置テキストの "text" グループ格納

### A. 非表示レイヤー（テキスト含む）をプレビューから除外
[src/psd-loader.js](src/psd-loader.js)

**問題**: PSD 上で非表示にしているテキストレイヤー（あるいはそれを内包する非表示フォルダ）が、PsDesign のキャンバス上に薄く描画されてしまう。Photoshop の「互換性を最大に」で保存された合成画像 (`psd.canvas`) には、保存時点で可視だったレイヤーが焼き込まれているため、後から非表示にしたテキストが残ったまま見える状態になっていた。

**A1. `collectTextLayers` の親可視性伝播** ([psd-loader.js](src/psd-loader.js))
- 引数に `parentVisible` を追加し、親フォルダが非表示なら子テキストも textLayers 配列に含めない
- `effectiveVisible = parentVisible && !layer.hidden` で実効可視を判定し、テキストレイヤーは可視時のみ push
- グループへの再帰時に `effectiveVisible` を渡して再帰的に伝播（深いネストでも親の非表示が効く）

**A2. 非表示レイヤーごとに「形状マスク」で psd.canvas を上書き** (`collectHiddenLayersForMasking` + `maskHiddenLayersOnComposite`)
- 第一案の「非表示矩形を白塗り」では文字裏側の絵柄まで欠ける問題があり、第二案の「全レイヤー再合成」では ag-psd が canvas を生成しないレイヤー（スマートオブジェクト/調整レイヤー/フィルレイヤー等）が大量にある PSD で画面真っ白になる問題があった
- 採用案: **`psd.canvas` をベースにコピー → 各非表示レイヤーの `layer.canvas` 自身を destination-in アルファマスクとして利用 → 文字／レイヤー形状そのものの輪郭ぴったりだけ白で塗りつぶす**
  ```
  一時 canvas (= レイヤーと同サイズの白い矩形)
    .globalCompositeOperation = "destination-in"
    .drawImage(layer.canvas)        // 一時 canvas が「文字形状の白」だけになる
  本 canvas.drawImage(一時 canvas, layer.left, layer.top)
  ```
- canvas を持たない非表示レイヤー（調整 / 一部 SO 等）はそもそも合成済み psd.canvas に独立した「物体」として焼き込まれていないため無視で OK
- 親グループが非表示でも子に再帰し、子個別の canvas があれば独立にマスクするので「フォルダごと非表示」でもテキストだけ正確に消える
- 失敗時は元の `psd.canvas` をそのまま使うフォールバック

**A3. `loadPsdFromPath` のフロー**
- `collectTextLayers(child, [], true)` で実効可視のテキストのみ収集
- `collectHiddenLayersForMasking` で非表示レイヤー候補を集め、1 件以上あれば `maskHiddenLayersOnComposite` で `psd.canvas` のマスク済みコピーを返す
- 非表示が無ければ `psd.canvas` をそのまま使用（速度劣化なし）

### B. 配置テキスト保存時に "text" グループへ格納（既存フォルダは触らない）
[src-tauri/src/jsx_gen.rs](src-tauri/src/jsx_gen.rs)

**B1. `createNewTextGroupAtTop(doc)` を HEADER に新設**
- **毎回新規 LayerSet を生成** し、最上部に移動 → 名前 "text" → `visible = true` を設定
- 既存の "text" フォルダは **検索しない / 再利用しない / 中身に触らない**: ユーザー側の意図的な構成（特に非表示にしてある旧テキスト群）を完全に保持
- 順序のコツ: `add` → `move(doc, PLACEATBEGINNING)` → `name = "text"` → `visible = true` の順（一部 Photoshop バージョンで `move()` 後に name がリセットされる挙動があるため move を先に）

**B2. `applyToPsd` 内 newLayers 処理を 2 段階パターンに変更**
- 旧: `LayerSet.artLayers.add()` でフォルダ内に直接作成 → PS バージョンによって不安定だった
- 新: **`doc.artLayers.add()` で document 直下に作成 → 全プロパティ設定 → 最後に `layerRef.move(__textGroup, PLACEATBEGINNING)` でフォルダへ移動** という安定パターン
- 座標は document 絶対指定なので group へ入れても表示位置は変わらない
- 各レイヤーの move 直後 / 全件処理後の 3 段で `visible = true` を呼んで、PS 側の生成時非表示挙動を補正

**B3. 既存の `edits`（既存テキストへの編集）は触らない方針を維持**
- group 内に取り込まない / 元の階層のままテキスト・フォント・座標などを更新
- group 化対象は **PsDesign で新規配置したレイヤー (`newLayers`) のみ**

**期待される保存後 PSD 構造**:
```
レイヤーパネル（上から）:
├─ text                  ← 今回保存で新規作成された可視グループ
│  ├─ 配置テキスト 1     ← stroke 効果付き / 可視
│  └─ 配置テキスト 2
├─ text                  ← 既存非表示の "text" フォルダ（中身ごと完全保持）
├─ セリフ                ← 既存非表示レイヤー（保持）
└─ 線画                  ← 既存可視レイヤー（保持）
```
重複名 "text" は Photoshop で許容され、必要に応じて自動採番されるケースもある。

### バージョン

C1. **1.4.2 → 1.4.3** ([package.json](package.json) / [src-tauri/Cargo.toml](src-tauri/Cargo.toml) / [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) を同期更新)。Cargo.lock も自動追従。

> **構造変更まとめ**:
> - 旧: psd 上の非表示テキスト/フォルダがプレビューに焼き込み画像経由で残って見える → 新: 各非表示レイヤーの canvas をアルファマスクとして利用し、文字輪郭ぴったりだけを白塗り（裏側の絵柄は保持）
> - 旧: PsDesign で配置したテキストはドキュメント直下にバラ撒かれていた → 新: 保存時に最上部へ「text」グループを毎回新規作成して格納
> - 旧: 既存の "text" フォルダがあれば再利用＋可視化していた → 新: 既存フォルダは一切触らない（中身保持・可視性も変えない）
> - 旧: `LayerSet.artLayers.add()` で直接フォルダ内に作成 (PS バージョン不安定) → 新: doc 直下に作成 → 設定 → `move(group, PLACEATBEGINNING)` の 2 段階パターン

---

## v1.4.4: 画像スキャン UX 改善・原稿テキスト管理強化・サイドバー / 校正パネル UI 拡張

### A. 画像スキャン: 読込済み見本を優先

A1. **state.js: 複数ファイルパスを保持** ([src/state.js](src/state.js))
- `state.pdfPaths: []` を追加（loadReferenceFiles で読み込まれた全ファイルの自然順ソート済みパス配列）
- `setPdf(doc, path, paths)` を 3 引数化。第 3 引数省略時は `path ? [path] : []` にフォールバック（既存呼び出し互換）
- `getPdfPaths()` を新設・export（コピー返却）

A2. **pdf-loader.js**: `loadReferenceFiles` の `setPdf(compositeDoc, sorted[0])` を `setPdf(compositeDoc, sorted[0], sorted)` に変更し、ソート済み全件を state に流す

A3. **ai-ocr.js bindAiOcrButton**: クリックハンドラを「`getPdfPaths()` に何かあればそれで OCR、無ければ `pickInputFiles()`」のフォールバック方式に変更。v1.4.0 H1 で「常にダイアログ」にした方針を反転（ファイル選択ダイアログを毎回潜らせる UX が冗長との要望）。tooltip も「読込済み見本を AI でスキャン（未読込ならファイル選択）」に変更

A4. **ai-place.js**: 自動配置の自動 OCR トリガーも `getPdfPaths()` で全ファイル対象。`runAiOcrForFiles([currentPdf])` の 1 件固定を撤去し、見本に複数ファイルを読み込んでいるとき全件を OCR にかける整合を取る。`getPdfPath` 単独の import は撤去

> **構造変更**: 旧「画像スキャンは常にファイル選択ダイアログ」 → 新「読込済み見本があれば優先、未読込ならダイアログ」。ai-place.js も同じパスで複数ファイル全件対象。

### B. 原稿テキストの保存機能

B1. **TXT 保存ボタン**: TXT パネルの `txt-source-actions` 行に `#save-txt-btn`（lucide download アイコン、24×24）をゴミ箱ボタンの**左隣**に配置。`renderViewer` で TXT 読込中に表示、空なら hidden（クリアボタンと同パターン）

B2. **`pickTxtSavePath(defaultName)`** ([src/txt-source.js](src/txt-source.js)): `@tauri-apps/plugin-dialog` の `save()` を起動。デフォルト filename は `getTxtSource().name`（OCR 結果なら `xxx_AI.txt` / `OCR-N件.txt`、TXT 読込なら元ファイル名）。`ensureTxtExtension()` で拡張子保証（`.txt` を消したら自動付与）

B3. **既存 Rust コマンド `export_ai_text(content, output_path)` を再利用** ([src-tauri/src/ocr.rs](src-tauri/src/ocr.rs)): v1.1.0 で実装済みだが JS から未呼出だった。`invoke("export_ai_text", { content, outputPath })` で UTF-8 BOM 無し書き込み

B4. **CSS** ([src/styles.css](src/styles.css)): `.txt-source-save-btn` を `.txt-source-clear-btn` 同パターン (24×24, flex-shrink:0)。hover 色は `--accent`（クリアの `--danger` と区別）

### C. TXT パネルの PSD/PDF/TXT-only ページ送り連動

C1. **PSD 未読込でも PDF / 画像のページ送りに TXT 連動** ([src/txt-source.js](src/txt-source.js))
- `activePageNumber()` ヘルパー新設: PSD pages があれば PSD index、無ければ pdfPageIndex を流用（PDF 読込中も TXT 単体運用も同じ index を共有）
- `onPdfPageIndexChange` / `onPdfChange` を購読。PSD 未読込時のみ viewer 再描画して二重描画を回避

C2. **TXT 単体読込時のページ送り** ([src/main.js](src/main.js))
- `getTxtPageCount()` 新設・export ([src/txt-source.js](src/txt-source.js)): `<<NPage>>` マーカーの最大ページ番号 (or 0)
- `activePageSource()` / `setActivePageIndex(source, idx)` ヘルパーを追加: 「PSD → PDF → TXT」優先順で `{source, total, current}` を返し、適切な setter にディスパッチ
- `advancePage` / `jumpToEdge` / `decidePageJumpTarget` / `updatePageNav` を全部この方式に書き換え。TXT 単体時は **pdfPageIndex を「閲覧中ページ index」として流用** する設計（新 state 追加なし）

C3. **TXT 変更時のナビ更新 + index クランプ** ([src/main.js](src/main.js) `bindPageChange`): `onTxtSourceChange` を購読し、PSD/PDF とも空の状況で TXT が読まれたら updatePageNav 実行。新 TXT のページ数より index が大きければ `setPdfPageIndex(0)` で先頭に戻す

> **TXT 単体運用フロー**: TXT のみ読込 → ←/→ キー / ▲▼ ボタン / Ctrl+J で TXT マーカーに沿ってページ送り → サイドバーラベル「3 / 10」等が表示。Ctrl+J ジャンプダイアログのラベルは「テキスト ページ」。

### D. 原稿テキスト 1 段落削除

D1. **`deleteBlockFromContent(content, pageNumber, idx)`** ([src/txt-source.js](src/txt-source.js)): マーカー無し原稿は全体、マーカー有りは該当ページセクション内の `idx` 番目パラグラフを削除し、両端の改行を整えて返す。`splitBlocksRaw` を使ってセクションテキストをパラグラフ列に分解 → splice → 再結合という流れで rebuild

D2. **`deleteSelectedTxtBlock()` を export**: 選択中ブロックを削除 → 選択クリア → `setTxtSource` で listener 連動再描画。返値で削除成否を示す

D3. **削除 UI** ([index.html](index.html) + [src/styles.css](src/styles.css)): TXT パネル内 `txt-source-dropzone` の直後に `<div class="txt-source-footer">` + `#delete-txt-block-btn`（ゴミ箱アイコン 28×28）。CSS は `.layer-list-footer` / `.layer-delete-btn` と同パターン（disabled で 0.35 透過、hover で `rgba(231,76,60,0.12)` 背景 + `--danger` 色）。`syncDeleteBlockBtn()` で footer 表示と button disabled 状態を `getTxtSource()` / `getTxtSelectedBlockIndex()` から導出、`renderViewer` 末尾と `selectBlock` 内で呼んで状態追従

D4. **Delete / Backspace ショートカット** ([src/main.js](src/main.js)): 既存の `deleteSelectedLayers` 分岐より**前**に `deleteSelectedTxtBlock()` を試す優先順に変更。修飾キーなし + 入力欄外でのみ発火。「TXT 選択 → 削除」が「レイヤー選択 → 削除」より優先

### E. 「テキストをクリア」を「テキストを削除」に文言変更

E1. **confirmDialog に `kind: "danger"` 追加** ([src/ui-feedback.js](src/ui-feedback.js)): `notifyDialog` と同形の `kind` パラメータを export。`"danger"` で `notify-title-danger` クラスをタイトル要素に付与（cleanup で削除）。notifyDialog の cleanup 対象にも `notify-title-danger` を追加して副作用防止

E2. **CSS** ([src/styles.css](src/styles.css)): `.progress-title.notify-title-danger { color: var(--danger); }` を追加

E3. **テキストクリア → 削除** ([index.html](index.html) + [src/txt-source.js](src/txt-source.js)):
- `#clear-txt-btn` の title / aria-label を「テキストをクリア」→「テキストを削除」
- 確認ダイアログ: title「テキストの削除」（赤）/ message「読み込んだテキストを削除します。よろしいですか？」/ confirmLabel「削除」/ kind: `"danger"`
- 完了 toast: 「テキストを削除しました」

### F. サイドバーの折り畳み連動レイアウト

F1. **テキスト編集 collapsed → 原稿テキスト拡張** ([src/styles.css](src/styles.css))
- `:has()` セレクタで `.side-panel:has(.panel-section[data-section="editor"].collapsed) .panel-section[data-section="txt"]:not(.collapsed)` を狙い、`max-height: none; flex: 1 1 auto` を上書き
- 原稿テキスト 34vh の上限を解除して残余高を全部吸収

F2. **テキスト編集 collapsed → h2 が底辺貼り付き** ([src/styles.css](src/styles.css))
- `.side-panel .panel-section[data-section="editor"].collapsed { flex: 0 0 auto; }` で残余高を取らない
- `.side-panel:has(.panel-section[data-section="txt"]:not(.collapsed)) .panel-section[data-section="editor"].collapsed { margin-top: auto; }` で「原稿展開中 + 編集折畳中」のときだけ底辺貼り付き
- **両方折り畳み時**: `margin-top: auto` が発動しないので、編集 h2 は原稿 h2 の直下に自然に並ぶ（ユーザー指摘で 2 段ルール化）

> **動作マトリクス**:
> | 原稿 | 編集 | レイアウト |
> |---|---|---|
> | 展開 | 展開 | 既定（原稿 34vh、編集 残り） |
> | 展開 | 折畳 | 原稿が伸びて、編集 h2 が底辺貼り付き |
> | 折畳 | 展開 | 原稿 h2 のみ上、編集が残り |
> | 折畳 | 折畳 | 原稿 h2 → 編集 h2 が連続して上に並ぶ |

### G. 校正パネルのフォルダ名 + 巻数表示

G1. **DOM** ([index.html](index.html)): `proofread-panel-header` と `proofread-body` の間に `<div id="proofread-meta" class="proofread-meta" hidden>` を挿入

G2. **`deriveProofreadMeta(filePath)`** ([src/proofread.js](src/proofread.js)): JSON パスを `[\\/]` で split し、想定構造 `.../<作品>/<巻>/校正チェックデータ/<json>` から「作品名 / 巻数」を導出
- 直近の親が `校正チェックデータ` なら 1 段スキップ（MojiQ 流の自動降下と整合）
- その上の階層を「巻数」、さらに 1 段上を「作品フォルダ名」として返す
- 階層が浅いケースは取れる範囲だけ（不足は空文字）

G3. **`renderProofreadMeta()`**: `renderPanel` の body 描画前に呼ぶ。results ビュー時のみ表示
- フォルダ + 巻数が両方取れない場合は **JSON 内の `work` 名 → ファイル名 → "(読込済み)"** の順でフォールバック表示（checkData がある以上は何かしら可視化する）

G4. **CSS** ([src/styles.css](src/styles.css)): `.proofread-meta`（panel-header と同 padding/border-bottom + flex-row + 12px font）、`.proofread-meta-folder`（太字）、`.proofread-meta-volume`（muted 色）、`.proofread-meta-sep`（細い区切り、opacity 0.6）

### H. 自動配置ボタンの色を MojiQ Pro 緑系に

H1. **配色変更** ([src/styles.css](src/styles.css) `.ai-place-btn`): MojiQ Pro `.preset-icon-btn.folder-btn` (PresetPanel.css) の緑系パレットに統一
- ダーク: 通常 `transparent` bg / `#4caf50` border / `#4caf50` text、hover `#2e7d32` bg / `#81c784` border / `#c8e6c9` text
- ライト: 通常 `transparent` / `#2e7d32` / `#2e7d32`、hover `#a5d6a7` bg / `#1b5e20` / `#1b5e20`
- ユーザー要望で「背景色は不要」「ボタンテキストとアイコンの色をフチの色と合わせる」「ホバー時は緑背景」「ライトモードは色を濃く」の 4 段反復で確定
- SVG アイコンは `stroke: currentColor` で文字色追従

### バージョン

I1. **1.4.3 → 1.4.4** ([package.json](package.json) / [src-tauri/Cargo.toml](src-tauri/Cargo.toml) / [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) を同期更新)。Cargo.lock も `cargo build` / `npm run tauri build` 経由で自動追従

> **構造変更まとめ**:
> - 旧: 画像スキャンは毎回ファイル選択ダイアログ → 新: 見本が読み込まれていれば即 OCR、未読込ならダイアログ。ai-place 自動 OCR も同じく全見本ファイル対象
> - 旧: TXT は読込専用 → 新: パネル右上の保存ボタンで UTF-8 TXT 出力可能（OCR 結果も再保存可能）
> - 旧: ページ送りは PSD / PDF どちらかが必須 → 新: TXT 単体読込でもマーカー数に従って ←/→ で送れる（pdfPageIndex を流用）
> - 旧: TXT パラグラフ削除は手動編集のみ → 新: クリック選択 → 削除ボタン or Delete/Backspace で 1 段落削除（ページマーカー保持）
> - 旧: 「テキストをクリア」 → 新: 「テキストを削除」 + 赤タイトル confirmDialog (`kind: "danger"`)
> - 旧: 編集セクション折畳でも原稿テキストは 34vh で固定 → 新: `:has()` で原稿テキストが残余高を吸収、編集 h2 は底辺貼り付き
> - 旧: 校正パネルは JSON 名のみ → 新: panel-header と body の間に「作品名 / 巻数」のメタ行を追加
> - 旧: 自動配置ボタンは画像スキャンと同じグレー系 → 新: MojiQ Pro 互換の緑系（border + text 緑、hover 緑 bg）
