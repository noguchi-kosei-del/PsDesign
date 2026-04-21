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
npm run tauri dev      # アプリ起動（Rust 再コンパイル込み）
npm run build          # フロントエンドビルド（動作確認に有用）
```

## ディレクトリ構成

```
ver_1.0/
├── index.html                # メイン HTML（カスタムタイトルバー + ツールバー + 縦ページバー + サイドパネル）
├── src/
│   ├── main.js               # 初期化、ツールバー/ショートカット束ね、ウインドウコントロール
│   ├── state.js              # アプリ状態とリスナー（tool, textSize, currentPageIndex, txt…）
│   ├── psd-loader.js         # ag-psd で PSD をパースして textLayers + dpi を取り出す
│   ├── spread-view.js        # キャンバス描画（DPR 対応の高品質ダウンサンプル）
│   ├── canvas-tools.js       # オーバーレイ/選択/ドラッグ/テキスト配置
│   ├── pagebar.js            # 縦ページバー（track + 丸型青ハンドル、>>トグルで折畳）
│   ├── text-editor.js        # 右パネルのレイヤーリスト & エディタ
│   ├── txt-source.js         # 原稿 TXT の読込・段落ブロック選択
│   ├── ui-feedback.js        # 中央プログレスモーダル + 右上トースト
│   └── styles.css
└── src-tauri/
    ├── capabilities/default.json # core:window:allow-start-dragging / minimize / toggle-maximize / close 追加
    ├── tauri.conf.json           # decorations: false でカスタムタイトルバー
    └── src/
        ├── lib.rs            # tauri コマンド宣言 (list_psd_files, read_binary_file, list_fonts, apply_edits_via_photoshop)
        ├── fonts.rs          # インストール済みフォント列挙
        ├── photoshop.rs      # PS 起動 + センチネルポーリングで完了検知
        └── jsx_gen.rs        # 編集内容から ExtendScript を生成（改行 \n → \r 正規化対応）
```

## 主要機能

### 1. PSD 読み込みと縦書き配置
- 「フォルダを開く」で指定フォルダ内の全 PSD を読み込み、**1 画面 1 ページ** 表示。
- 右パネルは **現在表示中ページのテキストレイヤーのみ** をリスト。
- キャンバス左の **縦ページバー** のハンドルをドラッグ / ←/→ キーでページ切替。

### 2. 原稿 TXT からのワンクリック配置
- 右サイドパネル上段の「原稿 TXT」に .txt をドラッグ&ドロップ or ツールバーの TXT ボタンで読込（UTF-8 / Shift_JIS 自動判別）。
- **空行で段落分割**。各段落内の改行はそのまま保持され、1 ブロック＝ 1 段落として扱う。ブロックをクリックして選択。
- **テキストツール（T）** 選択中にキャンバスをクリック → その段落が改行付きの **縦書きテキストレイヤー**（黒字）として配置される（段落内の `\n` はそのまま保持）。
- Photoshop 保存時は JSX ヘルパ `normalizeLineBreaks` が `\n` → `\r`（Photoshop の改行コード）に変換するため、Photoshop 上でも正しく複数行表示される。
- **選択ツール（V）** では配置できない（配置＝ T 専用）。

### 3. ツール別役割の明確化
- **V（選択ツール）**: 既存/新規テキストレイヤーのクリック選択＋ドラッグ移動。空白クリックで選択解除。
- **T（テキストツール）**:
  - 原稿 TXT ブロック選択中 → キャンバスクリックで段落配置。
  - ブロック未選択 → 手入力 textarea を開き、Enter で確定（従来動作）。
  - レイヤー選択／移動はできない（overlay が `pointer-events: none`）。

### 4. 文字サイズ編集（エディタ内 size-input）
- 右パネルのレイヤーエディタ内、**フォント select の下** に − / size-input / pt / ＋ の行。
- `[` / `]` キー（Shift で ±10）でも調整可能。±ボタンや数値入力も連動。
- 値は「選択中レイヤーのサイズ」＋「次に配置する既定サイズ」の双方向同期（`state.textSize` 経由）。
- キャンバスの新規/既存レイヤーのプレビューは `sizePt × dpi/72 × 画面倍率` で実寸相当、複数行時は **行数分 thick を拡大** して見切れを防ぐ。

### 5. 保存済み PSD の再編集
- JSX で新規レイヤー作成後、`layerRef.bounds` 参照＋`translate(0,0)` で bounds を強制再評価し、PSD の LayerRecord に正しい top/left/bottom/right を書き込む。
- `psd-loader.js` は `layer.text.orientation` から `direction` を取得。
- 既存レイヤーの overlay は bounds が過小なとき `fontSize × 行数 × 文字数` でフォールバック算出し、必ずクリック可能サイズに。

### 6. Photoshop 保存と完了同期
- Rust は Photoshop を `spawn()` で非同期起動（`.status()` はハングするため不採用）。
- JSX が全処理後に `%TEMP%/psdesign_done_<ts>.flag` に `OK` / `ERROR …` を書き込み、Rust がポーリングして真の完了を検知（最大 10 分）。
- 結果は右上トーストで通知。

### 7. 表示画質
- 合成画像は PSD ネイティブ解像度の canvas をブラウザで縮小していたため HiDPI でぼやけていたのを、`canvas.width = cssW × devicePixelRatio` に変更し、`imageSmoothingQuality = "high"` で 1 回だけダウンサンプル。
- `ResizeObserver` でウィンドウサイズ変更にも追従。

### 8. UI

- **カスタムタイトルバー**（OS 既定は `decorations: false` で非表示）:
  - 左: `h1`（PsDesign）と `toolbar-actions`（フォルダを開く / TXTを開く / Photoshop保存）。`data-tauri-drag-region` で空白部分をドラッグするとウインドウ移動。
  - 右: `window-controls`（最小化 / 最大化トグル / 閉じる）。close ホバーは `#e81123`。
  - Tauri capability に `core:window:allow-start-dragging` など 4 つの権限を追加済み。
- **縦ページバー**（キャンバス右／サイドツールバー左）:
  - 12px 幅のトラック（`rgba(30,30,45,0.9)` + blur）＋ 16×16 の **丸型青ハンドル**（`#00bcd4`、MojiQ Pro 準拠）。
  - ホバー/ドラッグ中にハンドル左側へ `現在ページ / 総数` のラベル表示。
  - 上部の **`>>` トグルボタン**（MojiQ の Collapse/Expand chevron）で折畳／展開、24px 幅に縮小＆トラック非表示。localStorage `psdesign_pagebar_visible` で永続化。
- **サイドツールバー**（ページバーの右、サイドパネルの左）: V（選択） / T（テキスト）を縦並びで配置、アクティブは青アクセント。
- **右サイドパネル**（上から順）:
  1. 原稿 TXT（ドロップゾーン + ファイル名 + クリアボタン）。未読込時は file-text アイコン＋メッセージ、読込前は区切り線を 1 本にするため actions 行を hidden。
  2. 編集フォーム（レイヤー選択時のみ表示）: 内容 textarea / フォント select / **サイズ size-input** / 削除ボタン。
  3. テキストレイヤー一覧。
- **空状態**（PSD 未読込）: spreads-container 中央にフォルダアイコン＋案内文。
- **中央プログレスモーダル**: PSD 読込・Photoshop 反映時。右上トーストで短い結果通知。

## ショートカット

| キー | 動作 |
| --- | --- |
| `V` | 選択ツール |
| `T` | テキストツール |
| `[` / `]` | サイズ ±2（Shift で ±10） |
| `←` / `→` | 前/次のページ（ページバーのハンドル位置も追従） |

## データフロー

1. フォルダ選択 → Rust `list_psd_files` → Vanilla JS `loadPsdFromPath`（ag-psd）→ `state.pages` に追加
2. ユーザー編集 → `state.edits`（既存レイヤー差分）/ `state.newLayers`（新規配置）に蓄積
3. 「保存」 → `exportEdits()` が PSD 単位に束ね → Rust `apply_edits_via_photoshop` → JSX 生成 → PS 実行 → センチネル → 完了

## 設計メモ

- テキストレイヤーの編集は「差分」として state に持ち、元の `textLayers` はイミュータブルに扱う。
- 新規レイヤーは `tempId`（"new-1", "new-2", …）で識別。保存で実 Photoshop ID が振られ、次回読込時は既存レイヤーとして再編集できる。
- Tauri 2 の `dragDropEnabled: false`（window config）で OS 側の D&D を止め、ブラウザ `drop` イベントで TXT を受け取っている。
- `ag-psd` の合成 `psd.canvas` を表示に使うため、色域（ICC）や一部レイヤー効果の忠実度は Photoshop 完全一致ではない。現状は「軽量優先」方針。
- 段落内の改行は UI では `\n`（CSS `white-space: pre-wrap` で描画）、Photoshop 保存時のみ JSX 側で `\r` に正規化する。
- 縦ページバーは絶対配置ではなく `.workspace` のグリッド列（`1fr auto 44px 320px`）で幅を確保。折畳時も 24px 列が残るため再展開可能。
- カスタムウインドウコントロールは `@tauri-apps/api/window` を動的 import。Tauri v2 の capability で `core:window:allow-start-dragging` 等を明示許可しないと drag region が無反応なので注意。
