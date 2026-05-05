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

---

## v1.5.0: 大規模リファクタ + テキストエディタモード + view-mode 3 値化 + 校正パネル機能拡張

### 概要

このバージョンは 3 つの柱から成る:
1. **コードベース全面リファクタ** (history transient 安全化 / state.js factory 化 / main.js 機能別分割)
2. **テキストエディタモードの新設** (view-mode-segment を `parallel | proofread | editor` の 3 値化)
3. **校正パネルの MojiQ 互換機能拡張** (カテゴリトグル / チェックボックス / 「済」バッジ)

加えて自動配置・テキスト編集・各種 UI の細かい改善を多数含む。

---

### A. コードベース全面リファクタ

#### A1. `withHistoryTransient(fn)` ヘルパー (履歴の安全化)

[src/state.js](src/state.js) に `withHistoryTransient(fn)` を新設し、以下のパターンを置換:
```js
// 旧: try/finally なしで 8〜12 箇所に散在
beginHistoryTransient();
try { ... } finally { /* commit / abort 手動 */ }

// 新:
withHistoryTransient(() => { ... });
```

仕様:
- depth カウンタを保ったまま fn を実行
- fn が `false` を返したら push をスキップ（mutation なし）
- fn が throw → depth を巻き戻して再 throw（履歴が壊れない）

置換対象: [src/canvas-tools.js](src/canvas-tools.js) の `nudgeSelectedLayers` / `deleteSelectedLayers` / `resizeSelectedLayers` / in-place 編集 afterCommit、[src/text-editor.js](src/text-editor.js) の `commitStrokeFields` / `commitFontToSelections` / `commitFillField` / レイヤー削除。drag handlers (rotate / multi-drag) は begin/commit が別イベントに跨るので imperative API のまま残置。

#### A2. main.js の機能別分割

1655 行 / 25 個の `bindXxx` がほぼ平坦に並んでいた [src/main.js](src/main.js) から、保存系と PSD 読込系を独立モジュールへ:

- [src/utils/path.js](src/utils/path.js) — `baseName` / `parentDir` / `joinPath`（純粋ユーティリティ）
- [src/bind/save.js](src/bind/save.js) — `bindSaveMenu` / `handleOverwriteSave` / `handleSaveAs` / `runSaveWithMode` + 内部 state（`hasSavedThisSession` / `saveMenuOpen` / `saveInflight`）
- [src/services/psd-load.js](src/services/psd-load.js) — `pickPsdFiles` / `loadPsdFilesByPaths` / `handleOpenFiles` / `listPsdFilesInFolder`

[src/ai-place.js](src/ai-place.js) → main.js の `await import("./main.js")` 動的 import を **静的 import に置換** して循環参照を解消。`services/psd-load.js` 経由で `pickPsdFiles` / `loadPsdFilesByPaths` を直接 import。

UI 同期は `psdesign:psd-loaded` CustomEvent 経由で疎結合化（main.js 側で listener 登録 → updatePageNav / updatePsdRotateVisibility / updatePsdGuidesLockVisibility を呼ぶ）。

main.js: 1655 → **1403 行** (-252 行)。bind/save.js + services/psd-load.js + utils/path.js で計 303 行に分割。

#### A3. state.js の listener factory 化

[src/state.js](src/state.js) に `createObservable(initial, normalize)` ファクトリを新設し、24 個の `*Listeners: new Set()` + 97 個の `get/set/on*` ペアの手動コピペを排除。

```js
const $tool = createObservable("move", _normTool);
export const getTool = $tool.get;
export const setTool = $tool.set;
export const onToolChange = $tool.on;
```

19 個の単純スロットを factory 化:
- tool / textSize / leadingPct / currentFont / strokeColor / strokeWidthPx / fillColor
- pdfZoom / psdZoom / pdfRotation / psdRotation / pdfPageIndex
- pdfSplitMode / pdfSkipFirstBlank / parallelSyncMode / activePane / parallelViewMode / framesVisible

`state` object から該当フィールドを撤去し、定義の重複コピペが消滅。state.js: 807 → **716 行** (-91 行)。

複合状態 (currentPageIndex / pdfDoc / aiOcrDoc / editingContext / txtSource / history) は意図的に factory 化せず元のまま（factory では表現しづらいセマンティクスを持つため）。

---

### B. テキストエディタモード（新規）

#### B1. view-mode-segment を 3 値化

ヘッダーの `.sync-segment.view-mode-segment` を `parallel | proofread | editor` の 3 ボタン構成に拡張。`#view-psd-only-btn` は廃止（旧 `"psdOnly"` 値は state.js の `_normParallelViewMode` で `"parallel"` にフォールバック）。

| mode | pdf-area | psd-area | proofread overlay | editor-area | サイドバー類 |
|---|---|---|---|---|---|
| **parallel** | 表示 | 表示 | 閉じる | 非表示 | 表示 |
| **proofread** | 表示 | 表示 | **pdf-stage 上に overlay** | 非表示 | 表示 |
| **editor** | 非表示 | 非表示 | spreads-proofread-area の flex pane へ移動 | 表示 | 非表示（編集に集中）|

editor モードでは workspace に `editor-mode` class を付与し、CSS で `.spreads-pdf-area` / `.spreads-psd-area` / `.side-toolbar` / `.side-panel` を `display: none !important` にして編集に集中できるレイアウトにする。

#### B2. proofread-panel の DOM 移動方式

校正パネルは単一 DOM。view-mode によって配置先と class を切替える:

- **proofread モード**: `.spreads-pdf-area` 内 `position: absolute; inset: 0; z-index: 50` の overlay (`.proofread-overlay` class)
- **editor モード**: `.spreads-proofread-area` 内 `position: relative; flex: 1` の通常 pane (`.proofread-pane` class)
- **parallel モード**: pdf-area 内に置いておく（hidden 属性で非表示）

`bindParallelViewMode` の sync() で `proofreadPanel.parentElement` を比較しながら `appendChild` で移動 + class 付替え。同じ DOM を共有することで、読込済み JSON / 折り畳み状態 / タブモードがモード切替後も保持される。

#### B3. spreads-editor-area + editor-pane.js

新規ペイン構成:
- [index.html](index.html): `.spreads-editor-area` に filename row + editor-toolbar-row2 + textarea + footer
- [src/bind/editor-pane.js](src/bind/editor-pane.js) — エディタ全体の DOM 配線
  - **共有バッファ**: `state.txtSource` を直接読み書き（サイドパネル `txt-source-viewer` と双方向同期）
  - **suppressInput フラグ**: 外部 setTxtSource → textarea 反映時の再帰 input イベントを抑止
  - **focus 中のカーソル位置保持**: 外部更新でも `selectionStart` / `End` / `scrollTop` を保存・復元
  - **handleSaveAuto**: 元ファイルパスがあれば上書き、無ければ別名保存（path-less 経路でも初回保存可）

state.js に新規 observable 2 つ追加:
- `$txtFilePath` — TXT の元ファイルパス（loadTxtFromPath で set / OCR / browser D&D 経路は null）
- `$txtDirty` — 未保存変更フラグ（textarea input で true、保存 / 読込で false）

#### B4. promptDialog ヘルパー

[src/ui-feedback.js](src/ui-feedback.js) に `promptDialog({title, message, defaultValue, placeholder})` を新設。confirm-modal の DOM を流用して `<input>` を動的挿入、`Promise<string | null>` を返す。エディタの「ルビ付け」でふりがな入力ダイアログとして使用。

#### B5. editor-textarea 空状態表示

textarea が空のときは `txt-source-empty` と同じデザイン（書類アイコン + TXT 文字 + メッセージ）を **pointer-events: none の overlay** として `position: absolute; inset: 0` で乗せる。下層の textarea がクリックを受けるので、ユーザーがクリックすると自然に textarea にフォーカス → 入力で content が変わり overlay は自動的に非表示。

`.editor-textarea-wrap` でラップして `position: relative` を anchor に提供。

#### B6. editor-toolbar-row2

ファイル操作 row1 (開く / 保存 / 別名 / コピー / クリア) を撤去し、編集操作 row2 にスリム化:
- ルビ付けボタン（lucide ruby icon）— 選択文字列を「親（ふりがな）」形式に置換
- テキスト保存ボタン（lucide download icon）— 元ファイル有り → 上書き、無し → 別名保存に自動分岐

旧 `// 削除マーク` ボタンと `editor-toolbar-row1` は仕様変更により削除済み。

---

### C. 校正パネル機能拡張（MojiQ 互換）

#### C1. カテゴリ トグル化（折り畳み）

[src/proofread.js](src/proofread.js) の `renderItemsGrouped(items)` を新設し、フラット項目リストを `item.category` でグループ化。各カテゴリは `proofread-category` ヘッダー + body 構造に:

- ヘッダー: チェックボックス + ▼ 矢印 + カテゴリ名 + 件数 + 「済」バッジ
- ボディ: 各 `proofread-item` をネスト
- ヘッダークリックで `.collapsed` トグル → body 非表示
- `collapsedCategories: Set<string>` でユーザーの開閉状態を renderPanel 再生成後も保持
- カテゴリ名 50 音順ソート（`Intl.Collator("ja")`）
- 各カテゴリの border-left に `getCategoryColor()` 由来の色（10 色パレット）

#### C2. カテゴリ + アイテム チェックボックス

`createCheckbox({checked, cssClass, iconClass, onChange})` ヘルパー（hidden input + 装飾 span パターン）。MojiQ 互換のスタイル:
- カテゴリ用 11×11、アイテム用 14×14
- 通常: 透明背景 + muted border
- チェック時: 緑塗り（`#4caf50`）+ 白チェックマーク（45° 鍵型）

state:
- `checkedCategories: Set<string>` — チェック済みカテゴリ
- `checkedItems: Set<string>` — `${cat}|${idx}` 形式のキーでチェック済み項目

#### C3. 「済」バッジ + 連動同期

カテゴリヘッダー右端に緑の「済」バッジ。**双方向自動同期**:

| 操作 | カテゴリ ☑ | 各項目 ☑ | 折り畳み | 済バッジ |
|---|---|---|---|---|
| カテゴリ ☑ チェック | ☑ | **全 ☑（自動）** | 自動畳み | 表示 |
| カテゴリ ☑ 解除 | ☐ | **全 ☐（自動）** | 維持 | 非表示 |
| 項目を 1 つずつ ☑ | 全件達成で ☑（自動） | 個別 | 全件達成で自動畳み | 全件達成で表示 |
| 項目を 1 つ ☐ | **☐（自動）** | 個別 | 維持 | 非表示 |

`refreshDoneBadge(source)` を `"init" | "item" | "category"` の 3 値で呼び分け、`source === "item"` のときだけカテゴリ↔項目の相互同期と自動畳みを実行。`itemRefs` 配列に各項目の `{itemKey, el, input}` を保持してカテゴリ変更時の一括 ON/OFF を可能に。

#### C4. その他

- `proofread-cat-badge` / `proofread-kind` 表示を撤去（カテゴリトグル化で重複情報を排除）
- `proofread-page-link` を **薄い青 + 13px** に変更（ダーク `#64b5f6` / ライト `#1976d2`、hover で更に濃く）
- `proofread-empty-icon` のサイズを 64×64 → **40×40** に縮小（`txt-source-empty-icon` と統一）
- empty 状態のアイコン↔メッセージ間隔を `gap: 12px → 4px` に縮小
- `proofread-col-header` の文字サイズを 10px → **13px** に拡大

---

### D. 自動配置・テキスト編集機能の強化

#### D1. 配置済みレイヤーへの編集追従

[src/state.js](src/state.js) `addNewLayer` に `sourceTxtRef: { pageNumber, paragraphIndex } | null` を追加。自動配置時に各レイヤーへ「元 TXT 段落への参照」を埋め込む。

[src/ai-place.js](src/ai-place.js) `syncPlacedFromTxt()`:
- `onTxtSourceChange` listener で発火
- `parsePages` で TXT を再パース → `sourceTxtRef` を持つ各レイヤーの `paragraphs[paragraphIndex]` を取り出して contents を更新
- **中心固定で位置再計算**: contents 変化で `estimateLayerSize` の bbox サイズが変わるため、旧 contents の bbox 中心を計算し、新 contents の bbox を中心起点で再配置（左上ずれを防止）
- `beginHistoryTransient` / `abortHistoryTransient` で履歴 push を 1 件にまとめる

#### D2. テキストフレーム見切れバグ修正

[src/canvas-tools.js](src/canvas-tools.js) `layerRectForExisting` / `layerRectForNew` と [src/ai-place.js](src/ai-place.js) `estimateLayerSize` の `thick` 式に **0.4em の安全余白** を加算（CJK 縦書きで小書き仮名・stroke の outset 半分が見切れる問題を解消）。

CSS で内側テキスト要素に padding を追加してテキストを bbox 中央に視覚配置:
- 縦書き: `padding-left: 0.2em; padding-right: 0.2em;`
- 横書き: `padding-top: 0.2em; padding-bottom: 0.2em;`

bbox がどれだけ広がっても、`box-sizing: border-box` のためコンテンツ領域は旧サイズ（leadingFactor × lineCount）と一致し、視覚位置は不変。

#### D3. 原稿テキスト dblclick で contenteditable 編集

[src/txt-source.js](src/txt-source.js) の dblclick 経路を「配置済みフレームの in-place 編集」から **「viewer 内で contenteditable 直接編集」** に変更。`startInlineEdit(el, originalText, pageNumber)`:

- 該当 `.txt-block` に `contentEditable="true"` + `.editing` class
- 全文選択してフォーカス
- **Ctrl+Enter / Cmd+Enter** または **blur** で確定 → `updateTxtSourceBlock` で原稿全体を書換 → `onTxtSourceChange` 経由で配置済みレイヤーも自動同期
- **Esc** で取消（元テキストに戻す）
- 通常 Enter は改行（contenteditable のデフォルト挙動）

CSS `.txt-block.editing`: accent 枠 + cursor: text + user-select: text。

廃止: `findPlacedLayerByText` / `normalizeForMatch` / `enterInPlaceEditForLayer` import。

---

### E. 画像スキャン UX 改善

#### E1. 完了ダイアログ + 「自動配置」即遷移

[src/ai-ocr.js](src/ai-ocr.js) の完了通知を `notifyDialog` から **`confirmDialog`（2 ボタン）** に変更:
- title「画像スキャン完了」、緑チェック SVG
- 左「戻る」（cancel） / 右「自動配置」（緑塗り primary）
- 「自動配置」を押すと `#ai-place-btn` の click を発火 → 既存の自動配置確認モーダルへ遷移

[src/ui-feedback.js](src/ui-feedback.js) `confirmDialog` を拡張:
- `kind: "success" | "warning" | "danger" | "default"` をサポート（タイトルアイコン + 色）
- `confirmKind: "primary" | "place"` で OK ボタンスタイル切替（`.page-jump-btn-primary`（青塗り）/ `.page-jump-btn-place`（緑枠、ai-place 互換））
- `applyTitleIcon` ヘルパーで `notifyDialog` と icon ロジックを共有

#### E2. 「現在のテキストは破棄されます」事前警告

画像スキャンボタン押下時に既に TXT が読み込まれている場合、ファイル選択 / OCR 実行のコストが発生する前に `confirmDialog` (kind: danger) で警告。キャンセルなら静かに戻る。

#### E3. 進捗ダイアログ改善

- タイトル: 「画像スキャン」→ **「画像スキャン実行中」**
- 各フェーズの detail に **完了見積時間**（`約 N 分`）を併記。`estimateRemainingSeconds(fileCount)` = `15 + fileCount * 30` 秒（CPU/GPU・ページ数で大きくぶれるので「約」付き）
- OCR 実行中で tqdm eta が確定したら実値（残り 30秒 / 1分20秒）に切替
- 右下のページ数表示（`1 / N`）を画像スキャン時のみ抑止（detail テキスト側で進捗を見せているため重複）。`updateProgress({showCount: false})` オプションで他モーダル（PSD 読込・Photoshop 保存）には影響なし

#### E4. 見本ファイル loadReferenceFiles 連携

画像スキャンボタンから `pickInputFiles` で PDF / 画像を選択した場合、OCR 開始前に **`loadReferenceFiles(files)` で pdf-stage に表示** 。ユーザーが OCR の進捗中にも見本を確認できる。失敗時は toast で通知して OCR は継続。

---

### F. ページナビゲーション・操作系

#### F1. マウススクロールでページ送り

[src/main.js](src/main.js) `bindWheelPageNav()`: `.spreads-pdf-area` / `.spreads-psd-area` に wheel リスナーを追加。

- **同期モード**: どちらのペインでスクロールしても `advancePage(±1)` で両ペインが同時に移動
- **非同期モード**: スクロールしたペインだけが動く（`getActivePane` に依存しない）

Alt / Ctrl / Meta は通過（既存ズーム / ブラウザ既定に委ねる）。120ms のリーディングエッジ throttle で連続スクロール暴走を抑止。`onLayerWheel` が選択レイヤー上で `stopPropagation` するため、レイヤー枠上は従来通りサイズ変更が優先。

#### F2. ガイドロックボタンの disabled 制御

[src/rulers.js](src/rulers.js) に `onGuidesChange(fn)` listener と `hasAnyGuide(psdPath?)` を新設。`addGuide` / `moveGuide` / `removeGuide` で発火。

[src/main.js](src/main.js) `bindPsdGuidesLock`: ガイドが 1 本も引かれていなければ `btn.disabled = true`（global の `button:disabled { opacity: 0.5; cursor: not-allowed }` でグレーアウト）。`onPageIndexChange` 購読で対象 PSD のガイド有無に追従。

---

### G. その他 UI・スタイル整理

- TXT actions の保存 / 削除 / 再読み込みボタンを整理:
  - **テキスト削除ボタン**（trash-2 アイコン、保存と再読み込みの間）— `confirmDialog kind: danger` → `clearTxtSource`
  - **テキスト再読み込みボタン**（rotate-cw アイコン）— 確認後 `pickTxtPath` → 新ファイルで上書き
  - **テキスト保存ボタン**（download アイコン）— `pickTxtSavePath` → `setTxtFilePath` 更新
  - 全て常時表示、TXT 未読込時は disabled でグレーアウト
- 画像スキャンボタンを MojiQ 互換の **青枠透明背景** デザインに（`.panel-load-btn` 同等、hover で薄い青 bg）
- `editor-mode` button アイコンを `pen-square` から **`check-square`** に変更（校正トグルボタンと統一）
- `editor-mode` button を `view-proofread-btn` の右隣に配置（parallel → proofread → editor の順）
- `editor-toolbar-row1` を撤去（開く / 保存 / 別名 / コピー / クリアボタンは旧仕様、row2 に統合）

---

### バージョン同期

`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` を **`1.5.0`** に揃え。Cargo.lock も `cargo build` 経由で自動追従。

> **構造変更まとめ**:
> - 旧: state.js が 24 個の listener Set + 97 個のコピペ get/set/on で 807 行 → 新: createObservable factory で 19 スロットを宣言的に定義し 716 行
> - 旧: main.js 1655 行に bindXxx 25 個が平坦に並ぶ → 新: bind/save.js + services/psd-load.js + utils/path.js に分割し main.js は 1403 行
> - 旧: history transient の begin/commit/abort 3 連が手書き 8〜12 箇所 → 新: withHistoryTransient(fn) で例外時も depth が壊れない安全 API
> - 旧: view-mode-segment は parallel / psdOnly の 2 値 → 新: parallel / proofread / editor の 3 値 + workspace.editor-mode CSS で側ペイン格納
> - 旧: 校正パネルはフラット項目リスト + cat-badge + kind ラベル → 新: カテゴリトグル + チェックボックス + 「済」バッジ + 双方向同期（MojiQ 互換）
> - 旧: 自動配置レイヤーは TXT 編集後も古い contents のまま → 新: sourceTxtRef + onTxtSourceChange で自動追従、bbox 中心固定で位置維持
> - 旧: 縦書き小書き仮名・stroke が見切れる → 新: thick + 0.4em 余白 + CSS padding でテキスト中央配置（位置不変）
> - 旧: 画像スキャン進捗は detail テキストに残り時間のみ → 新: 完了見積（約 N 分）+ tqdm eta 確定後は実値に切替、右下カウント抑止
> - 旧: 見本上の wheel = ペインスクロール → 新: wheel = ページ送り（同期 / 非同期で動作切替）、Alt+wheel ズームは従来通り

---

## v1.6.0: カスタムファイル選択ダイアログ・全モーダルアニメ・プログレスバー刷新・各種 UX 改善

### A. OS ネイティブダイアログを廃止しカスタムファイル選択ダイアログに全面移行

A1. **新規モジュール `src/file-picker.js`**: 単一の export `openFileDialog(opts)` を提供する中央モーダル形式のファイル選択ダイアログ。`opts.mode` で `"open"` / `"save"` / `"openFolder"` を切替え、Promise で `string | string[] | null` を返す。
- **DOM**: `index.html` 末尾の `#file-picker-modal` (z-index 250)。`.file-picker-card` 内に header + toolbar (drives + nav) + list + savebar + footer の 5 段構成
- **ナビゲーション**: 戻る / 進む / 上へ ボタンと、Windows ドライブ一覧ボタン。校正パネル ([src/proofread.js](src/proofread.js)) と同じ navStack / forwardStack のセマンティクスを踏襲
- **複数選択**: `mode:"open"` + `multiple:true` のとき Ctrl+クリックでトグル、Shift+クリックで範囲選択（OS のエクスプローラ準拠）
- **保存モード**: `mode:"save"` のとき下部に `<input class="file-picker-name-input">` + 「保存」ボタン。filename を入力して確定、拡張子は filters の先頭から自動付与
- **キーボード**: Enter 確定 / Esc キャンセル / Backspace 戻る（input 内除く）
- **隠しファイル**: 先頭が `.` のものは既定で非表示

A2. **前回パス記憶 (localStorage)**: 各呼び出しに `rememberKey` を渡すと、確定時の親ディレクトリ + ナビゲーションのたびに `psdesign_file_picker_last_path__<key>` で保存。次回同じ key で開いたとき直前にいた階層から再開（キャンセルでも記憶される）。
- 用途別キー: `psd-open` / `reference-open` / `txt-open` / `txt-save` / `ai-ocr-open` / `save-as-parent`

A3. **置換した 7 箇所**: 既存の `pickXxx` 関数の内部だけを `openFileDialog` 経由に差し替え、外部 API（戻り値型）は不変。
- [src/services/psd-load.js](src/services/psd-load.js) `pickPsdFiles` → `mode:"open", multiple:true, filters:[psd]`
- [src/pdf-loader.js](src/pdf-loader.js) `pickReferenceFiles` → `pdf, jpg, jpeg, png`
- [src/ai-ocr.js](src/ai-ocr.js) `pickInputFiles` → `pdf` + 各種画像形式
- [src/txt-source.js](src/txt-source.js) `pickTxtPath` / `pickTxtSavePath`
- [src/bind/editor-pane.js](src/bind/editor-pane.js) は `pickTxtSavePath` を import 経由で再利用（変更不要で自動連動）
- [src/bind/save.js](src/bind/save.js) `pickSaveParentDir` → `mode:"openFolder"`

A4. **Rust 側コマンド追加** ([src-tauri/src/lib.rs](src-tauri/src/lib.rs)):
- `list_drives() -> Vec<DriveInfo>`: Windows は A:〜Z: のうち存在し、かつネットワーク／クラウドドライブ**ではない**ドライブのみを返す
  - `GetDriveTypeW` で `DRIVE_REMOTE` / `DRIVE_UNKNOWN` / `DRIVE_NO_ROOT_DIR` を除外
  - `GetVolumeInformationW` でボリュームラベル / FS 名を取得し、`google drive` / `googledrive` / `drivefs` / `onedrive` / `dropbox` / `box drive` / `boxdrive` のいずれかを含むものを除外（Google Drive for Desktop は `DRIVE_FIXED` で報告されるため type 判定だけでは弾けない）
  - 依存追加: `winapi = { version = "0.3", features = ["fileapi"] }`（Windows ターゲット限定）
- `home_dir() -> Result<String, String>`: Windows は `USERPROFILE`、Unix は `HOME` から取得。defaultPath / remember 値が両方無いときの起点

A5. **モーダル表示形式の確定設計判断（事前ヒアリング）**:
- 中央モーダル
- 前回の場所を記憶 + ドライブ選択 UI
- Ctrl+クリック / Shift+クリック で複数選択
- 保存ダイアログは下部にファイル名入力欄

A6. **CSS の defensiveness**: 起動時に `.file-picker-modal { display: flex }` が `[hidden]` 属性を上書きして「空のモーダルが表示されたままフリーズ」した事故を防ぐため、`.file-picker-modal[hidden] { display: none; }` を明示。同パターンは既存の `.progress-modal` / `.settings-modal` / `.update-modal` でも採用済み。

A7. **ナビ矢印アイコンを Unicode 化**: 戻る `←` / 進む `→` / 上へ `↑` を SVG ではなく Unicode 文字で表示。テーマ・disabled 状態によらず確実に視認できるよう `font-weight: 700` + Symbol フォント優先。

A8. **文字サイズ底上げ**: タイトル 14→15px / ドライブボタン 11→13px / ナビ 14→16px / 行 12→14px / 保存名入力 12→13px / カウンター・footer ボタン 11→13px。フォルダ・ファイルアイコン SVG も 14→16px。

### B. 全モーダルに「奥から手前」のフェード＋スケールアニメーション

B1. **共通ヘルパー** ([src/ui-feedback.js](src/ui-feedback.js)): `showModalAnimated(el)` / `hideModalAnimated(el, ms = 220)` を新規 export。
- 開く: `el.hidden = false` → `requestAnimationFrame` 2 段で `.visible` クラス付与（hidden 解除と同フレームで .visible を付けると初期状態が確定する前に終端へ飛んで transition が効かないため 2 段必要）
- 閉じる: `.visible` を即座に外して transition を発火 → 220ms 後に `hidden = true`。setTimeout 内で `.visible` の有無を再チェックし、その間に次のダイアログが開いた場合は `hidden=true` を打たないガード付き

B2. **CSS パターン**: `.modal { opacity: 0; transition: opacity 0.22s ease; pointer-events: none; }` + `.modal.visible { opacity: 1; pointer-events: auto; }` + `.modal-card { transform: scale(0.92); transition: transform 0.22s cubic-bezier(0.2, 0.7, 0.3, 1.0); }` + `.modal.visible .modal-card { transform: scale(1); }` の 4 ルールを各モーダル class に適用。

B3. **対象モーダル一覧**:
| モーダル | 用途 |
|---|---|
| `.progress-modal` (`#progress-modal`) | PSD 読込中・Photoshop 反映中・画像スキャン進捗 |
| `.progress-modal` (`#confirm-modal`) | 確認ダイアログ + 完了通知 + 入力ダイアログ（共通 DOM） |
| `.progress-modal` (`#resync-modal`) | 同期モード切替時の選択 |
| `.progress-modal` (`#page-jump-modal`) | Ctrl+J ページジャンプ |
| `.settings-modal` (`#settings-modal`) | 環境設定 |
| `.settings-modal` (`#key-capture-modal`) | ショートカットキー入力 |
| `.file-picker-modal` | カスタムファイル選択 |
| `.update-modal` | 既にアニメ実装済み（参考実装） |

B4. **JS 側差替え箇所**:
- [src/ui-feedback.js](src/ui-feedback.js) `showProgress` / `hideProgress` / `confirmDialog` / `notifyDialog` / `promptDialog`
- [src/settings-ui.js](src/settings-ui.js) `openModal` / `closeModal` / `openKeyCapture` / `closeKeyCapture` （ui-feedback から `showModalAnimated` / `hideModalAnimated` を import）
- [src/main.js](src/main.js) `openResyncModal` / `closeResyncModal` / `openPageJumpDialog` / `closePageJumpDialog`

B5. **クリーンアップの遅延**: `confirmDialog` / `notifyDialog` / `promptDialog` の `cleanup` 内で行っていた DOM 副作用（`titleEl.textContent` リセット、Cancel ボタン hidden 復帰、prompt の `<input>` 削除）は `setTimeout(MODAL_ANIM_MS)` でフェード完了後に遅延実行。フェード中に内容が瞬時に変わるチラつきを防止。

### C. プログレスバー刷新（LOADING テキスト reveal + 流れるフラッシュ）

C1. **DOM 構造変更** ([index.html](index.html)): `.progress-track` 内に `<span class="progress-loading-text" aria-hidden="true">LOADING...</span>` を追加。

C2. **「LOADING...」テキストの reveal 効果**:
- `.progress-track`: 高さ 6px → **32px**、背景 `var(--bg)` → 薄いグレー `#d0d0d0`、border 撤去
- `.progress-fill`: `position: absolute` で track 全高、青グラデ `linear-gradient(90deg, #2e6cd6 → #5fa1ff)`
- `.progress-loading-text`: monospace / 700 / letter-spacing 0.18em / 文字色 `#d0d0d0`（track と同色）→ 初期透明
- 仕組み: 青いバーが下を通過した部分だけ「青背景 × グレー文字」のコントラストで自然に浮き上がる（`clip-path` / `mask` 不要）

C3. **流れるフラッシュ**:
- `.progress-fill::after` に幅 35% の白半透明グラデ（105°、中央 alpha 0.55、両端 transparent）
- `@keyframes progress-flash`: `translateX(-120%) → 320%`、後半 40% は画面外で待機して脈動感を出す
- `.progress-modal.visible .progress-fill::after { animation: progress-flash 2.2s linear infinite }` で `.visible` 中だけループ
- `.progress-fill { overflow: hidden }` でフラッシュをバーの可視領域内にクリップ

C4. **70% で止まる旧仕様の廃止**: 当初は CSS keyframe で 0% → 70% に進めて停止する装飾アニメだったが、「進捗が 70% で止まったように見えて誤解を生む」とのフィードバックで **JS 駆動の実進捗ベース** に戻した。`updateProgress` で `fill.style.width = ${pct}%` を直書き、current/total が無いときは `.indeterminate` クラスでバー満タン表示にしてフラッシュだけ動かす。

C5. **残りページ数 + 進捗% 表示**:
- 旧 `1 / 6` → 新 **`残り 5 ページ ・ 17 %`**
- `remaining = total - current` / `pct = Math.round(current / total × 100)` を `.progress-count` に整形して表示
- `showCount: false` のケース（AI 画像スキャンが detail 側で別途進捗表示）は引き続き抑止

C6. **ダイアログサイズ拡大**: `#progress-modal` ID スコープで `min-width 360→440px` / `max-width 520→600px` / `padding 20×24→24×28px` / `gap 10→14px`。他のモーダル（confirm/resync/page-jump、共有 `.progress-card` クラス）には影響しない。

### D. サイドバー トグルアニメーション

D1. **`interpolate-size: allow-keywords` 採用** ([src/styles.css](src/styles.css) `:root`): Chromium 129+ の機能で `height: auto ↔ 0` の transition を可能にする。未対応環境では instant 切替にフォールバック（壊れない）。

D2. **パネルセクション折り畳み（原稿テキスト / テキスト編集）**:
- 旧: `.panel-section.collapsed > *:not(.panel-section-h2) { display: none }` で瞬時消失
- 新: `height: 0` + `opacity: 0` + `padding/margin/border-width: 0` + `visibility: hidden` を 0.25s でトランジション
- `min-height: 0` と `flex: 0 0 0` も併設して、`.txt-source-dropzone { min-height: 80px; flex: 1 }` のような子要素の上書きを無効化（h2 直下までぴったり閉じる）
- `visibility: hidden` は `transition: visibility 0s linear 0.25s` で transition 完了後に適用 → tab フォーカスや支援技術からも除外、再展開時は即時 visible

D3. **サイドツールバー / サイドパネル全体**:
- 旧: width transition だけ（子要素は `display: none` で瞬時消失）
- 新: width 0.25s + 子要素を `opacity` 0.18s + `visibility` 遅延ディレイで同期フェード

### E. 環境設定ボタンをツールバーへ移動

[index.html](index.html):
- ハンバーガーメニュー footer から `#settings-btn` を撤去
- ツールバー `.toolbar-actions` 内、`#save-container` の直後に再配置（クラス `icon-btn file-open-btn`、SVG 22×22、保存ボタンと統一感）
- 既存 [src/hamburger-menu.js](src/hamburger-menu.js) の click ハンドラはそのままで、新しい場所の `#settings-btn` に自動でバインド（`closeMenu()` はメニュー未表示時 no-op）

### F. 起動時にデフォルトフォントを edit-font 欄に表示

[src/text-editor.js](src/text-editor.js):
- 旧: フォント入力欄 `#edit-font` の値は `commitFont` か `populateEditor`（レイヤー選択時）でしか書き込まれず、起動直後は空欄
- 新: `bindEditorEvents` 末尾で `syncFontInputFromState()` を呼び、`state.currentFontPostScriptName`（環境設定の defaults から `applyToolDefaults` で設定済み）を入力欄に反映
- `onCurrentFontChange` を購読し、選択 0 件のときだけ入力欄を再同期（選択時は populateEditor の責務）
- `onFontsRegistered` も購読し、フォント一覧が非同期登録された後にも再同期 → PostScript 名から表示名に解決

### G. 画像スキャンボタンの仕様変更

[src/ai-ocr.js](src/ai-ocr.js) `bindAiOcrButton`:
- 旧: 読込済み見本があれば再 OCR、無いときだけファイル選択
- 新: **毎回ファイル選択ダイアログを開く**（読込済み見本があっても破棄）。`loadReferenceFiles(files)` が新しい合成 doc で `state.pdfDoc` / `state.pdfPaths` を上書きするので旧見本は自動破棄
- ツールチップを「ファイルを選択して AI で画像スキャン」に統一
- 不要になった `getPdfPaths` の import を撤去

### H. 「テキストを削除」ボタンの仕様変更（全削除 → 選択中のみ削除）

[src/txt-source.js](src/txt-source.js):
- 旧: `#delete-txt-btn` クリックで `clearTxtSource()`（TXT 全体を削除）
- 新: `#delete-txt-btn` クリックで `deleteSelectedTxtBlock()`（選択中の段落のみ削除）
- 確認ダイアログ文言を「読み込んだテキストを削除します」→「選択中のテキストを削除します」に
- 有効状態を「TXT 読込中は常に有効」→「**選択中ブロックがあるときだけ有効**」に（`renderViewer` と `selectBlock` の両方で同期）
- 旧 `#delete-txt-block-btn`（footer 内のゴミ箱ボタン）と `#txt-source-footer` ラッパは撤去（選択削除機能は `#delete-txt-btn` に統合済みのため）
- TXT 全削除は **ハンバーガーメニュー「ホームに戻る」** 経由で引き続き可能

### I. TXT 段落削除時の自動配置レイヤー整合性修正（v1.5.0 のリグレッション）

[src/txt-source.js](src/txt-source.js) `deleteSelectedTxtBlock`:

**問題**: v1.5.0 D1 で導入した `sourceTxtRef = { pageNumber, paragraphIndex }` が、TXT 段落削除時に paragraphIndex の繰り上がりを考慮していなかった。
- 段落 idx=N を削除すると、paragraphs[N] は元の "段落 N+1" を指すようになる
- `syncPlacedFromTxt` は `paragraphs[ref.paragraphIndex]` を読んで contents を上書きするだけなので、削除した段落のレイヤーは消えず、内容が次段落で上書きされる（**重複表示バグ**）
- 後続のレイヤーも 1 つずつ繰り上がって全体がズレる

**修正**: `withHistoryTransient` で囲んだ単一 snapshot 内で:
1. `sourceTxtRef.paragraphIndex === idx` のレイヤーを `removeNewLayer` で削除
2. `sourceTxtRef.paragraphIndex > idx` のレイヤーは `paragraphIndex` を 1 デクリメントして整合化
3. その上で `setTxtSource` を呼ぶ → 後続 `syncPlacedFromTxt` は paragraphIndex が正しく指しているので contents 一致で no-op

**追加の手当て**: `syncPlacedFromTxt` は contents 変更がないと再描画しないため、レイヤー削除のときだけ `refreshAllOverlays` + `rebuildLayerList` を手動で呼ぶ。Ctrl+Z 一発で TXT 削除 + レイヤー削除 + paragraphIndex 補正がまとめて巻き戻る。

### バージョン同期

`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` を **`1.6.0`** に揃え。Cargo.lock も自動追従。Rust 側の新規依存 `winapi`（Windows 限定）が追加。

> **構造変更まとめ**:
> - 旧: 7 箇所で OS ネイティブの `@tauri-apps/plugin-dialog` `open()` / `save()` を使用 → 新: `src/file-picker.js` 1 モジュールで全置換、ドライブ選択 UI + 前回パス記憶 + Ctrl/Shift 複数選択
> - 旧: モーダルは `hidden` トグルで瞬時表示 → 新: 全モーダル統一で 220ms の `.visible` クラスベースのフェード＋スケール、cleanup は遅延実行でチラつき排除
> - 旧: プログレスバー = 細い 6px ライン、青ベタ塗り、`1 / 6` 数字のみ → 新: 32px 高、LOADING テキスト reveal + 流れるフラッシュ + `残り N ページ ・ P %` 表示、ダイアログも 1 回り大型化
> - 旧: 70% で止まる装飾 CSS keyframe（誤解を招くと判明し撤回）→ 新: 実進捗 (current/total) で width 駆動、indeterminate 時はフラッシュだけ動く満タン表示
> - 旧: サイドバー section toggle = `display: none` で瞬時消失 → 新: `interpolate-size` + `height` / `opacity` / `padding` 同時 transition で滑らかに開閉、min-height/flex の上書きも無効化
> - 旧: 環境設定 = ハンバーガーメニュー内 → 新: ツールバー保存ボタン直右、1 クリック起動
> - 旧: 起動時の edit-font 入力欄は空 → 新: 環境設定 defaults を即時反映、フォント非同期登録後に表示名解決
> - 旧: 画像スキャン = 読込済み見本を再利用 → 新: 毎回ファイル選択（旧見本は自動破棄）
> - 旧: ゴミ箱ボタン = TXT 全削除（誤操作リスク高）→ 新: 選択中段落のみ削除（自動配置済みレイヤーも整合的に削除 + paragraphIndex 補正）

---

## v1.7.0: 自動配置サイズ精度向上 + ガイドロックのディムマスク + ガイド複数反映 + 既存テキストフレーム算出修正

### 概要

このバージョンの 4 つの柱:
1. **自動配置のテキストサイズを見本に合わせる**（comic-text-detector の `font_size` 活用）
2. **ガイドロック時の外側ディム表示** + **ガイドを複数ページに一括反映**機能
3. **既存 PSD のテキストフレーム巨大化バグ修正**（写植で transform スケールがかかったレイヤー）
4. **テキストフレーム見切れバグ修正**（LONG 軸の安全余白追加）

加えてガイドロックの永続化撤廃、ロック中のガイド線非表示、サイドツールバー区切り線整形などの細かな UI 改善を含む。

### A. 自動配置のテキストサイズ自動推定

A1. **`detectSizePtFromBlock(block, mokuroPage, psdPage)` 新設** ([src/ai-place.js](src/ai-place.js))
- comic-text-detector が吹き出しごとに推定する `font_size`（OCR 入力画像のピクセル）を、対象 PSD の物理座標系での pt に換算して per-layer に適用
- 換算式: `pt = (font_size_px × scale) × 72 / dpi × FONT_SIZE_CALIBRATION`
  - `scale = min(sx, sy)`（縦書き / 横書きどちらでも安全側）
  - `FONT_SIZE_CALIBRATION = 0.92`（comic-text-detector の `font_size` は em-box 寄りに出るので glyph 相当に揃える経験補正）
- bbox 上限キャップ: `maxPt = (thick_axis / denom) × 72 / dpi`、`denom = 1 + (lineCount-1) × 1.25`
  - 1 行吹き出し: `denom = 1`（bbox とほぼ等価でキャップは緩め）
  - 2 行: `denom = 2.25`（leading 込みで em 1 つ分を逆算）
  - 多列ほど厳しく頭打ち、装飾フォント等の過大検出を抑える
- 環境設定の `textSizeStep`（0.1 / 0.5）に丸め、`[6, 999]` にクランプ
- 検出失敗時は `defaults.sizePt` にフォールバック

A2. **チューニング過程**: 初期実装は `1.0` 固定 → 過大気味 → `0.85 + bbox_cap` に補正 → 1 行が縮みすぎ → 最終的に **0.92 + leading 込みの厳密 bbox cap** に落ち着く。`FONT_SIZE_CALIBRATION` 単独調整 + `ASSUMED_LEADING_FACTOR` で 2 軸チューニング可能。

A3. **`mapBlockToNewLayer` の改修**: `defaults.sizePt` 直書きをやめ、検出値があれば優先採用。下流影響なし（`syncPlacedFromTxt` は `layer.sizePt` を保持して再計算、`jsx_gen.rs` の `nti.size` も per-layer sizePt を反映）。

### B. テキストフレーム見切れバグ修正（LONG 軸の安全余白）

B1. **問題**: v1.5.0 で THICK 軸に 0.4em の安全余白を追加したが、LONG 軸（テキスト流し方向）は `1.05 × chars`（5% per-char）のままだった。display 系フォント（F910コミックW4 など）の ascender/descender overshoot に対する余裕が実質ほぼ無く、特に検出 pt が小数（14.5pt 等）の場合に末尾文字が `overflow: hidden` で切れていた。

B2. **修正** ([src/canvas-tools.js](src/canvas-tools.js) `layerRectForExisting` / `layerRectForNew` + [src/ai-place.js](src/ai-place.js) `estimateLayerSize`):
```js
// 旧: ptInPsdPx * 1.05 * chars
// 新: ptInPsdPx * (1.05 * chars + 0.4)
```
THICK 軸と同じ 0.4em の固定 safety margin を LONG 軸にも入れて統一。3 文字で約 +13% の bbox 拡張で descender 切れを解消。

### C. 既存 PSD のテキストフレーム巨大化バグ修正

C1. **問題**: 写植テキストが既に入っている PSD を読み込むと、ラスタライズされたテキストの上に **数倍〜十数倍の巨大なテキストフレーム**が重なって表示される。原因は ag-psd の `style.fontSize` が「変形前の生 fontSize」を返すため。Photoshop で「100pt のテキストを 0.2× scale で配置」した場合 `style.fontSize = 100, transform = [0.2, 0, 0, 0.2, tx, ty]` となり、生値をそのまま使うと frame / 内文プレビュー / バッジ / size input が全て scale 前の pt で表示されていた。

C2. **解決アプローチ**: 当初 `text.transform` 行列の行列式 sqrt から実効 scale を逆算する方式を試したが、ag-psd の出力で transform が期待通り取れないケースがあったため、**PSD bounds（`layer.left/right/top/bottom`）から逆算**する方式に切り替え。bounds はラスタライズ後の実描画範囲を反映するので transform の有無に依存せず確実。

C3. **共通ヘルパー `getExistingLayerEffectiveSizePt(page, layer, edit)` を export** ([src/canvas-tools.js](src/canvas-tools.js)):
```js
// edit.sizePt が明示されていれば最優先（ユーザー編集を尊重）。
// それ以外は declared (layer.fontSize) と bounds-derived の min を採用（過大値を抑制）。
const thickPsdPx = isVertical ? rawWidth : rawHeight;
const tightDenom = 1 + Math.max(0, lineCount - 1) * 1.25;  // tight bbox 想定
const sizeFromBounds = (thickPsdPx / tightDenom) * 72 / dpi;
return Math.min(declaredSizePt, sizeFromBounds);
```
- bounds が tight（写植テキスト）→ bounds-derived（実描画 pt）が採用される
- bounds が padded（一部ツールが付加した余白）→ declared を尊重（min なので過大化しない）
- bounds が無効 → declared 素通し
- ユーザーが size を編集中 → `edit.sizePt` 最優先（`min` の対象外）

C4. **5 箇所で同じ実効 pt を共有** ([src/canvas-tools.js](src/canvas-tools.js) + [src/text-editor.js](src/text-editor.js)):
1. `layerRectForExisting` の frame 算出（rect.width/height + ptInPsdPx）
2. 内文プレビュー `inner.style.fontSize`（rect.ptInPsdPx 経由で同期）
3. `createSizeBadge` の表示 pt
4. サイドパネルの size input 初期値 / 反映値
5. レイヤーリストの meta 表示

C5. **副次的試み**: psd-loader.js に `effectiveFontSize(rawFontSize, transform)` を追加し、行列式 sqrt から scale を逆算するフェーズも残してある。transform が取れる PSD ではこちらが先に正しい値に補正、bounds 逆算と二重に min を取って整合する設計。

### D. ガイドロック時の外側ディムマスク

D1. **`renderLockedDimMask(geom, g, ...)` 新設** ([src/rulers.js](src/rulers.js)): ガイドロック中、縦横 2 本以上のガイドが揃ったら **min/max で囲まれた矩形の外側 4 領域**を薄暗くオーバーレイする。トリミング枠の最終確認用途。

D2. **実装方式の試行錯誤**:
- 当初: 4 分割 div（上 / 下 / 左 / 右）で外周を塗る
- 問題発覚: subpixel rounding により左端 1px 未満の隙間が発生
- 改善: **clipper（canvas 範囲を `overflow: hidden`）+ 内側に透明 div を置き `box-shadow: 0 0 0 9999px rgba(0,0,0,0.45)` で外周を一気に spread 描画**
- 端の丸めは外側に倒す（`floor` for left/top, `ceil` for right/bottom）→ 物理的に隙間が発生しない構造

D3. **DOM 順序**: dim マスクをガイド線より先に追加し、guide line が常に dim の上に来るようにする（`appendChild` 順 = 描画順）。

D4. **再描画**: `setGuidesLocked` 内で `requestRulerRedraw()` を呼びロック切替時に dim 表示が即時反映。`onGuidesChange` 経由でガイド追加・移動・削除にもリアルタイム連動。

### E. ガイドを複数ページに反映機能

E1. **`#psd-guides-apply-btn` 新設** ([index.html](index.html) + [src/styles.css](src/styles.css)): ロックボタンの左隣（`right: 80px`）に lucide `copy` アイコン（重なった矩形）のボタンを配置。

E2. **`applyGuidesToPaths(targetPaths)` 新設** ([src/rulers.js](src/rulers.js)): 現ページのガイド配列（h/v 両方）を指定 PSD パス群にコピーして上書き反映。マージではなく完全置き換え。`emitGuidesChange` を各 path に発火、最後に 1 回 `requestRulerRedraw`。

E3. **モーダル UI** ([index.html](index.html) `#guides-apply-modal` + [src/main.js](src/main.js) `openGuidesApplyModal`):
- 全 PSD ページのチェックボックスリスト（現ページは灰色 + チェック不可）
- 「全選択」「全解除」ショートカットボタン
- Esc キャンセル / Enter 実行
- 既存モーダルと同じ `showModalAnimated` / `hideModalAnimated` でフェード+スケールアニメ

E4. **ボタンの有効条件**:
- **ルーラー ON + PSD 2 ページ以上**で表示
- **現ページにガイドあり + ガイドロック中**で disabled 解除
- ロック前は「ガイドをロックすると反映できます」、ガイド無しは「現在のページにガイドが引かれていません」とツールチップ
- `onGuidesLockedChange` を購読してロック切替に追従

E5. **`guidesMatchCurrent(psdPath)` + `arraysEqualSet(a, b)` 新設** ([src/rulers.js](src/rulers.js)): 各 PSD パスのガイドが現ページと完全一致しているか判定（h/v 両方の配列が順不同で全要素同値、誤差 1e-3 PSD px）。モーダル再表示時に **「（反映済み）」ラベル + 灰色 + チェック不可**で表示し、不要な再反映をユーザー側で意識せずに防止。対象ページのガイドを後から動かせば自動的に再選択可能に戻る（自己回復）。

### F. ガイドロック関連の改善

F1. **永続化撤廃** ([src/rulers.js](src/rulers.js)): `localStorage` キー `psdesign_guides_locked` の load / save を完全削除し、`guidesLocked` を常に `false` で初期化。「閉じた瞬間にロックを忘れたまま次セッションで動かせない」事故を防止。**ルーラー表示状態（`psdesign_rulers_visible`）は引き続き永続化**（こちらは設定的な性質）。

F2. **PSD 再読込・ホームに戻るで自動解除** ([src/services/psd-load.js](src/services/psd-load.js) + [src/hamburger-menu.js](src/hamburger-menu.js)): `loadPsdFilesByPaths` 冒頭と `goHome` の中で `setGuidesLocked(false)` を呼ぶ。新しい PSD のガイドがない / 異なる位置にあっても古いロック状態でユーザーがハマらないようにする。

F3. **ロック中はガイド線を非表示** ([src/styles.css](src/styles.css)): `.spreads-psd-area.guides-locked .psd-guide { display: none; }`。dim マスクで囲んだ枠を確認する用途を優先、視覚ノイズを最小化。ロック解除で自動的に再表示。

F4. **ドラッグ中の太さ強調を撤去** ([src/styles.css](src/styles.css)): `.psd-guide.dragging[data-axis="..."] { box-shadow: 0 0 0 2px var(--accent); }` の 2 ルールを削除。色変化（cyan → accent）のみで強調、線幅は 1px のまま。当たり判定は元の 1px 構造で十分機能する。

### G. UI 微調整

G1. **サイドツールバー区切り線が端まで届くように修正** ([src/styles.css](src/styles.css)):
- 問題: `.side-toolbar` には `padding: 0 6px 10px` があり、その中の `.panel-header` の `border-bottom` が左右 6px ぶん内側で途切れていた
- 修正: `.side-toolbar > .panel-header` に `margin-left: -6px; margin-right: -6px; width: calc(100% + 12px);` を追加して親パディングを相殺
- collapsed 時（親 padding=0）は相殺不要なので別ルールで `margin: 0; width: 100%;`
- サイドパネル側は元々 padding 無しで端まで届いていたため変更不要

### バージョン同期

`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` を **`1.7.0`** に揃え。Cargo.lock も自動追従。

> **構造変更まとめ**:
> - 旧: 自動配置はツール状態のサイズを全レイヤー一律 → 新: comic-text-detector の `font_size` から per-layer に実描画 pt 推定（calibration 0.92 + leading 込み bbox cap）
> - 旧: LONG 軸は 5% per-char buffer のみ → 新: `1.05 × chars + 0.4em` で固定安全余白を加算、display フォント overshoot に対応
> - 旧: 既存 PSD のテキストフレームは ag-psd の生 `style.fontSize` を直接使用 → 新: `getExistingLayerEffectiveSizePt` で bounds 逆算 + `min(declared, bounds-derived)` で実描画 pt を共通化、5 箇所で共有
> - 旧: ガイドロック中もガイド線は表示継続 + 永続化 → 新: ロック中は線非表示・再起動時は必ず解除、PSD 再読込・ホームでも解除
> - 旧: ガイド枠の確認はガイド線のみ → 新: 縦横 2 本以上揃って且つロック ON で外側を box-shadow 9999px spread + clipper で 1 ピクセルの隙間も無く dim
> - 旧: ガイドを別ページに移すには 1 本ずつ手で引き直す → 新: 「ガイドを複数反映」モーダルで複数ページへ一括上書き、再反映済みは自動グレーアウト
> - 旧: side-toolbar の panel-header 区切り線が左右 6px ぶん途切れる → 新: 負マージン相殺で端から端まで（サイドパネル側と統一感）

---

## v1.8.0: 自動配置ダイアログ簡素化 + 閲覧モード + ズーム移動 + Photoshop 風オーバースクロール

### 概要

このバージョンは 4 本柱:
1. **自動配置確認ダイアログを警告ベースに簡素化** — 件数一致時はダイアログ自体を出さず即配置
2. **閲覧モード新設** — F1 で PSD をウインドウいっぱいに表示する全画面ビューア（MojiQ ver_2.24 から流用）
3. **toolbar-zoom をサイドツールバーへ移動** — ヘッダーをスリム化し、ページ移動と隣接して PSD ナビ群として統合
4. **Photoshop 風オーバースクロール** — PSD/見本の両ステージで、ズームインしたキャンバスを画面端ぎりぎりまで寄せられるよう、scroll content をキャンバス寸法 + viewport の 85% 倍まで拡張

加えて視覚的な区切り線や、複数のスクロール位置補正バグ修正を含む。

### A. 自動配置確認ダイアログの簡素化

A1. **PSD 数 ≠ 画像スキャンページ数 のときだけ警告バナー付きでダイアログ表示** ([src/ai-place.js](src/ai-place.js) / [index.html](index.html) / [src/styles.css](src/styles.css))
- 旧: 全件ぶんの per-page table（ページ / PSD / 吹き出し / TXT / 配置 / 状態）+ サマリー行 + intro 説明文 + キャンセル/実行 ボタン → 件数一致でも毎回出る
- 新: 不一致時のみ `confirmDialog`-like モーダル（`#ai-place-review-modal`）を表示 + オレンジ系の警告バナー（`.ai-place-review-warning`、alert-triangle SVG + `border-left: 3px solid #d97706`）+ 「キャンセル / 配置を実行」のみ
- `runAutoPlace` 内で `(plan.unmappedPsdCount ?? 0) > 0 || (plan.unmappedMokuroCount ?? 0) > 0` を判定し、不一致なら `showPlanReviewModal` を呼び、一致なら直接 `applyPlan` へ進む
- 警告バナー内テキスト: `PSD: N 枚 / 画像スキャン: M ページ` + 末尾の余り PSD は配置されない・余り OCR ページは使用されない旨
- 旧 `STATUS_ICON_SVG` / `STATUS_LABEL` / `escapeHtml` ヘルパーと `.ai-place-review-tablewrap` / `.ai-place-review-table` / `.ai-place-col-*` / `.ai-place-status-*` / `.ai-place-review-summary` / `.ai-place-review-intro*` の CSS は撤去（dead code 整理）

A2. **「ページぶん」→「ページ分」** — 警告バナー詳細文の表記を漢字に統一

### B. 閲覧モード（viewer-mode）

B1. **新規モジュール [src/viewer-mode.js](src/viewer-mode.js)** — MojiQ ver_2.24 `js/viewer-mode.js` のロジックを ES module + PsDesign の state API（`getPsdZoom` / `setPsdZoom` / `getPages` / `setActivePane` / `onPageIndexChange`）に移植
- 状態: `isActive` / `previousZoom`
- API: `bindViewerMode()` / `toggleViewerMode()` / `isViewerActive()`

B2. **UI 構造**:
- ヘッダー保存ボタンの右に `#viewer-mode-btn`（lucide ベースのモニター + スタンドアイコン、PSD 未読込時は disabled）。`psdesign:psd-loaded` / `onPageIndexChange` で再評価
- `<div class="viewer-nav-hint">Esc または × で閲覧モードを終了</div>` を `bindViewerMode` で動的に body へ追加（中央上部、3 秒で fade out）
- `<button class="viewer-close-btn">` を右上に動的追加（44px 丸ボタン、マウスが右上 150px 圏内に入ると 3 秒間表示、hover で赤系背景）

B3. **CSS** ([src/styles.css](src/styles.css))
- `body.viewer-mode` クラスでヘッダー（`.toolbar`）/ サイドツールバー（`.side-toolbar`）/ サイドパネル（`.side-panel`）/ PDF・校正・エディタペイン（`.spreads-pdf-area` / `.spreads-proofread-area` / `.spreads-editor-area`）を `opacity: 0; visibility: hidden; width/height: 0; padding: 0; border: none; pointer-events: none` で fade out（0.3s ease）
- `.spreads-psd-area` を `display: flex !important; flex: 1 1 100%; width/height: 100%; padding/border: 0` で全画面化（editor-mode の `display: none` を上書き）
- PSD ペイン上のオーバーレイ（`#psd-rotate-btn` / `#psd-guides-lock-btn` / `#psd-guides-apply-btn` / `#psd-rulers` / `#psd-guides-layer`）も非表示
- `.viewer-nav-hint`（`position: fixed; top: 50px; transform: translateX(-50%); z-index: 10000`、`opacity: 0` 既定 + `.show` で 1）と `.viewer-close-btn`（`position: fixed; top: 20px; right: 20px; z-index: 10001; opacity/visibility: 0/hidden` 既定 + `.show` で表示）

B4. **入退出ロジック**
- `enter()`: PSD pages > 0 を確認 → `setActivePane("psd")` → `previousZoom = getPsdZoom()` を保存 → `body.classList.add("viewer-mode")` → `setPsdZoom(1)` で fit-to-window → ナビゲーションヒント / 閉じるボタン表示 → `keydown` (Esc) と `mousemove`（右上ホットゾーン）listener を `capture: true` で登録
- `exit()`: ハイライト解除 → 全タイマークリア → listener 解除 → `setPsdZoom(previousZoom)` で復帰

B5. **ページ送り**: 既存の `bindWheelPageNav`（`.spreads-psd-area` の wheel 既設）と `findShortcutMatch` の `pagePrev` / `pageNext` / `pageFirst` / `pageLast`（global keydown）にそのまま乗るので、wheel スクロール / ←→ / Ctrl+←→ いずれもそのまま動く。viewer-mode 専用ロジックは追加なし。

B6. **F1 ショートカット** ([src/settings.js](src/settings.js) `DEFAULT_SETTINGS.shortcuts.viewerMode = { key: "F1", modifiers: [], description: "閲覧モード" }`) — F1 はブラウザ既定で「ヘルプ」を開くので、`bindViewerMode` 末尾に capture フェーズの keydown listener を登録して `matchShortcut(e, "viewerMode")` 判定 → `preventDefault + stopPropagation + toggle()`。これは既存の `bindRulerToggle`（Ctrl+R = リロード抑止）/ `bindFramesToggle`（Ctrl+H = 履歴抑止）と同じパターン。`runShortcut` の switch にも `case "viewerMode": toggleViewerMode()` を追加し、環境設定での再アサインにも対応。

### C. toolbar-zoom をサイドツールバーへ移動

C1. **ヘッダーから撤去 → サイドツールバー下部の page-nav 上に再配置** ([index.html](index.html))
- 旧: ヘッダー `.toolbar-actions` 内の `.toolbar-zoom`（zoom-in / 100% / zoom-out 横並び）
- 新: `<div class="side-page-zoom" role="group">` を `#tool-pan` の直下、`.page-nav` の直前に縦並び（zoom-in → 100% → zoom-out）
- ID（`#zoom-in-btn` / `#zoom-level-btn` / `#zoom-out-btn`）は据え置き → [src/main.js](src/main.js) の `bindZoomTool` は無改変で動作

C2. **CSS** ([src/styles.css](src/styles.css))
- 旧 `.toolbar-zoom` / `.zoom-btn` / `.zoom-level-btn` ルールを削除
- 新 `.side-page-zoom`（縦 flex column、`margin-top: auto` で旧 `.page-nav` のボトムアンカー役を引き継ぐ、`border-top` + `border-bottom` で上下に区切り線）+ `.page-zoom-btn`（30×26）+ `.page-zoom-level-btn`（32×auto / `min-height: 30px` / `font-size: 10px` / `line-height: 1.5`、44px ツールバー幅で `PSD 100%` を 2 行ラップしたとき行間を確保）
- `.page-nav` から `margin-top: auto` と `border-top` を撤去（ズーム群が新しいアンカー、ページ移動はその直下にぶら下がる）

C3. **`zoom-level-btn` の 2 行表示**: 既存の `bindZoomTool` の `level.textContent = ${paneLabel(pane)} ${zoom}%`（例: `"PSD 100%"`）が 32px 幅のボタン内で自動ラップして「PSD」「100%」の 2 行になる。`line-height: 1.5` で 5px の行間を確保。

### D. toolbar-history に区切り線を復活

D1. **`.toolbar-history` に `border-left: 1px solid var(--border)` を追加** ([src/styles.css:233](src/styles.css#L233))
- 旧: 左隣 `.toolbar-zoom` の `border-right` を区切り線として流用していた
- 新: ズーム群がサイドへ移動したので自前の `border-left` を持つ
- `margin-left: -12px` → `margin-left: -6px` に変更し、view-mode-segment の右端と区切り線の間に 6px breathing room を確保（履歴グループ内側の padding 6px と同じ間隔）

### E. Photoshop 風オーバースクロール（PSD/見本 共通）

E1. **新規モジュール [src/overscroll.js](src/overscroll.js)** — PSD と PDF/見本で共有する 4 つのヘルパー
- `OVERSCROLL_FRACTION = 0.85`（viewport 寸法に対する余白比率）
- `captureViewportCenterFraction(stage, pageEl)` — `.page` 要素の `getBoundingClientRect` から viewport 中心点をキャンバス相対の (fracX, fracY) に変換して返す（zoom 前にキャプチャ）
- `applyOverscrollMargin(stage, pageEl, visualW, visualH, availW, availH)` — visualW/H が availW/H を超えるときだけ `pageEl.style.margin = ${padY}px ${padX}px` を設定（padX = availW × 0.85）。戻り値は「直前は margin 無し → 今回付いた」の遷移を示す bool
- `restoreViewportCenter(stage, pageEl, frac)` — 新レイアウト後に `getBoundingClientRect` 経由で fracX/Y のキャンバス点を viewport 中央に持ってくるよう scrollLeft/Top を再計算
- `centerCanvasInViewport(stage, pageEl)` — frac 不要でキャンバス中央を viewport 中央に合わせる（初回読込・ページ切替・空表示復帰用）

E2. **PSD 側** ([src/spread-view.js](src/spread-view.js))
- モジュール変数 `zoomTransitionCenter` を追加。`onPsdZoomChange` ハンドラを差し替え、`pageRedraws` 実行前に `captureViewportCenterFraction` で `zoomTransitionCenter` をセット → finally で null
- `buildPage` クロージャに `isFirstRedraw` フラグ追加（`renderAllSpreads` がページごとに `buildPage` を呼び直すと新クロージャで true に）
- redraw 末尾で `applyOverscrollMargin(root, el, visualW, visualH, availW, availH)` → `marginNewlyApplied` を取得 → 以下の 3 分岐:
  - `zoomTransitionCenter` あり + overflow 維持: `restoreViewportCenter` で中心保持
  - `zoomTransitionCenter` あり + overflow 解消（Ctrl+0 で 100% に戻すケース等）: `scrollLeft/Top = 0` で flex の `safe center` に委ねる
  - `zoomTransitionCenter` なし + (`isFirstRedraw` または `marginNewlyApplied`): `centerCanvasInViewport` でキャンバスをセンタリング（ページ切替直後の見切れ防止）

E3. **PDF/見本側** ([src/pdf-view.js](src/pdf-view.js))
- モジュール変数 `pdfZoomDirty` を追加。`onPdfZoomChange` ハンドラを差し替え、フラグを立ててから `schedule()`（rAF debounce）。redraw 内でフラグ消費と同時に `captureViewportCenterFraction` をキャプチャ
- 以前は両分岐（full / 半ページ）でそれぞれ `canvas.style.width/height` を設定していたが、`showCanvas` 直後に 1 度だけ設定するようリフトしてレイアウトを早期確定
- redraw 末尾で `applyOverscrollMargin(stageEl, pageWrap, cssW, cssH, availW, availH)` + 同じ 3 分岐ロジック
- `wasHidden = pageWrap.hidden` を `showCanvas` 直前にキャプチャ。空表示や OOB 復帰のときは `isFirstRedraw` 相当として `centerCanvasInViewport` を発動

E4. **applyOverscrollMargin の overflow 判定にスクロールバー非依存の `availW/availH` を使う** — `box.width - 32`（rootEl コンテンツ寸法）として算出した値を渡す。stage.clientWidth/Height はズーム中のスクロールバーぶん（縦/横 16px）削られているため、Ctrl+0 直後のスクロールバー残存タイミングで `cssW > stage.clientWidth` が誤判定で true になり、本来 0 にすべき padX が `round(744 × 0.85) = 632` で計算されて margin が付与され、キャンバス左端が viewport 右側に押し出される事故が起きる。これを修正するため `applyOverscrollMargin` シグネチャに `availW`, `availH` の任意引数を追加し、両呼び出し側から `availW`/`availH` を渡す（省略時は従来どおり stage.clientWidth/Height にフォールバック）。

E5. **`hasOverflowAfter` 判定にも `availW/availH` を使う** — pdf-view.js / spread-view.js の zoom 分岐で `cssW > availW || cssH > availH` を採用。`zoom ≤ 1` では構造的に `cssW <= availW` が保証されるため、Ctrl+0 後は確実に「overflow なし」分岐に入って `scrollLeft/Top = 0` がセットされ、flex の `safe center` でキャンバスがビューポート中央に表示される。

> **このセッションの構造変更まとめ**:
> - 旧: 自動配置は毎回 per-page 表 + サマリー + 説明文付きの確認モーダル → 新: 不一致時のみ警告バナー入りモーダル、一致時は即配置
> - 旧: PSD は通常表示のみ → 新: F1 で全画面の閲覧モード（ヘッダー・サイドバー・他ペインを fade out して PSD のみフィット表示、Esc で復帰）
> - 旧: ズーム群はヘッダーに横並び → 新: サイドツールバー下部の page-nav 上に縦並び、上下に区切り線、PSD/PDF ラベルが 2 行表示
> - 旧: ズームインすると canvas が viewport にぴったり収まり、画面端まで移動範囲が狭い → 新: viewport の 85% ぶんの透明 margin を `.page` に付与してスクロール領域を拡張、Photoshop と同じ「キャンバス端を画面中央付近まで寄せられる」操作感
> - 旧: ズーム時は browser 既存スクロールに任せる（中心がずれる） → 新: zoom 前に viewport 中心のキャンバス相対点を frac でキャプチャ → zoom 後に新サイズで scroll を再計算、ズーム前後の中心一致
> - 旧: 初回読込・ページ切替直後にスクロールが (0,0) で margin により canvas が画面外に押し出される → 新: 初回 redraw / 空表示復帰のタイミングで `centerCanvasInViewport` で明示的にセンタリング

### バージョン同期

`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` を **`1.8.0`** に揃え。Cargo.lock も自動追従。

---

## v1.9.0: 打ち換え入力欄の中央展開・V ツールでのダブルクリック編集・編集パネル UX 改善

### A. 既存テキストフレーム打ち換え時の入力欄改善

A1. **入力欄を frame の中央から展開** ([src/canvas-tools.js](src/canvas-tools.js)): `startInPlaceEdit` で frame の rect を `layerRectForExisting` / `layerRectForNew` で算出し、中心 `(left + width/2, top + height/2)` を `createTextFloater` に渡す。`createTextFloater` 側で新オプション `anchor: "center"` のとき `transform: translate(-50%, -50%)` を当て、入力欄が中央起点で広がるように。`startTextInput`（空キャンバスクリックの新規入力）はクリック点 = 左上の従来挙動を維持。

A2. **入力欄サイズを frame に合わせて自動フィット**: `createTextFloater` に `width` / `height` オプションを追加。PSD 座標を page 寸法比 % に変換、`box-sizing: border-box`、`min-width/min-height: 0` で CSS の `min-height: 160px` を上書きし、frame サイズにぴったり寄せる（テキスト量に応じた適正サイズ）。

A3. **textarea 内の文字も frame と同じ pt サイズに**: `fontSizePsd` オプション（PSD 座標の pt サイズ）を渡し、`canvas.clientWidth / page.width` で screen px 換算して `font-size` を直接指定。CSS 既定 16px のままだと「frame に対して文字が小さすぎ textarea が空に見える」原因になっていた。

A4. **frame の 2 倍に拡大（視認性確保）**: `startInPlaceEdit` 内で `EDIT_SCALE = 2` を定義、`width` / `height` / `fontSizePsd` を 2 倍にして渡す。中心固定なので入力欄は frame 中心から左右上下に均等に広がる。倍率調整は定数 1 箇所で完結。

### B. V ツール選択中のダブルクリックで打ち換えモードに

B1. **タイミング検出による double-click 判定** ([src/canvas-tools.js](src/canvas-tools.js)): 1 回目の mousedown で `renderOverlay` が走り `.layer-box` DOM が差し替わるため、ブラウザ既定の `dblclick` イベントは発火しない（mousedown と mouseup のターゲット食い違い）。`isLayerDoubleClick(pageIndex, layerKey)` で **`performance.now() - lastLayerClickAt < 350ms` かつ同じレイヤーキー**を判定する自前検出に切替え。

B2. **`enterInPlaceEditFromMove(ctx, target)` 新設**: レイヤーの組方向（`edit.direction ?? layer.direction` / `nl.direction`）に応じて `setTool("text-v" / "text-h")` で T/Y ツールへ切替えてから `startInPlaceEdit` を起動。原稿テキストパネルの dblclick 経路（`enterInPlaceEditForLayer`）と同じ動作で、確定後はそのツールに留まる（既存挙動と一致）。

B3. **両 mousedown ハンドラに統合**: `onExistingLayerMouseDown` / `onNewLayerMouseDown` の `tool === "move"` 分岐冒頭で `isLayerDoubleClick` を判定し、true なら `enterInPlaceEditFromMove` を呼んで return。Shift+click や drag 開始ロジックには影響しない。

### C. V ツールでの削除を原稿テキスト・エディタモードへ cascade

C1. **`cascadeRemoveTxtForLayers(deletedLayers, excludeTempIds)` 新設** ([src/txt-source.js](src/txt-source.js)): 削除されたレイヤーの `sourceTxtRef = { pageNumber, paragraphIndex }` を辿り、対応する原稿テキスト段落を `deleteBlockFromContent` で削除。`setTxtSource` 経由で `editor-textarea`（テキストエディタモード）と `txt-source-viewer`（原稿テキストパネル）の両方が listener で自動更新される。

C2. **paragraphIndex 補正**: ページごとに paragraphIndex 降順で処理（先に下を消す → 上の index は不変、補正不要）。同一ページで削除位置より後ろを参照していた残レイヤーは `updateNewLayer` で paragraphIndex を 1 デクリメントする。`deleteSelectedTxtBlock`（TXT → layer 方向の cascade）と同じ pattern を逆方向に適用。

C3. **同 history transient で 1 snapshot に集約** ([src/canvas-tools.js](src/canvas-tools.js)): `deleteSelectedLayers` の冒頭で削除前のレイヤースナップショット (`{tempId, sourceTxtRef}`) を取得 → `withHistoryTransient` 内で `removeNewLayer` + `cascadeRemoveTxtForLayers` を実行。Ctrl+Z 一発でレイヤー＋原稿の両方が同時に巻き戻る。

### D. 編集パネルの複数選択対応

D1. **「サイズ」「行間」タブを複数選択でも常時表示** ([index.html](index.html) + [src/text-editor.js](src/text-editor.js)): `data-editor-scope="single"` をサイズ・行間タブから撤去（フォントだけは値が曖昧になるので維持）。`populateEditor` から「複数選択 → フチタブへ自動切替」のロジックも撤去。

D2. **多レイヤー一括 commit ヘルパー** ([src/text-editor.js](src/text-editor.js)): `commitSingleFieldToSelections(field, value)` を新設し、`commitSizeToSelections(sizePt)` / `commitLeadingToSelections(leadingPct)` を export。既存の `commitFontToSelections` / `commitStrokeFields` と同じパターン（`withHistoryTransient` で 1 snapshot 化、値が変わらないレイヤーは skip）。

D3. **`applyTextSize` / `applyLeading` の経路を多選択対応に切替** ([src/main.js](src/main.js)): 旧 `if (hasSelection()) commitSelectedLayerField(...)`（最初のレイヤーだけ更新）を `commitSizeToSelections` / `commitLeadingToSelections` に置換。+/- ボタン・size-input・leading-input・[ / ] ショートカット・wheel すべてが多選択で一括反映に。

### E. テキストフレーム下のサイズバッジ刷新

E1. **フォント上 / サイズ下の縦積み** ([src/canvas-tools.js](src/canvas-tools.js) + [src/styles.css](src/styles.css)): 旧 `${フォント名} · ${N}pt` の 1 行表示を、`<div class="layer-size-badge-font">` + `<div class="layer-size-badge-size">` の 2 つの child div に分離。`.layer-size-badge` を `display: flex; flex-direction: column; align-items: center; gap: 2px` に。フォント未設定のレイヤーはサイズのみ 1 行表示（フォント div 自体を生成しない）。

E2. **環境設定で表示/非表示を切替**: `DEFAULT_SETTINGS.defaults.showBadge: true` を新設 ([src/settings.js](src/settings.js))、`migrate()` でホワイトリスト穴埋め。`createSizeBadge` 冒頭で `getDefault("showBadge") === false` をチェックして `null` を返し、呼び出し側 2 箇所で `if (badge) box.appendChild(badge)` でガード。`onSettingsChange(refreshAllOverlays)` を購読し、設定モーダルでの切替が即時反映される。

E3. **環境設定 UI**: 設定モーダル「サイドバー」タブ（旧「デフォルト」）に「選択時のフォント名・文字サイズ」行を追加。**ドロップダウン形式**（`<select>` で「表示」/「非表示」）。`syncDefaultsUi` で `sb.value = d.showBadge === false ? "hide" : "show"` を反映、change で `setDefault("showBadge", sb.value !== "hide")` を保存。

### F. 設定タブ名を「デフォルト」→「サイドバー」に変更

F1. [index.html](index.html): 環境設定モーダルの 3 つのタブ「ショートカット」「ページ送り」「デフォルト」のうち、3 つ目を **「サイドバー」** に文言変更。タブの内部 ID（`data-tab="defaults"` / `id="settings-tab-defaults"`）と setting key (`defaults.*`) は据え置き。「デフォルトに戻す」ボタンの文言もそのまま。

### G. edit-font 入力欄の typing 中保護

G1. **問題**: `populateEditor` / `rebuildLayerList` 経路で `rebuildFontOptions` が走ると `input.value = displayText` が走り、ユーザーがフォント名を入力中の文字列を上書きしてしまう不具合（多レイヤー一括 commit や onSettingsChange による refresh で再現）。

G2. **修正** ([src/text-editor.js](src/text-editor.js) `rebuildFontOptions`): `document.activeElement === input` のときは `input.value` の上書きをスキップ。`dataset.ps` だけは更新して、Enter キーで確定する `resolveFontFromInput` の参照が壊れないようにする。

### H. 閲覧モードのアニメーション軽量化

H1. **問題**: 閲覧モード切替時に `width / height / padding / border` の transition がトリガーされ、毎フレーム reflow + `spreads-psd-area` の `ResizeObserver` による canvas 再描画が発生して重かった。

H2. **修正** ([src/styles.css](src/styles.css)): layout 系プロパティの transition を撤去し、`opacity 0.18s ease` + `visibility 0s linear 0.18s` のみ残す。レイアウトは body class 付与時に瞬時にスナップ（1 回の reflow + canvas 再描画）、視覚的には opacity フェードのみ GPU 合成で軽く流れる。0.3s → 0.18s 短縮で切れ味も改善。

### I. テキストエディタモードから閲覧モードへ切替時の表示バグ修正

I1. **問題**: `.workspace.editor-mode .spreads-psd-area { display: none }`（特異度 0,3,0）が `body.viewer-mode .spreads-psd-area { display: flex }`（特異度 0,2,1）を上書きしてしまい、エディタモード中に閲覧モードへ切替えても PSD が表示されなかった。

I2. **修正** ([src/styles.css](src/styles.css)): viewer-mode 側のセレクタを `body.viewer-mode .workspace .spreads-psd-area` / `body.viewer-mode .workspace .psd-stage` に変更。特異度 (0,3,1) になり、editor-mode の (0,3,0) を確実に上書きする。

### バージョン同期

`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` を **`1.9.0`** に揃え。Cargo.lock も自動追従。 ※その後 v1.10.0 へ再同期（後述セクション参照）。

> **構造変更まとめ**:
> - 旧: 打ち換え入力欄は左上から展開、CSS 既定の min-height 160px・font-size 16px で frame に対して空白だらけ → 新: rect 中央起点、frame 寸法フィット、内部文字も実 pt × 2 倍で視認性確保
> - 旧: V ツールでテキストフレームを編集するには T/Y ツールに切替えてからクリック → 新: V ツール選択中の double-click で組方向に応じて T/Y へ自動切替 + 打ち換え起動
> - 旧: 自動配置レイヤーを V ツールで削除しても原稿テキストには残留（次の自動配置で重複） → 新: sourceTxtRef を辿って TXT 段落も削除 + paragraphIndex 補正、Ctrl+Z 一発で巻き戻る
> - 旧: 複数選択すると編集パネルが「フチ」だけになり、サイズ・行間が変更不可 → 新: 3 タブすべて常時表示、サイズ・行間も全選択レイヤーへ一括適用（commitSizeToSelections / commitLeadingToSelections）
> - 旧: フレーム下のバッジは `${font} · ${N}pt` の 1 行 → 新: フォント上 / サイズ下の 2 行縦積み、環境設定の「サイドバー」タブで表示/非表示をドロップダウン切替
> - 旧: edit-font 入力中に rebuildLayerList が走ると入力文字が消える → 新: input が active なら input.value を保護
> - 旧: 閲覧モード切替で width / height / padding 等のレイアウトプロパティが transition → 重い → 新: opacity のみ 0.18s でフェード、レイアウトは瞬時スナップ
> - 旧: editor-mode → viewer-mode の遷移で PSD が表示されない（特異度負け） → 新: `.workspace` を介在させて (0,3,1) で確実に上書き

---

## v1.10.0: プログレスバー全画面化・コンテキスト連動アイコン・V ツール フレーム入れ替え

### A. プログレスバー全画面化と上下スライド閉じアニメ

A1. **DOM 構造変更** ([index.html](index.html)): `#progress-modal` 直下に `<div class="progress-bg progress-bg-top">` / `<div class="progress-bg progress-bg-bottom">` の 2 つのぼかし背景帯を追加。card 内には `<div class="progress-icon">`（アイコン領域）と `<div class="progress-loading-text">`（進捗テキスト）を新設。旧 `<span class="progress-loading-text">`（progress-track 内の reveal 用）は廃止。

A2. **「メッセージウィンドウ」廃止 → 画面全体に展開** ([src/styles.css](src/styles.css) `#progress-modal`):
- `.progress-modal` 自体を `background: transparent` にし、dim/blur は子要素 `.progress-bg-top` / `.progress-bg-bottom` に分離
- `#progress-modal .progress-card`: `width: 100vw; max-width: none; padding: 0; background: transparent; border: none; box-shadow: none` で透明な位置決めコンテナ化
- `#progress-modal .progress-detail` / `.progress-count` を `display: none` に（旧テキスト領域を排除、進捗は loading-text 1 本に集約）
- `#progress-modal .progress-track`: `height: 22px; border-radius: 0` で画面全幅・端まで連続するバーに

A3. **上下スライド閉じアニメ** ([src/styles.css](src/styles.css) + [src/ui-feedback.js](src/ui-feedback.js) `hideProgress`):
- 開く: `.visible` 付与で `progress-bg-top.transform = translateY(-100%) → 0`、`progress-bg-bottom.transform = translateY(100%) → 0` で「上下からカーテンが中央に閉じる」入場アニメ
- 閉じる: 進捗バーの `getBoundingClientRect` から中心 Y を vh% で算出 → CSS 変数 `--bar-top` に注入 → `.closing` クラス付与で bg-top は再び `translateY(-100%)`、bg-bottom は `translateY(100%)` に。バーを境界線として上下に物理的にスライドアウト
- card は `transition: opacity 0.3s ease 0.1s` で少し遅れてフェードアウト（バーが最後まで残る印象）
- 500ms 後に `setTimeout` で hidden 化、状態リセット

A4. **二重タイマー対策** ([src/ui-feedback.js](src/ui-feedback.js) `pendingHideTimer`): モジュールレベルの timer ID を保持し、`hideProgress` 連打や「閉じ→即開く」（`loadReferenceFiles` 完了直後に `runAiOcr` が show する等）の競合で古い `setTimeout` が発火して新しい表示を hidden にしてしまう事故を防ぐ。`showProgress` 冒頭で `clearTimeout(pendingHideTimer)` + `.closing` 解除 + `--bar-top` リセット。

A5. **背景の高ブラー化** ([src/styles.css](src/styles.css) `#progress-modal .progress-bg`): 旧 `.progress-modal` の `backdrop-filter: blur(2px)` から、`#progress-modal .progress-bg { background: rgba(0, 0, 0, 0.18); backdrop-filter: blur(14px); }` に強化。dim を薄く（0.55 → 0.18）、blur を厚く（2px → 14px）して背景写真のディテールを残しつつ前面に集中させる。

### B. アイコン付き進捗 + コンテキスト連動

B1. **`progress-icon` 領域とデフォルト spinner** ([src/ui-feedback.js](src/ui-feedback.js) `DEFAULT_SPINNER_HTML` / `setProgressIcon`):
- `showProgress({icon})` で SVG 文字列を直接渡す API を新設。`undefined` で 12 ドット円形 spinner、`null` で空（非表示）、文字列でカスタムアイコン
- 12 ドット spinner は CSS の `.spinner-dot:nth-child(N)` で `transform: rotate(N×30deg) translateY(-22px)` に配置、`animation-delay: -N×0.1s` で順次フェードする古典 spinner

B2. **画像スキャンアイコン (scan-line)** ([src/ai-ocr.js](src/ai-ocr.js) `SCAN_ICON_SVG` + [src/styles.css](src/styles.css) `.scan-icon`):
- lucide `scan-line` の 4 角コーナー + 中央水平線
- アニメ `scan-fade-back`: `scale(1) → 0.4` + `opacity 1 → 0` で「手前→奥」にフェードアウト、61% で瞬時に元位置 + 不可視に戻して 100% で再出現。1.8s ループで「奥に吸い込まれては戻る」反復演出

B3. **自動配置アイコン (wand-sparkles)** ([src/ai-ocr.js](src/ai-ocr.js) `PLACE_ICON_SVG` + [src/styles.css](src/styles.css) `.place-icon .sparkle`):
- ステッキ軸 + ヘッド (`<path>` 2 本) は静止
- 周りの sparkle 6 本に `.sparkle` class を当て、`nth-of-type(N)` で `animation-delay: 0s, 0.12s, 0.24s, 0.36s, 0.48s, 0.60s` を順次振り、`sparkle-blink`（opacity 0.25 ↔ 1）でキラキラ点滅。1.6s ループ

B4. **「自動配置中」コンテキストの保持** ([src/ai-ocr.js](src/ai-ocr.js) `runAiOcr` + `runAiOcrForFiles`):
- `runAiOcr(files, {icon, label})` 引数化。デフォルトは `SCAN_ICON_SVG` + `"画像スキャン中…"`
- `runAiOcrForFiles`（自動配置から呼ばれる）は `{icon: PLACE_ICON_SVG, label: "自動配置中…"}` を渡し、ユーザーが感じる操作文脈（「自動配置を実行している」）を維持

B5. **PSD 読込にも icon/label** ([src/services/psd-load.js](src/services/psd-load.js) `loadPsdFilesByPaths`):
- `options.icon` / `options.label` を新設。通常の「PSD を開く」フローは未指定 → デフォルト spinner + 「PSD を読み込み中」
- [src/ai-place.js](src/ai-place.js) `runAutoPlace` で PSD 未読込時の自動 PSD 読込パスは `{icon: PLACE_ICON_SVG, label: "自動配置中…"}` を渡す。OCR → PSD 読込 → 配置確認 まで一貫して wand-sparkles アイコンと「自動配置中…」表示で、ユーザーが何を実行しているか見失わない

### C. V ツールでフレーム入れ替え (swap)

C1. **設計**: V ツール選択中、単一テキストフレームをドラッグして別フレームの上にドロップすると、両者の位置を入れ替える。Shift+click や Alt+drag（複製）と排他の単一選択ドラッグ時のみ有効。サイズ違いでも各フレームの中心同士をスワップして「元々あった位置の中央に新しいフレームが収まる」自然な挙動。

C2. **状態管理** ([src/canvas-tools.js](src/canvas-tools.js) `beginMultiLayerDrag`):
- `isSingleMoveDrag = !isDuplicate && items.length === 1` で swap 可能性を判定
- `aStartRect`: ドラッグ開始時点の被ドラッグレイヤーの絶対 PSD rect（既存 = `layerRectForExisting`、新規 = `layerRectForNew`）
- `lastSwapTarget`: hover 中の swap 候補。mousemove 内で変化があれば DOM ハイライトを更新

C3. **`findSwapTarget(ctx, draggedKey, centerX, centerY)`**: ドラッグ中レイヤーの中心点を中心とする 1px 矩形で `rectsIntersect` 判定し、被ドラッグ自身を除く全テキストレイヤー（既存→新規の順）から最初のヒットを返す。

C4. **hover 中の視覚フィードバック** ([src/styles.css](src/styles.css) `.layer-box.swap-target` / `.layer-box-new.swap-target`):
- 既存レイヤー上 hover: アクセント色 (`var(--accent)`) のリング 3px + 白半透明グロウ 5px、背景 `rgba(0, 120, 212, 0.28)`
- 新規レイヤー上 hover: オレンジ (`#e89a3c`) のリング、背景 `rgba(255, 200, 120, 0.28)`
- カーソルは `cursor: alias`、解除時に元に戻す
- `frames-hidden` モード（Ctrl+H）でも swap-target 強調は `!important` で残す（操作意図を最優先）

C5. **`performSwap(ctx, dragged, aStartRect, target)`**: 中心点同士で位置を交換。
- `bRect = layerRectForExisting/New(target)` で B の現在 rect 取得
- A 新位置 = B の中心 - A 半サイズ（A 自身の幅/高さは不変、中心が B の現在中心へ）
- B 新位置 = A の元中心 - B 半サイズ
- `withHistoryTransient` で `addEditOffset`（既存）/ `updateNewLayer`（新規）を 1 history snapshot に集約 → Ctrl+Z 一発で両方のフレームが元位置に戻る

C6. **mousemove + mouseup の役割分担**:
- mousemove: hover 中の swap 候補 detect + ハイライト切替（軽量）
- mouseup: 最終位置で再判定 → swap target あれば `performSwap`、無ければ通常移動
- swap 判定中は通常の `applyPreview`（位置プレビュー更新）も並行実行されるため、ドラッグ中は被ドラッグの DOM が他フレーム上に重ねって見える操作感

### D. ファイル選択ダイアログの操作性改善

D1. **問題**: カスタムファイル選択ダイアログ ([src/file-picker.js](src/file-picker.js)) で Ctrl+A や右クリック「すべて選択」を実行すると、ブラウザ既定の「ページ全体テキスト全選択」が走ってダイアログ全体が青く反転 → リスト操作が事実上ロックされる事故が発生。

D2. **`user-select: none` をカード全体に適用** ([src/styles.css](src/styles.css) `.file-picker-card`):
- `user-select: none; -webkit-user-select: none;` をカード全体に適用してドラッグ選択・右クリック選択を無効化
- ファイル名入力欄 `.file-picker-name-input` だけ `user-select: text` で例外（ファイル名編集は通常通り選択可能）

D3. **Ctrl+A の選択的キャンセル** ([src/file-picker.js](src/file-picker.js) `onKeyDown`):
- input/textarea 内では Ctrl+A を素通し（テキスト全選択は使えるべき）
- それ以外（リスト・ナビ等）は `preventDefault + stopPropagation` でブラウザ既定の「ページ全選択」を抑止
- 既存の Backspace（戻る）・Enter（確定）・Esc（キャンセル）と並列に追加

### バージョン同期

E1. **1.9.0 → 1.10.0** ([package.json](package.json) / [src-tauri/Cargo.toml](src-tauri/Cargo.toml) / [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) を同期更新)。Cargo.lock も自動追従。

> **構造変更まとめ**:
> - 旧: 進捗ダイアログは中央に小さなカード（440〜600px）+ 細いバー → 新: 画面全幅のぼかし dim 帯 + 端から端まで延びるバー、card は透明な位置決めコンテナ
> - 旧: hideProgress は 220ms の opacity フェード → 新: 進捗バーを中心線として上下の bg 帯が外側へスライドアウト、card は遅延フェード（合計 500ms の物理的演出）
> - 旧: 進捗ダイアログのアイコンは無し（テキストのみ） → 新: アイコン領域を新設、デフォルト 12 ドット spinner + 用途別カスタムアイコン（scan-line / wand-sparkles）
> - 旧: 自動配置経由の OCR / PSD 読込は通常の spinner + 個別ラベル → 新: wand-sparkles アイコン + 「自動配置中…」で始終一貫、ユーザーが操作文脈を見失わない
> - 旧: V ツール ドラッグはレイヤー移動のみ → 新: 単一選択ドラッグで他フレーム上にドロップ → 中心同士で位置入替（hover 中アクセント色リング、Ctrl+Z 1 回で戻る）
> - 旧: ファイル選択ダイアログで Ctrl+A → ダイアログ全体が青く反転して操作不能 → 新: カード全体 `user-select: none` + Ctrl+A をリスト上で抑止、ファイル名入力欄だけ例外

---

## v1.11.0: 連続記号の自動字詰め + view-mode スライドアニメーション + 細部 UI 調整

### A. 連続記号「— ― 〜 ～」のグループ別自動字詰め

A1. **概要**: 縦書き漫画の写植で常用される「ダッシュ系記号 / チルダ系記号が連続したら詰める」というルールを自動化。連続ランの **最後の 1 文字だけは詰めない**（後続の通常文字との字間が詰まりすぎないように）。詰め量は環境設定の「サイドバー」タブから dash 系 / tilde 系 別々に変更可能。

A2. **対象 10 文字を 2 グループに分類**:
- **dash 系**（既定 -100‰）: U+2014 EM DASH `—` / U+2015 HORIZONTAL BAR `―` / U+2013 EN DASH `–` / U+2012 FIGURE DASH `‒` / U+2010 HYPHEN `‐` / U+2011 NON-BREAKING HYPHEN `‑` / U+30FC KATAKANA-HIRAGANA PROLONGED SOUND MARK `ー`（長音記号）/ U+FF0D FULLWIDTH HYPHEN-MINUS `－`
- **tilde 系**（既定 -300‰）: U+301C WAVE DASH `〜` / U+FF5E FULLWIDTH TILDE `～`

A3. **連続判定**: 2 つのグループに属する任意の文字が **2 個以上連続** したら 1 つのラン。混在連続（`―〜―` 等）も同じラン扱い。各文字に **その文字自身のグループ** の tracking 値を per-char で当てる。例:`あ―〜～い` → ― は -100‰、〜 は -300‰、最後の ～ は 0（保護）、あ・い は 0。

A4. **適用範囲**: PsDesign で新規配置したテキスト（`state.newLayers`）のみ。既存 PSD 由来のテキストレイヤーは触らない（Photoshop 側で意図的に詰めていた箇所の二重詰め事故を回避）。プレビュー / Photoshop 保存 ともに同じルールで描画。

A5. **設定永続化** ([src/settings.js](src/settings.js) `DEFAULT_SETTINGS.defaults`):
```js
dashTrackingMille: -100,   // ダッシュ系の連続詰め (‰)
tildeTrackingMille: -300,  // チルダ系の連続詰め (‰)
```
正負どちらの符号でも「絶対値ぶん詰める」セマンティクスに統一（Photoshop 慣例で負値を入れるユーザーも、正値を入れるユーザーも同じ結果）。`migrate()` でホワイトリスト穴埋め、旧 v1.10.0 の `repeatedDashTrackingMille` キーがあれば `dashTrackingMille` に自動引き継ぎ。

A6. **環境設定 UI** ([index.html](index.html) + [src/settings-ui.js](src/settings-ui.js)): 設定モーダル → 「サイドバー」タブに 2 行追加:
- 「`「―」連続のツメ (‰)`」
- 「`「～」連続のツメ (‰)`」

`min="-1000" max="1000" step="10" placeholder="0 で OFF"` の number input。`syncDefaultsUi` / `bindDefaultsInputs` の既存 `wireNumber` ヘルパーで配線。

A7. **プレビュー側実装** ([src/canvas-tools.js](src/canvas-tools.js)):
- `DASH_CHARS` / `TILDE_CHARS` を `Set` で定義、`repeatedTargetGroup(ch)` で per-char グループ判定
- `findRepeatedTargetRuns(line)` で行を `[{text, isTargetRun}]` セグメント列に分解
- `appendLineWithTracking(parentEl, line, dashMag, tildeMag)`: 連続ランの最初の N-1 文字を **per-char の `<span style="letter-spacing: -X em">`** でラップ、最後の 1 文字は素のテキストノードで append。X はその文字のグループ別 magnitude (-X / 1000) em
- `renderInnerText` のシグネチャを `(inner, text, defaultLeadingPct, lineLeadings, dashMille, tildeMille)` に拡張
- 既存レイヤー描画は `renderInnerText(inner, ..., 0, 0)` で詰め無効、新規レイヤーだけ `getDefault("dashTrackingMille")` / `getDefault("tildeTrackingMille")` を渡す
- `onSettingsChange(refreshAllOverlays)` の既存購読により設定変更で即時プレビュー更新

A8. **Photoshop 書き戻し** ([src/state.js](src/state.js) `exportEdits` payload に `dashTrackingMille` + `tildeTrackingMille` 追加 → [src-tauri/src/lib.rs](src-tauri/src/lib.rs) `EditPayload` に `dash_tracking_mille: f64` + `tilde_tracking_mille: f64` フィールド追加 → [src-tauri/src/jsx_gen.rs](src-tauri/src/jsx_gen.rs)):
- `applyRepeatedDashTracking(layer, contents, dashMille, tildeMille)` を新設（HEADER に追加）
- `charGroup(s)` ヘルパーで per-char に dash / tilde / null を判定（regex リテラルは ExtendScript のファイルエンコーディング Shift_JIS 影響を受けるため、`charCodeAt(0)` 直接判定で安全に）
- 連続ラン検出 → 最初の N-1 文字の `trackingPerChar[k]` にグループ別の負値を格納（最後の 1 文字は 0）
- 既存 `textStyleRange` を読み、各 char index がどの old range に属するかを `srcRangeIndex[]` で記録 → `(srcRangeIndex, trackingValue)` が連続している区間に圧縮 → 各区間で `cloneActionDescriptor(srcStyle)` + `putInteger(sID("tracking"), v)` で新 textStyleRange を構築
- **重要なバグ修正**: `executeAction(sID("set"), ...)` で `setDesc.putObject(sID("to"), sID("textKey"), newTextKey)` だと Photoshop が渡された textStyleRange を破棄して既存値を保持するケースがある → **class を `sID("textLayer")`（charID `TxtL`）に変更** することで tracking が確実に反映される。applyLineLeadings は `textKey` で動いているが、tracking のような per-character の新規スタイル変更は `textLayer` class でないと有効化されないことが Action Manager 経路の verify 診断で判明
- `applyToPsd` シグネチャを 6 引数化 (`psdPath, edits, newLayers, savePath, dashTrackingMille, tildeTrackingMille`)、newLayers ループで `nl.lineLeadings` 適用後に `applyRepeatedDashTracking` を呼ぶ
- `generate_apply_script` で payload の値を JSX の各 `applyToPsd` 呼び出しに埋め込み

> **注**: `applyLineLeadings` と併用する場合、`applyRepeatedDashTracking` が後から実行されて textStyleRange を再構築するため、各 source range の style を clone して tracking を上乗せする方針で line leading 情報も保持。複数選択編集や per-line leading との衝突は最小限。

### B. view-mode 切替の左スライドアニメーション

B1. **概要**: view-mode-segment（parallel / proofread / editor）切替を「ハンバーガーメニュー風」の左スライドに変更。これまで `hidden` 属性 + `display:none !important` で瞬間スナップしていた挙動を、`transform: translateX` + `opacity` の transition に置き換え。

B2. **DOM 再構成** ([index.html](index.html)):
- `#proofread-panel` の初期 DOM 位置を `.spreads-pdf-area` 内 → `.spreads-proofread-area` 内 に移動
- `.spreads-proofread-area` と `.spreads-editor-area` の初期 `hidden` 属性を撤去（CSS の class 制御に一本化）

B3. **ドロワー化 CSS** ([src/styles.css](src/styles.css)):
- `.spreads-stage { position: relative }` で absolute 配置の anchor を提供
- `.spreads-proofread-area`: `position: absolute; left:0; width:50%; height:100%; z-index:11`、隠し時 `transform: translateX(-100%); opacity: 0; pointer-events: none`
- `.spreads-editor-area`: `position: absolute; left:50%; width:50%; height:100%; z-index:10`、隠し時 `transform: translateX(-200%); opacity: 0; pointer-events: none`（stage 全体ぶん左 = 完全に画面外）
- `.spreads-stage.proofread-visible` / `.editor-visible` クラスで `transform: translateX(0); opacity: 1; pointer-events: auto` に
- `.proofread-panel` を `.proofread-overlay` / `.proofread-pane` の class 切替なしのシンプルな pane スタイルに統合（`position: relative; flex: 1; min-width:0; min-height:0`）
- `.workspace.editor-mode` の `display: none !important` 対象から PDF/PSD area を外し、**サイドバー類のみ** 残す（PDF/PSD は背景に残してドロワーで覆う）
- viewer-mode 用の共有 transition rule に `transform 0.28s cubic-bezier(0.4, 0, 0.2, 1)` を追加（既存 opacity / visibility と並列）。これがないと既存ルール（specificity (0,2,1)）が新規 transform を上書きしてアニメが効かない

B4. **JS 制御の簡素化** ([src/main.js](src/main.js) `bindParallelViewMode`):
- `pdfArea / psdArea / editorArea / proofreadArea.toggleAttribute("hidden", ...)` を全撤去
- 代わりに `stage.classList.toggle("proofread-visible", showProofread || showEditor)` と `stage.classList.toggle("editor-visible", showEditor)` を設定
- `proofread-panel` の `appendChild` 移動と `.proofread-overlay`/`.proofread-pane` class 切替を撤去
- `closeProofread()` 呼出を撤去（スライドアウト中も内容を保持し、parent の opacity で制御。closeProofread を呼ぶと panel.hidden が即時 true → display:none で内容が瞬時に消えてからドロワーがスライドする「空のドロワーが滑る」不格好な見た目になる）。`closeProofread` の import も削除
- `.workspace.editor-mode` 付与は維持（サイドバー display:none 制御に使用）

B5. **アニメーション仕様**:
- `transform 0.28s cubic-bezier(0.4, 0, 0.2, 1)` で left → right にスライド
- `opacity 0.18s ease` で同時にフェード
- `pointer-events: none ↔ auto` で誤クリック防止
- proofread の z-index (11) > editor (10) でスライド中の重複は proofread が前面でカバー

B6. **モード遷移マトリクス**:

| from → to | 動作 |
|---|---|
| parallel → proofread | 校正パネルが PDF area 上に左からスライドイン（PSD は不動） |
| proofread → parallel | 校正パネルが左へスライドアウト → PDF area が完全露出 |
| parallel → editor | 校正 + エディタが同時に左からスライドイン、PDF/PSD を覆う |
| editor → parallel | 両方が左へスライドアウト → PDF/PSD が露出 |
| proofread → editor | エディタだけが追加スライドイン、校正は左半分に残る |
| editor → proofread | エディタだけがスライドアウト、校正はそのまま |

### C. PSD ペイン上のオーバーレイボタンを少し縮小

C1. **対象**: 4 つのオーバーレイボタンを統一規格でやや小型化 ([src/styles.css](src/styles.css) `.pdf-rotate-btn / .psd-rotate-btn / .psd-guides-lock-btn / .psd-guides-apply-btn`):
- ボタン外径: 28×28 → **24×24** px
- 内部 SVG: 16×16 → **14×14** px（`.icon-btn` グローバル 18px ルールを上書き）
- `right` オフセット再計算: rotate 8px / lock 44 → **40** px / apply 80 → **72** px（24 + 8 ギャップで等間隔維持）

C2. **影響範囲**: 見本（PDF / 画像）の回転ボタン、PSD の回転ボタン、ガイドロックボタン、ガイドを複数ページに反映ボタン。ペイン右下の縦並びがコンパクトになり、PSD コンテンツへの視覚的干渉が軽減。

> **構造変更まとめ**:
> - 旧: 連続記号のツメ機能なし → 新: dash 系（既定 -100‰）/ tilde 系（既定 -300‰）グループ別、最後の 1 文字保護、混在連続対応、Photoshop 互換。設定モーダルの「サイドバー」タブから可変
> - 旧: view-mode 切替は `hidden` 属性で瞬間スナップ → 新: ハンバーガーメニュー風の左スライド（transform 0.28s + opacity 0.18s）。`.spreads-stage.proofread-visible` / `.editor-visible` で 2 段階制御
> - 旧: editor モードで PDF/PSD area が `display: none` → 新: 背景に残し、ドロワーで覆う（スライドアウト時に PDF/PSD が露出する自然な動き）
> - 旧: PSD ペイン右下の 4 ボタンが 28×28 → 新: 24×24 で控えめなサイズ感
> - 旧: jsx_gen.rs `applyLineLeadings` 等が `setDesc.putObject(sID("to"), sID("textKey"), ...)` で動作 → 新規 tracking では `sID("textLayer")` に変更（`textKey` だと per-character の新規スタイル変更が破棄されるケース対応）

---

## v1.12.0: ステージ上部ラベルバー + プログレスバー成功演出 + 各種 UX 修正

### A. V ツール フレーム入れ替えの視覚フィードバック改善

A1. **入れ替え対象 B のリングを緑統一 + 入れ替え後 配置位置の点線プレビュー** ([src/canvas-tools.js](src/canvas-tools.js) + [src/styles.css](src/styles.css)): 旧 `.swap-target` の青/オレンジリングを **緑 (`#10b981`) に統一**。さらに `applySwapVisuals(target)` で **A の元位置中心 + B のサイズで点線 ghost (`.swap-ghost`)** を `ctx.overlay` に挿入し、「B が入れ替え後に着地する位置」を可視化。frames-hidden モードでも `!important` で残す。

A2. **点線 ghost の右回り marching ants アニメ**: `.swap-ghost` を `border: dashed` ではなく **4 本の `linear-gradient` で四辺の dash を構成** し、`@keyframes swap-ghost-march` で各辺の `background-position` を右回り（上→右、右→下、下→左、左→上）に 0.6s ループでアニメート。dash 8px / gap 8px、stroke 2px。

A3. **A 側はそのまま**: ドラッグ中フレーム A の表示は通常の選択枠（青）を維持。緑強調は B と ghost のみで、入れ替え方向（A は移動、B が着地）が直感的に伝わる。

### B. テキスト編集 layer-list のスクロール対応（複数原因の連鎖修正）

B1. **layer-list 内部 overflow** ([src/styles.css](src/styles.css) `.layer-list`): 旧 `flex: 1; overflow-y: auto; min-height: 80px` → 新 `flex: 1 1 0; overflow-y: scroll; min-height: 0`。`min-height: 0` で flex 子の既定 `min-content` size を解除し、項目数に関わらず親残余高に収まる。`auto` ではなく `scroll` で track 領域を常時確保し描画タイミングで track が消える瞬間も防ぐ。

B2. **`.editor` の `[hidden]` が効かない問題**: `.editor { display: flex }` が UA 既定の `[hidden] { display: none }` を上書きしていたため、選択 0 件時にも padding 12px + border 1px の空き高が残っていた。`.editor[hidden] { display: none }` を明示追加。

B3. **`.editor` の flex-shrink: 0**: フォント + タブ群が layer-list と残余高を取り合わないよう固定。

B4. **workspace の暗黙行が auto** ([src/styles.css](src/styles.css) `.workspace`): `grid-template-rows` 未指定で暗黙行が content 高で計算されており、レイヤー数が膨らむと side-panel ごと縦に膨張して可視範囲を超え overflow が発火しなかった。`grid-template-rows: 1fr` + `min-height: 0` で行高を確定。

B5. **side-panel の min-height: auto**: grid item の既定 `min-height: auto` が子の content min-size に引きずられて膨張するため、`min-height: 0; height: 100%` で親セルに収める。

B6. **ダーク対応の専用 scrollbar 配色**: グローバル `--scrollbar-track: #1e1e1e` がリスト li 背景 (`--bg: #1e1e1e`) と同色で消えていたため、layer-list 専用に `track: var(--panel-body)` / `thumb: var(--scrollbar-thumb)` (theme-aware) でコントラストを確保。`scrollbar-gutter: stable` も追加。

> **修正の連鎖まとめ**: layer-list が「スクロールできない」問題は単一原因ではなく、(1) `.layer-list` 自身の min-height、(2) `.editor` の hidden、(3) flex-shrink、(4) workspace 行高、(5) side-panel min-height、(6) scrollbar 配色 の 6 段階の修正でようやく解決。grid/flex の `min-height: 0` 連鎖が壊れていると overflow:scroll は機能しない（CSS 仕様）ことを再確認。

### C. ステージ上部のファイル名ラベルバー新設

C1. **`.stage-label-bar` を `.spreads-pdf-area` / `.spreads-psd-area` の上端に固定** ([index.html](index.html) + [src/styles.css](src/styles.css)):
- ペイン padding (16px) を負マージン (`margin: -16px -16px 0`) で相殺してペイン端〜端まで広げ、上端に貼り付け
- `height: 24px` でサイドパネル `.panel-header` と完全一致（border-bottom 1px + box-sizing border-box）
- `display: flex; justify-content: space-between` で左にファイル名、右に `.stage-label-actions`（ボタン群）を配置
- `z-index: 4` で psd-rulers (z-index 3) より前面

C2. **回転 / ロック / ガイド反映ボタンをバー右側へ移動** (PDF: 1 個、PSD: 3 個): 旧 `position: absolute; bottom: 8px; right: 8/40/72px` の絶対配置を撤去し、`.stage-label-actions` の flex 子として整列。サイズも 24×24 → 20×20、SVG 14 → 12 でバー高さ (24px) に収める。

C3. **JS のラベル更新先を per-pane 固定 span に変更** ([src/spread-view.js](src/spread-view.js) + [src/pdf-view.js](src/pdf-view.js)): per-page で `.page-label` を生成して `.page` に append していた旧仕様を廃止し、`#pdf-stage-label` / `#psd-stage-label` (静的 `<span>`) の `textContent` を更新する方式へ。旧 `.page-label` は `display: none` で無効化。

C4. **ファイル名 30 文字制限 + `…` 切り詰め**: 共通ヘルパー `truncateLabel(text)` を spread-view / pdf-view 各々に追加。`Array.from(text)` でサロゲートペア（CJK 拡張・絵文字）を 1 文字単位で扱い、30 文字超は先頭 29 + `…` で計 30 文字に統一。

C5. **`#●` → `P●●` 形式へ変更**: 共通 `pageNumLabel(n) = String(n).padStart(2, "0")` で 2 桁ゼロ埋め。`#1 file.psd` → `P01 file.psd`、`#10` → `P10`、3 桁以上はそのまま。PDF の左右見開き表記も `P01左` / `P01右` 形式に。

C6. **複数ファイル合成 doc の per-page ファイル名表示** ([src/pdf-loader.js](src/pdf-loader.js)): `loadReferenceFiles` で複数の見本ファイルを 1 つの合成 doc にまとめる際、各 source エントリに `path` を保持していなかったため、`getPdfPath()` (先頭ファイルパス) しか参照できずページ移動でラベルが固定されていた問題を修正。`makeCompositeDoc` に `getSourcePath(n)` API を追加し、pdf-view.js の `showCanvas` がページ毎の元ファイル名を表示。

C7. **viewer-mode で バー全体を非表示**: 旧 `body.viewer-mode #psd-rotate-btn / #psd-guides-lock-btn / #psd-guides-apply-btn` の個別ボタン非表示を `#pdf-stage-label-bar` / `#psd-stage-label-bar` のバー単位に変更（バー単位で隠せばボタンも自動的に消える）。

C8. **`:has(.stage-label-text:empty) { display: none }`**: ファイル未読込時はバーを完全非表示にして visual noise を排除。

### D. プログレスバー解除アニメーションの修正

D1. **`hideProgress` を `Promise<void>` を返す形に変更** ([src/ui-feedback.js](src/ui-feedback.js)): 旧 fire-and-forget 方式は close アニメ (500ms) 中に呼び出し側が即時続行できたため、`notifyDialog` が `#confirm-modal` (z-index: 300) を即開いて `#progress-modal` (z-index: 100) のアニメが上に重なって見えなくなる事故が発生していた。Promise 化で `await` 可能になり、close アニメ完了 → 次のモーダル open の順序を保証。

D2. **`{ success: true }` オプション追加**: 後述の緑チェックマーク演出を表示するためのフラグ。modal が hidden で closing 中でもなければ即 resolve（無駄な 500ms 待機を回避）。

D3. **ai-place 完了通知の前に `await hideProgress()`** ([src/ai-place.js](src/ai-place.js)): success notifyDialog および error notifyDialog の直前に await を挿入し、close アニメ完了を待ってから success モーダルを開く。

### E. プログレスバー背景の seam 修正

E1. **blur を `::before` の単一レイヤーに統合** ([src/styles.css](src/styles.css)): 旧仕様は `.progress-bg-top` と `.progress-bg-bottom` 双方に `backdrop-filter: blur(14px)` を当てていたため、各 blur kernel が境界 (`--bar-top`) で独立計算されて視覚的な seam（横線）が出ていた。`#progress-modal::before` を全画面 (`inset: 0`) の単一 blur レイヤーとし、`.visible` で opacity 0 → 1、`.closing` で 0.15s ディレイ後 1 → 0 で解ける。bg 帯は dim 色 (`rgba(0,0,0,0.18)`) のみのスライド演出専用に。dim はベタ塗りなので 2 帯が並んでも色境界は不可視。

### F. プログレスバー成功完了時の緑チェックマークアニメ

F1. **Tachimi 流の checkmark アニメを緑配色で移植** ([src/styles.css](src/styles.css)): `Tachimi-_Standalone` の `.apply-success-icon` パターン（リング描画 + チェック描画 + 放射バースト + 入場 scale）をベースに、配色を緑 (Tailwind green-500 系: `#22c55e` / `#4ade80` / `#bbf7d0`) で再構成。
- `.success-check-anim`: 80×80 コンテナ、開始時 scale 0.7→1 (0.25s, バウンシー)
- `.success-check-burst`: radial-gradient + scale 0.5→2.5 で外周フェードアウト (0.4s)
- `.success-check-ring`: 緑円を `stroke-dashoffset: 138 → 0` で時計回り描画 (0.3s) + ピーク時 glow フラッシュ
- `.success-check-path`: チェック鉤型を 0.2s 遅延 `stroke-dashoffset: 40 → 0` で描画 + 最大時 pale green で輝く

F2. **`hideProgress({ success: true })` でアイコン領域を成功演出に差し替え** ([src/ui-feedback.js](src/ui-feedback.js)): close アニメに入る前に `setProgressIcon(SUCCESS_CHECK_HTML)` でリング+チェック+バーストの SVG に差し替え、約 700ms 再生してから通常の close アニメへ。ローディングテキストもクリアして「完了」感を視覚的に揃える。

F3. **成功完了経路で success: true を渡す**:
- [src/ai-place.js](src/ai-place.js): 自動配置の applyPlan 成功後
- [src/ai-ocr.js](src/ai-ocr.js): OCR 成功時 (`!err && doc` のとき) のみ
- [src/services/psd-load.js](src/services/psd-load.js): PSD 読込で 1 件以上成功時 (`!allFailed`)
- [src/bind/save.js](src/bind/save.js): Photoshop 保存で警告なしの完全成功時 (`!hasWarn`)

エラー時は緑チェックを出さず即閉じる挙動なので、誤った成功フィードバックは出ない。

### G. 自動配置完了メッセージの変更

G1. **「N 件のテキストレイヤーを追加しました。」→「テキストの自動配置が完了しました。」** ([src/ai-place.js](src/ai-place.js)): 件数表示を撤去し、簡潔な完了メッセージに統一。`applyPlan(plan)` の戻り値も使わなくなったため `const added = ...` 代入を削除。

### H. ルーラー有効時のラベルバーとの重なり修正

H1. **`.psd-rulers` を bar 高さぶん下げる** ([src/styles.css](src/styles.css)): 旧 `.spreads-psd-area.rulers-on { padding-top: var(--ruler-thick) }` は bar が上端にある現仕様を考慮しておらず、ruler-top がバー (z-index 4 > rulers z-index 3) の下に隠れていた。
- `padding-top` 撤去（bar が上端のままでよい）
- `.stage-label-bar { margin-bottom: var(--ruler-thick) }` (8px → 18px) で bar 下に ruler-top 用の隙間
- `.psd-rulers { top: 24px; height: calc(100% - 24px) }` でルーラーコンテナ自体を bar 高さぶん下げる（内側の ruler-top / ruler-left / ruler-corner はコンテナ基準のまま自動的に正しい位置へ）

レイアウト結果: y=0..24 ラベルバー、y=24..42 ruler-top + ruler-corner、y=42.. ruler-left + ステージ。

### バージョン同期

`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` を **`1.12.0`** に揃え。Cargo.lock も自動追従。

> **構造変更まとめ**:
> - 旧: page-label = 各 `.page` 直下に absolute 浮かせ表示 → 新: ペイン上端の固定バー (`.stage-label-bar`) に集約。回転/ガイド系ボタンも全て同バー右側に移動
> - 旧: ラベル `#1 filename` 形式・無制限長 → 新: `P01 filename` 形式・30 文字超は `…` で切り詰め
> - 旧: 複数ファイル合成 doc は先頭ファイル名のみ表示（ページ移動で固定） → 新: source 毎に path を保持、`getSourcePath(n)` で per-page の元ファイル名表示
> - 旧: V ツール swap = B に青/オレンジリング、A は無装飾、ghost なし → 新: B が緑リング、A 元位置に右回り marching ants の緑点線 ghost
> - 旧: `hideProgress` は同期 fire-and-forget → 新: Promise を返し await 可能。`{ success: true }` でアイコン領域に緑チェックマークアニメ
> - 旧: progress-modal 背景 = 上下 bg 帯それぞれに backdrop-filter で seam 発生 → 新: blur を `::before` 単一レイヤー、bg 帯は dim 色のみ
> - 旧: 自動配置完了 = 「N 件のテキストレイヤーを追加しました」 → 新: 「テキストの自動配置が完了しました。」
> - 旧: ルーラー有効時 ruler-top がバーの下に隠れる → 新: `.psd-rulers` 自体を bar 高さぶん下げてバー直下から目盛り開始
> - 旧: layer-list は overflow:auto 設定だが grid/flex の min-height: 0 連鎖が壊れてスクロールできない → 新: `.workspace { grid-template-rows: 1fr; min-height: 0 }` + `.side-panel { min-height: 0; height: 100% }` + `.editor[hidden] { display: none }` + `.layer-list { flex: 1 1 0; min-height: 0; overflow-y: scroll }` の 4 連鎖修正で確実にスクロール

---

## v1.13.0: 初回起動セットアップ + ステージラベルバー常時表示 + 閲覧モードアニメ刷新

### A. 初回起動セットアップ画面（ウェルカム → AI インストール導線）

A1. **新規モジュール [src/first-run-setup.js](src/first-run-setup.js)** — アプリ初回起動時に AI（manga-ocr / comic-text-detector）インストールへ誘導するウェルカムモーダルを実装。
- `bindFirstRunSetup()` — モーダル DOM のイベント配線（init() で 1 度だけ呼ぶ）
- `maybeShowFirstRunSetup()` — フラグと AI 状態を判定して必要なら表示。`init()` 末尾で await せずに呼び出し（モーダルは UI に乗るだけで他処理を遅らせない）。
- localStorage キー: `psdesign_setup_seen`。一度立てたら永続的にスキップ（再表示しない）。

A2. **判定ロジック**:
1. `psdesign_setup_seen === "1"` なら即終了
2. `await checkAiModelsStatus()` が `available: true` を返したら、ウェルカムは出さずに静かにフラグを立てて終了（既に AI インストール済み環境の初回起動を煩わせない）
3. それ以外（AI 未インストール + フラグなし）→ ウェルカムモーダル表示

A3. **ウェルカムモーダル UI** ([index.html](index.html) + [src/styles.css](src/styles.css)):
- ロゴ（`/PsDesign_icon.png` 96px）+ 「PsDesign へようこそ」 + 説明文（manga-ocr / comic-text-detector 紹介 + 「ダウンロード約 3GB / 所要 10〜20 分」）
- 2 ボタン: `[あとで]` `[今すぐインストール]`（後者は accent 色 primary スタイル）
- z-index: 220（既存 `.ai-install-modal` 200 より上、`.file-picker-modal` 250 より下）
- 既存の `showModalAnimated` / `hideModalAnimated` ([src/ui-feedback.js](src/ui-feedback.js)) によるフェード+スケールアニメ

A4. **動線**:
- 「今すぐインストール」 → `markSeen()` → `hideModalAnimated(welcome)` → `await setTimeout(MODAL_ANIM_MS)` で close アニメ完了を待つ → `openAiInstallModal()`（ai-install.js から export 化）を呼ぶ → 既存 AI インストールフロー
- 「あとで」 / Esc / 背景クリック → `markSeen()` + close アニメ
- いずれの閉じ方も `localStorage.setItem(SETUP_SEEN_KEY, "1")` でフラグ立て

A5. **`openAiInstallModal` を export 化** ([src/ai-install.js](src/ai-install.js):331): 元はモジュール内部関数だったため、first-run-setup.js から import で呼べるように `export async function openAiInstallModal()` に変更。`bindAiInstallMenu` 内のクリックハンドラはそのままなのでハンバーガーメニュー経由の動線に影響なし。

A6. **触らない領域**: ハンバーガーメニューの「AIインストール」ボタン (`#ai-install-btn`) と赤バッジ (`#ai-install-menu-badge`) は完全に無変更。フラグ立て後も常時アクセス可能で、再インストール導線として温存。Rust 側 (`check_ai_models` / `install_ai_models` / `cancel_ai_install`) と PowerShell スクリプトも一切変更なし。

### B. ステージラベルバーを読込前から常時表示（ボタンは disabled）

B1. **問題**: `stage-label-bar` は中身（ファイル名）が空のとき `:has(.stage-label-text:empty) { display: none }` で完全非表示になっていた。読込前と読込後でペイン上部のレイアウトが変動し、また回転/ガイド系の操作対象がない状態がユーザーに見えなかった。

B2. **`:has` ルール撤去** ([src/styles.css](src/styles.css)): `display: none` を解除し、ラベルが空でもバーは常時表示。`viewer-mode` 時の非表示は別途 `body.viewer-mode #pdf-stage-label-bar / #psd-stage-label-bar { ... }` で従来通り制御。

B3. **4 ボタンを `disabled` で初期状態にグレーアウト** ([index.html](index.html)): `#pdf-rotate-btn` / `#psd-rotate-btn` / `#psd-guides-lock-btn` / `#psd-guides-apply-btn` の初期属性を `hidden` → `disabled` に変更。グローバル `button:disabled { opacity: 0.5; cursor: not-allowed }` ルールでグレー表示される。

B4. **JS 側の visibility ロジック更新** ([src/main.js](src/main.js)):
- `bindPdfWorkspaceToggle` / `updatePsdRotateVisibility`: `btn.hidden = ...` を `btn.disabled = ...` に変更（読込前は disabled）
- `bindPsdGuidesLock` / `updatePsdGuidesLockVisibility`: `hidden` はルーラー OFF のときのみ（機能トグル）、PSD 未読込・ガイド無しは `disabled` で表現
- `updatePsdGuidesApplyVisibility`: 同様。さらにツールチップを状態別に分岐（`PSD を読み込んでください` / `反映先のページがありません` / `現在のページにガイドが引かれていません` / `ガイドをロックすると反映できます` / 通常文言）

B5. **ホーム復帰時の同期** ([src/hamburger-menu.js](src/hamburger-menu.js)): `goHome()` 内 `clearPages()` 後に `window.dispatchEvent(new CustomEvent("psdesign:psd-loaded"))` を発火。これで [src/main.js](src/main.js) の listener が走り、`updatePageNav` / `updatePsdRotateVisibility` / `updatePsdGuidesLockVisibility` / `updatePsdGuidesApplyVisibility` が一括再評価され、ボタンが正しく disabled に戻る。`psdesign:psd-loaded` イベント名は元々 PSD 読込時のトリガーだが、「PSD state changed」を示す統合シグナルとして再利用（ホーム復帰でも同じ UI 同期処理が走るのが正解）。

### C. プログレスバー背景の不透明度強化

C1. **`#progress-modal .progress-bg` の `background`** ([src/styles.css](src/styles.css)): `rgba(0, 0, 0, 0.18)` → `rgba(0, 0, 0, 0.4)`。blur 14px は維持。dim を強めることで進捗中であることがより明確に。他のモーダル（confirm / settings / file-picker 等）には影響なし（ID スコープ限定）。

### D. 閲覧モードのアニメーション全面リライト

v1.9.0 H1/H2 で「opacity のみフェード、レイアウトは瞬時 snap」に最適化した結果、サイドパネルが「ぶちっと消える」印象になっていたのを段階的に改善。

D1. **第一段階: opacity + transform スライドの併用** ([src/styles.css](src/styles.css)): 入場時にサイドパネル等を以下の transform で軽くスライドさせながらフェード:
- `body.viewer-mode .toolbar { transform: translateY(-12px) }` — 上に消える
- `body.viewer-mode .side-toolbar { transform: translateX(-16px) }` — 左に消える
- `body.viewer-mode .side-panel { transform: translateX(16px) }` — 右に消える
- `.spreads-pdf-area / proofread-area / editor-area` は既存の drawer slide transform と競合するため transform は付けず opacity のみ

D2. **第二段階: PSD 中央移動のラグ解消**: 当初はレイアウト系プロパティ（width / height / padding / flex-basis）に `transition-delay: 0.3s` を入れて「フェード完了後にレイアウト snap」していたが、これだと PSD ペインが中央に移動するのが 0.3s 遅れて見えた。
- 修正: レイアウトプロパティも opacity と同じ `0.3s cubic-bezier(0.4, 0, 0.2, 1)` で同時アニメさせる。サイドパネルが滑らかに 0 へ縮みつつ、PSD ペインが flex で同期して中央へ寄る動きに。
- 退場時 (`body:not(.viewer-mode)`) も同パターン。レイアウトと opacity が逆再生で同期。
- `visibility` / `overflow` だけは離散プロパティなので入場時 `0s linear 0.3s` (delay snap)、退場時 `0s linear 0s` (即復元) のまま。
- canvas redraw は spread-view の rAF 合流で 60fps 追従、0.3s 限定の連続 reflow も体感ラグなし。

D3. **第三段階: PSD「奥から手前にくる」演出** ([src/styles.css](src/styles.css)): `body.viewer-mode .workspace .psd-stage` に `@keyframes psd-bring-forward` を追加:

```css
@keyframes psd-bring-forward {
  from { transform: scale(0.92); opacity: 0.55; }
  to   { transform: scale(1);    opacity: 1;    }
}
```

`animation: psd-bring-forward 0.45s cubic-bezier(0.16, 1, 0.3, 1) both;`
- 開始フレーム（scale 0.92 + opacity 0.55）が即時適用 → 0.45s で scale 1 / opacity 1 に到達
- レイアウト拡張 (0.3s) より少し長めにすることで、エリアが広がりきった後も最後の一押しでズームインが完了する印象
- ease-out 強め (`cubic-bezier(0.16, 1, 0.3, 1)`) で「奥からグイッと寄ってくる」減速感
- `transform-origin: center center` でセンター起点にスケール
- 退場時: `body.viewer-mode` クラスが外れた瞬間にアニメ rule が無効化され、`.psd-stage` は base 状態（transform なし = scale 1 / opacity 1）にスナップ。視覚的な逆再生 snap は発生しない。

### E. F1 での閲覧モード終了を撤去（Esc 専用に固定）

E1. **問題**: F1（または環境設定でカスタマイズしたショートカット）が toggle で動作していたため、閲覧モード中に F1 を押すと意図せず終了する事故があった。

E2. **修正** ([src/viewer-mode.js](src/viewer-mode.js):97): `toggle()` 関数を「起動のみ」に変更:

```js
function toggle() {
  if (!isActive) enter();
  // isActive のときは no-op（Esc / 右上 × ボタンが唯一の終了手段）
}
```

これで影響を受ける経路:
- F1 ショートカット (`bindViewerMode` 内の capture-phase keydown listener) → 閲覧モード中に押しても無反応
- ヘッダーの閲覧モードボタン → 元々閲覧モード中はトールバー自体が非表示なので変更前後で挙動同一
- 環境設定でカスタマイズした任意のキー → 同様、起動のみ
- 終了手段は **Esc / 右上 × ボタン** のみに固定

### バージョン同期

`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` を **`1.13.0`** に揃え。Cargo.lock も自動追従。

> **構造変更まとめ**:
> - 旧: 新規ユーザーが AI 機能の存在に気付かず、画像スキャン押下時に notifyDialog で停止 → 新: 初回起動時にウェルカム画面が出て manga-ocr / comic-text-detector のインストールへ誘導。`psdesign_setup_seen` フラグで一度きり、ハンバーガーメニュー再インストールは温存
> - 旧: ステージ上部のラベルバーは中身が空のとき `display: none` で完全非表示、4 つのアクションボタンも `hidden` 属性で見えなかった → 新: バー常時表示、ボタンは `disabled` でグレーアウト、ホーム復帰時も `psdesign:psd-loaded` イベントで状態同期
> - 旧: progress-modal の背景 dim は `rgba(0,0,0,0.18)` で薄め → 新: `rgba(0,0,0,0.4)` で進捗中である視覚的合図を強化
> - 旧: 閲覧モードは opacity のみフェード + レイアウト瞬時 snap で「ぶちっと消える」印象 → 新: opacity + transform スライド + レイアウトを同時 0.3s アニメで滑らかに、さらに PSD 自体は `@keyframes psd-bring-forward` で scale 0.92 → 1 に「奥から手前へ寄ってくる」ズームイン演出
> - 旧: F1 で閲覧モードを toggle（誤って終了する事故あり） → 新: F1 / ショートカットは起動のみ、終了は Esc / 右上 × 専用

