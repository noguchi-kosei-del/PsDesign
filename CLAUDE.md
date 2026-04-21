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
├── index.html                # メイン HTML（ツールバー + サイドツールバー + サイドパネル）
├── src/
│   ├── main.js               # 初期化、ツールバー/ショートカット束ね、保存・フォルダ開く
│   ├── state.js              # アプリ状態とリスナー（tool, textSize, currentPageIndex, txt…）
│   ├── psd-loader.js         # ag-psd で PSD をパースして textLayers + dpi を取り出す
│   ├── spread-view.js        # キャンバス描画（DPR 対応の高品質ダウンサンプル）
│   ├── canvas-tools.js       # オーバーレイ/選択/ドラッグ/テキスト配置
│   ├── text-editor.js        # 右パネルのレイヤーリスト & エディタ
│   ├── txt-source.js         # 原稿 TXT の読込・ブロック選択
│   ├── ui-feedback.js        # 中央プログレスモーダル + 右上トースト
│   └── styles.css
└── src-tauri/
    └── src/
        ├── lib.rs            # tauri コマンド宣言 (list_psd_files, read_binary_file, list_fonts, apply_edits_via_photoshop)
        ├── fonts.rs          # インストール済みフォント列挙
        ├── photoshop.rs      # PS 起動 + センチネルポーリングで完了検知
        └── jsx_gen.rs        # 編集内容から ExtendScript を生成（writeSentinel / blackColor / applyToPsd）
```

## 主要機能

### 1. PSD 読み込みと縦書き配置
- 「フォルダを開く」で指定フォルダ内の全 PSD を読み込み、**1 画面 1 ページ** 表示。
- 右パネルは **現在表示中ページのテキストレイヤーのみ** をリスト。
- ←/→ キー or ツールバーの ◀/▶ でページ切替。レイヤー一覧も追従。

### 2. 原稿 TXT からのワンクリック配置
- 右サイドパネル上段の「原稿 TXT」に .txt をドラッグ&ドロップ or ダイアログで読込（UTF-8 / Shift_JIS 自動判別）。
- 改行ごとにブロック化。ブロックをクリックして選択 → キャンバスをクリックで **縦書きテキストレイヤー**（黒字）として配置。
- 配置は何度でも可能。ツール状態（V/T）に依らず、ブロック選択中ならキャンバスクリックで配置。

### 3. 文字サイズツール
- ツールバーの − / ＋ / 数値入力（[ / ] キーでも調整、Shift で ±10）。
- 値は「次に配置する既定サイズ」＋「選択中レイヤーのサイズ」の両方に反映（Photoshop 文字パネル風の双方向同期）。
- キャンバスの新規/既存レイヤーのプレビューも `sizePt × dpi/72 × 画面倍率` で **実寸に近いサイズ** でレンダリング。

### 4. 保存済み PSD の再編集
- JSX で新規レイヤー作成後、`layerRef.bounds` 参照＋`translate(0,0)` で bounds を強制再評価させ、PSD の LayerRecord に正しい top/left/bottom/right を書き込む。
- `psd-loader.js` は `layer.text.orientation` から `direction` を取得。
- 既存レイヤーの overlay は bounds が過小なとき `fontSize × 文字数` でフォールバック算出し、必ずクリック可能サイズに。

### 5. Photoshop 保存と完了同期
- Rust は Photoshop を `spawn()` で非同期起動（`.status()` はハングするため不採用）。
- JSX が全処理後に `%TEMP%/psdesign_done_<ts>.flag` に `OK` / `ERROR …` を書き込み、Rust がポーリングして真の完了を検知（最大 10 分）。
- 結果は右上トーストで通知。

### 6. 表示画質
- 合成画像は PSD ネイティブ解像度の canvas をブラウザで縮小していたため HiDPI でぼやけていたのを、`canvas.width = cssW × devicePixelRatio` に変更し、`imageSmoothingQuality = "high"` で 1 回だけダウンサンプル。
- `ResizeObserver` でウィンドウサイズ変更にも追従。

### 7. UI

- **上部ツールバー**: サイズ / ページナビ / フォルダを開く / Photoshop で保存（Lucide スタイルの SVG アイコン + ツールチップ）。
- **左側ツールバー**（キャンバスとサイドパネルの間）: 選択ツール / テキストツール（縦並び、アクティブ色は青アクセント）。
- **右サイドパネル**: 原稿 TXT / テキストレイヤー一覧 / レイヤーエディタ。
- **中央プログレスモーダル**: PSD 読込・Photoshop 反映時。トーストで短い結果通知。
- ステータスバーは廃止。

## ショートカット

| キー | 動作 |
| --- | --- |
| `V` | 選択ツール |
| `T` | テキストツール |
| `[` / `]` | サイズ ±2（Shift で ±10） |
| `←` / `→` | 前/次のページ |

## データフロー

1. フォルダ選択 → Rust `list_psd_files` → Vanilla JS `loadPsdFromPath`（ag-psd）→ `state.pages` に追加
2. ユーザー編集 → `state.edits`（既存レイヤー差分）/ `state.newLayers`（新規配置）に蓄積
3. 「保存」 → `exportEdits()` が PSD 単位に束ね → Rust `apply_edits_via_photoshop` → JSX 生成 → PS 実行 → センチネル → 完了

## 設計メモ

- テキストレイヤーの編集は「差分」として state に持ち、元の `textLayers` はイミュータブルに扱う。
- 新規レイヤーは `tempId`（"new-1", "new-2", …）で識別。保存で実 Photoshop ID が振られ、次回読込時は既存レイヤーとして再編集できる。
- Tauri 2 の `dragDropEnabled: false`（window config）で OS 側の D&D を止め、ブラウザ `drop` イベントで TXT を受け取っている。
- `ag-psd` の合成 `psd.canvas` を表示に使うため、色域（ICC）や一部レイヤー効果の忠実度は Photoshop 完全一致ではない。現状は「軽量優先」方針。
