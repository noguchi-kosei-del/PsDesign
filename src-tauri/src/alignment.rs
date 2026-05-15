// 【v1.24.x】見本画像と PSD の自動位置合わせ (画像差分最小化)
//
// KENBAN の compute_diff_simple を参考に、見本 (PDF / 画像) と PSD の絵柄を比較して
// scale + offset を最適化する。これで「見本に枠がある」「ガイド線で断ち切られて
// 小さい」等のケースでも、絵柄が一致する位置・スケールに自動で揃えられる。
//
// アルゴリズム:
//   1. 両画像を grayscale + downsample (高速化のため)
//   2. テキスト bbox を mask 化 (絵柄部分だけ比較)
//   3. grid search で (scale, offsetX, offsetY) の最適値を探す
//   4. 各組合せで「絵柄差分の絶対値合計」を計算 → 最小の組合せを採用

use image::GenericImageView;
use pdfium_render::prelude::*;
use serde::Serialize;
use tauri::AppHandle;
use std::path::Path;

use crate::ocr::make_pdfium;

const DOWNSAMPLE_TARGET: u32 = 400; // 長辺 400px に縮小して高速化

#[derive(Serialize, Debug, Clone)]
pub struct Alignment {
    /// PSD 座標系 → 見本座標系のスケール (= reference_px / psd_px)
    pub scale: f64,
    /// 見本座標系での offset (px、見本上で「PSD の (0,0) がどこに来るか」)
    pub offset_x: f64,
    pub offset_y: f64,
    /// 探索結果の差分指標 (0〜1、0 が完全一致)
    pub diff_score: f64,
    /// 診断: 探索した候補数
    pub candidates: u32,
    /// 診断: 検出した PSD 絵柄 bbox (left, top, right, bottom) 元寸法 px
    pub psd_bbox: [f64; 4],
    /// 診断: 検出した見本絵柄 bbox (left, top, right, bottom) 元寸法 px
    pub ref_bbox: [f64; 4],
    /// 診断: 入力画像の元寸法
    pub psd_full_size: [f64; 2],
    pub ref_full_size: [f64; 2],
}

#[derive(serde::Deserialize, Debug)]
pub struct BboxF64 {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

/// PDF を 1 ページ目 (or 指定 index) を pdfium で 200 DPI ラスタライズして
/// DynamicImage を返す。alignment 計算用の reference として使うので、
/// OCR 用の高 DPI ではなく中庸の 200 DPI で十分。
fn render_pdf_page_for_alignment(
    app: &AppHandle,
    pdf_path: &Path,
    page_index: u16,
) -> Result<image::DynamicImage, String> {
    let pdfium = make_pdfium(app)?;
    let doc = pdfium
        .load_pdf_from_file(pdf_path, None)
        .map_err(|e| format!("PDF 読込失敗 {}: {:?}", pdf_path.display(), e))?;
    let page_count = doc.pages().len();
    if page_count == 0 {
        return Err("PDF にページがありません".to_string());
    }
    let pi = page_index.min(page_count.saturating_sub(1));
    let page = doc
        .pages()
        .get(pi)
        .map_err(|e| format!("PDF ページ取得失敗 (page={}): {:?}", pi, e))?;
    let cfg = PdfRenderConfig::new().scale_page_by_factor(200.0 / 72.0);
    let bitmap = page
        .render_with_config(&cfg)
        .map_err(|e| format!("PDF ラスタライズ失敗: {:?}", e))?;
    Ok(bitmap.as_image())
}

fn is_pdf_path(path: &str) -> bool {
    path.to_lowercase().ends_with(".pdf")
}

/// 両画像を読み込み、テキスト bbox を mask して、scale + offset を grid search で最適化。
///
/// 引数:
///   reference_path: 見本 (PDF/画像) のパス
///   reference_pdf_page_index: 見本が PDF のときに使うページ index (0-based)。画像のときは無視
///   psd_image_data_base64: PSD canvas を JS で base64 PNG 化して渡す
///   reference_text_bboxes: 見本上のテキスト bbox 一覧 (見本 px 座標)
///   psd_text_bboxes: PSD 上のテキスト bbox 一覧 (PSD px 座標)
///   psd_width / psd_height: PSD の元寸法 (px)
#[tauri::command]
pub async fn compute_alignment(
    app: AppHandle,
    reference_path: String,
    reference_pdf_page_index: Option<u16>,
    reference_image_data_base64: Option<String>,
    psd_image_data_base64: String,
    reference_text_bboxes: Vec<BboxF64>,
    psd_text_bboxes: Vec<BboxF64>,
    psd_width: f64,
    psd_height: f64,
    // 【v1.25.x】"mode1" (PSDに余分) / "mode2" (見本に余分)。未指定は mode1 扱い。
    // 数式は両モード共通だが、期待サイズ大小関係チェックでログに警告を出す。
    mode: Option<String>,
    // 【v1.25.x】mokuro OCR の img_width / img_height (= bbox 座標の単位)。
    // 未指定の場合は alignment.rs が見た見本画像サイズを使う。
    // フロントから渡せば mokuro と単位整合した offset 計算ができる。
    mokuro_img_width: Option<f64>,
    mokuro_img_height: Option<f64>,
) -> Result<Alignment, String> {
    // 1. 見本画像をロード (PDF / 通常画像 で分岐)
    let ref_img = if let Some(ref_base64) = reference_image_data_base64.as_ref().filter(|s| !s.is_empty()) {
        let ref_bytes = base64_decode(ref_base64)
            .map_err(|e| format!("見本 base64 デコード失敗: {}", e))?;
        image::load_from_memory(&ref_bytes)
            .map_err(|e| format!("見本画像デコード失敗: {:?}", e))?
    } else if is_pdf_path(&reference_path) {
        let p = Path::new(&reference_path);
        let pi = reference_pdf_page_index.unwrap_or(0);
        render_pdf_page_for_alignment(&app, p, pi)?
    } else {
        image::open(&reference_path)
            .map_err(|e| format!("見本画像読込失敗 {}: {:?}", reference_path, e))?
    };
    let (ref_w_full, ref_h_full) = ref_img.dimensions();

    // 2. PSD canvas (base64 PNG) をデコード
    let psd_bytes = base64_decode(&psd_image_data_base64)
        .map_err(|e| format!("PSD base64 デコード失敗: {}", e))?;
    let psd_img = image::load_from_memory(&psd_bytes)
        .map_err(|e| format!("PSD 画像デコード失敗: {:?}", e))?;
    let (psd_w_full, psd_h_full) = psd_img.dimensions();

    if ref_w_full == 0 || ref_h_full == 0 || psd_w_full == 0 || psd_h_full == 0 {
        return Err("画像サイズが不正です".to_string());
    }

    // 3. ダウンサンプル: 長辺 DOWNSAMPLE_TARGET に揃える
    let ref_scale = (DOWNSAMPLE_TARGET as f64) / (ref_w_full.max(ref_h_full) as f64);
    let psd_scale = (DOWNSAMPLE_TARGET as f64) / (psd_w_full.max(psd_h_full) as f64);
    let ref_w = ((ref_w_full as f64) * ref_scale).round() as u32;
    let ref_h = ((ref_h_full as f64) * ref_scale).round() as u32;
    let psd_w = ((psd_w_full as f64) * psd_scale).round() as u32;
    let psd_h = ((psd_h_full as f64) * psd_scale).round() as u32;

    let ref_small = ref_img.resize_exact(ref_w, ref_h, image::imageops::FilterType::Triangle);
    let psd_small = psd_img.resize_exact(psd_w, psd_h, image::imageops::FilterType::Triangle);

    // 4. grayscale + テキスト mask 化して u8 配列を作る
    let ref_gray = make_masked_grayscale(&ref_small, &reference_text_bboxes, ref_scale);
    let psd_gray = make_masked_grayscale(&psd_small, &psd_text_bboxes, psd_scale);

    // 5. 【v1.24.x / v1.25.x】mode 別 alignment 計算
    // 【v1.25.x 重要】ref_w_f を「mokuro OCR の img_width」と一致させる
    // (alignment.rs の見本ラスタライズ解像度と mokuro の OCR 入力解像度が違うため)。
    // これでフロント側で `alignment.offset` と `mokuroPage.img_width` の単位整合が取れる。
    let ref_w_f = mokuro_img_width.unwrap_or(ref_w_full as f64);
    let ref_h_f = mokuro_img_height.unwrap_or(ref_h_full as f64);
    let psd_w_f = psd_w_full as f64;
    let psd_h_f = psd_h_full as f64;
    let mode_str = mode.as_deref().unwrap_or("mode1");

    if mode_str == "mode2" {
        // === モード2: KENBAN 流の画像差分 grid search ===
        // 見本と PSD の絵柄を grayscale + downsample + テキスト mask した状態で、
        // scale + offset の組合せを総当たりして「差分の絶対値平均が最小」になる
        // 組合せを採用する。両者の絵柄が同じ部分を自動的に重ね合わせる方式。
        //
        // 探索範囲:
        //   scale_x_cands: 初期 scale (psd_w_full / mokuro_w_in_mokuro_units) の ±30%
        //   offset_x cands: ±max_offset_px (ダウンサンプル単位)
        //   offset_y cands: 同様
        //
        // 単位:
        //   compute_diff の scale = 「見本 sample px → PSD sample px」の倍率
        //   compute_diff の offset = 見本 sample 座標系での見本左上の位置
        //   返値はダウンサンプル前の mokuro 単位 / psd 単位に換算

        // psd small → full の倍率 (psd 単位)
        let psd_back = psd_w_f / (psd_w as f64);
        // ref small → mokuro 単位 (ref_w_f は mokuro_img_width)
        let ref_back = ref_w_f / (ref_w as f64);

        // 初期 scale: 「ダウンサンプルされた見本」と「ダウンサンプルされた PSD」の比
        // 自動配置と整合させたい: cx = mokuro_x × (psd_w / mokuro_w)
        // compute_diff 上では: ref_x = psd_x × scale + offset → psd_x = (ref_x - offset) / scale
        // 自動配置と同じになる scale = ref_w / psd_w (downsample 同単位)
        let init_scale = (ref_w as f64) / (psd_w as f64);

        // grid search パラメータ
        let scale_steps: Vec<f64> = (-30..=30).step_by(3)
            .map(|d| init_scale * (1.0 + (d as f64) / 100.0))
            .collect();
        let max_offset_x = (ref_w as i32) / 4; // 見本幅の ±25%
        let max_offset_y = (ref_h as i32) / 4;
        let offset_step = ((ref_w.min(ref_h) as i32) / 40).max(2);

        let mut best_diff = f64::INFINITY;
        let mut best_scale = init_scale;
        let mut best_ox: i32 = 0;
        let mut best_oy: i32 = 0;
        let mut tested = 0u32;

        for &s in &scale_steps {
            if !s.is_finite() || s <= 0.0 { continue; }
            let mut ox = -max_offset_x;
            while ox <= max_offset_x {
                let mut oy = -max_offset_y;
                while oy <= max_offset_y {
                    let d = compute_diff(&psd_gray, psd_w, psd_h, &ref_gray, ref_w, ref_h, s, ox, oy);
                    tested += 1;
                    if d < best_diff {
                        best_diff = d;
                        best_scale = s;
                        best_ox = ox;
                        best_oy = oy;
                    }
                    oy += offset_step;
                }
                ox += offset_step;
            }
        }

        // best を細かく refine (粗→細の 2 段階)
        let refine_range = (offset_step * 2).max(2);
        let refine_scales: Vec<f64> = (-5..=5)
            .map(|d| best_scale * (1.0 + (d as f64) / 100.0 * 2.0))
            .collect();
        let coarse_ox = best_ox;
        let coarse_oy = best_oy;
        for ds in refine_scales {
            if !ds.is_finite() || ds <= 0.0 { continue; }
            for ox in (coarse_ox - refine_range)..=(coarse_ox + refine_range) {
                for oy in (coarse_oy - refine_range)..=(coarse_oy + refine_range) {
                    let d = compute_diff(&psd_gray, psd_w, psd_h, &ref_gray, ref_w, ref_h, ds, ox, oy);
                    tested += 1;
                    if d < best_diff {
                        best_diff = d;
                        best_scale = ds;
                        best_ox = ox;
                        best_oy = oy;
                    }
                }
            }
        }

        // ダウンサンプル単位 → 元単位への変換
        // compute_diff の scale = ref_small / psd_small だが、これは元単位でも同じ比 (両者を同じ倍率で down)
        // のはずだが厳密には ref_scale と psd_scale が違うので補正
        // ref_full / psd_full = (ref_small × ref_back) / (psd_small × psd_back) = (ref_small/psd_small) × (ref_back/psd_back)
        // = best_scale × (ref_back / psd_back)
        let final_scale_inv = best_scale * (ref_back / psd_back); // mokuro 単位 / psd 単位
        // alignment.scale を「PSD 単位 → mokuro 単位」(ref/psd) 比として返す
        let final_scale = final_scale_inv;
        // offset (mokuro 単位) = ox (ref_small 単位) × ref_back
        let final_offset_x = (best_ox as f64) * ref_back;
        let final_offset_y = (best_oy as f64) * ref_back;

        let aspect_ref = ref_w_f / ref_h_f;
        let aspect_psd = psd_w_f / psd_h_f;

        eprintln!(
            "[alignment mode2/diff-search] ref={:.0}x{:.0} (mokuro単位, downsample={}x{}), psd={:.0}x{:.0} (downsample={}x{})",
            ref_w_f, ref_h_f, ref_w, ref_h, psd_w_f, psd_h_f, psd_w, psd_h,
        );
        eprintln!(
            "[alignment mode2/diff-search] init_scale={:.4} (ref_small/psd_small), candidates tested={}",
            init_scale, tested,
        );
        eprintln!(
            "[alignment mode2/diff-search] best: diff_avg={:.4}, scale_small={:.4}, offset_small=({}, {})",
            best_diff, best_scale, best_ox, best_oy,
        );
        eprintln!(
            "[alignment mode2/diff-search] => mokuro単位 alignment: scale={:.4} (ref/psd), offset=({:.1}, {:.1})",
            final_scale, final_offset_x, final_offset_y,
        );
        eprintln!(
            "[alignment mode2/diff-search] aspect_ref={:.4}, aspect_psd={:.4}",
            aspect_ref, aspect_psd,
        );

        // 診断: best から見本上で PSD が占める領域を計算
        // ref_x = psd_x × final_scale + final_offset_x → psd_x=0 → ref_x = offset_x
        // psd_x=psd_w_f → ref_x = psd_w_f × final_scale + offset_x
        let bbox_left = final_offset_x;
        let bbox_top = final_offset_y;
        let bbox_right = psd_w_f * final_scale + final_offset_x;
        let bbox_bottom = psd_h_f * final_scale + final_offset_y;

        return Ok(Alignment {
            scale: final_scale,
            offset_x: final_offset_x,
            offset_y: final_offset_y,
            diff_score: best_diff,
            candidates: tested,
            psd_bbox: [0.0, 0.0, psd_w_f, psd_h_f],
            ref_bbox: [bbox_left, bbox_top, bbox_right, bbox_bottom],
            psd_full_size: [psd_w_f, psd_h_f],
            ref_full_size: [ref_w_f, ref_h_f],
        });

        // 旧確定式 (dead code、参考用)
        #[allow(unreachable_code, unused_variables)]
        {
        let scale = 1.0;
        let offset_x = (ref_w_f - psd_w_f) / 2.0;
        let offset_y = (ref_h_f - psd_h_f) / 2.0;
        let bbox_left = ref_w_f / 2.0 - psd_w_f / 2.0;
        let bbox_top = ref_h_f / 2.0 - psd_h_f / 2.0;
        let bbox_right = ref_w_f / 2.0 + psd_w_f / 2.0;
        let bbox_bottom = ref_h_f / 2.0 + psd_h_f / 2.0;
        let actual_ref_larger = ref_w_f > psd_w_f && ref_h_f > psd_h_f;
        let aspect_diff_pct = 0.0;
        if !actual_ref_larger {
            eprintln!(
                "[alignment mode2] WARN: 見本サイズが PSD より大きくありません。",
            );
        }
        if aspect_diff_pct > 5.0 {
            eprintln!(
                "[alignment mode2] WARN: 縦横比が {:.2}% 異なります。",
                aspect_diff_pct,
            );
        }

        return Ok(Alignment {
            scale,
            offset_x,
            offset_y,
            diff_score: 0.0,
            candidates: 1,
            psd_bbox: [0.0, 0.0, psd_w_f, psd_h_f],
            ref_bbox: [bbox_left, bbox_top, bbox_right, bbox_bottom],
            psd_full_size: [psd_w_f, psd_h_f],
            ref_full_size: [ref_w_f, ref_h_f],
        });
        }
    }

    // === モード1: PSD 側に余分余白がある (見本が PSD の中央クロップ) ===
    // 確定計算: scale=1, offset=(ref-psd)/2 (両者中心一致 + 同 dpi 前提)
    //
    // 例: 見本 4299x6071, PSD 4961x7016
    //   左右余白 = (4961 - 4299) / 2 = 331 px (左に 331, 右に 331)
    //   上下余白 = (7016 - 6071) / 2 = 472.5 px
    //   offset_x = (4299 - 4961) / 2 = -331
    //   offset_y = (6071 - 7016) / 2 = -472.5
    let scale = 1.0;
    let offset_x = (ref_w_f - psd_w_f) / 2.0;
    let offset_y = (ref_h_f - psd_h_f) / 2.0;

    // 診断: 見本「が PSD のどの矩形に対応するか」を bbox として表現
    let psd_match_left = psd_w_f / 2.0 - ref_w_f / 2.0;
    let psd_match_top = psd_h_f / 2.0 - ref_h_f / 2.0;
    let psd_match_right = psd_w_f / 2.0 + ref_w_f / 2.0;
    let psd_match_bottom = psd_h_f / 2.0 + ref_h_f / 2.0;

    let aspect_ref = ref_w_f / ref_h_f;
    let aspect_psd = psd_w_f / psd_h_f;
    let aspect_diff_pct = ((aspect_ref / aspect_psd) - 1.0).abs() * 100.0;
    let expected_psd_larger = true; // mode1 前提
    let actual_psd_larger = psd_w_f > ref_w_f;
    let mode_matches = expected_psd_larger == actual_psd_larger;
    eprintln!(
        "[alignment mode1/center-margin] ref={:.0}x{:.0} (aspect={:.4}), psd={:.0}x{:.0} (aspect={:.4}), aspect_diff={:.2}%, margin=(L/R={:.1}, T/B={:.1}), scale=1.0, offset=({:.1}, {:.1})",
        ref_w_f, ref_h_f, aspect_ref,
        psd_w_f, psd_h_f, aspect_psd,
        aspect_diff_pct,
        (psd_w_f - ref_w_f) / 2.0,
        (psd_h_f - ref_h_f) / 2.0,
        offset_x, offset_y,
    );
    if !mode_matches {
        eprintln!(
            "[alignment mode1/center-margin] WARN: モード期待 (PSDが大きい) と実サイズ大小関係 (見本が大きい) が逆。\n  モード2 のボタンを試してください。",
        );
    }
    if aspect_diff_pct > 5.0 {
        eprintln!(
            "[alignment mode1/center-margin] WARN: 縦横比が {:.2}% 異なります。均等余白前提が崩れている可能性。",
            aspect_diff_pct,
        );
    }

    return Ok(Alignment {
        scale,
        offset_x,
        offset_y,
        diff_score: 0.0,
        candidates: 1,
        psd_bbox: [psd_match_left, psd_match_top, psd_match_right, psd_match_bottom],
        ref_bbox: [0.0, 0.0, ref_w_f, ref_h_f],
        psd_full_size: [psd_w_f, psd_h_f],
        ref_full_size: [ref_w_f, ref_h_f],
    });

    // 旧フォールバック (絵柄密度ベース) は dead code。万一上の式が外せない条件下で
    // フォールバックしたい場合の参考実装としてコメントアウトで残す。
    /*
    let psd_bbox_small = detect_content_bbox_density(&psd_gray, psd_w, psd_h)
        .unwrap_or((0.0, 0.0, psd_w as f64, psd_h as f64));
    let ref_bbox_small = detect_content_bbox_density(&ref_gray, ref_w, ref_h)
        .unwrap_or((0.0, 0.0, ref_w as f64, ref_h as f64));

    Ok(Alignment {
        scale,
        offset_x,
        offset_y,
        diff_score: 0.0,
        candidates: 1,
        psd_bbox: [psd_bbox_full.0, psd_bbox_full.1, psd_bbox_full.2, psd_bbox_full.3],
        ref_bbox: [ref_bbox_full.0, ref_bbox_full.1, ref_bbox_full.2, ref_bbox_full.3],
        psd_full_size: [psd_w_full as f64, psd_h_full as f64],
        ref_full_size: [ref_w_full as f64, ref_h_full as f64],
    })
    */
}

/// 【v1.25.x】投影プロファイル方式の内側絵柄領域検出。
/// 見本の上下左右から内側に向けて各行/列の白率を計算し、
/// 「白率が WHITE_RATIO_LIMIT を下回る最初の位置」を内側絵柄の境界とする。
///
/// 戻り値: (top, bottom, left, right) のピクセル座標 (ダウンサンプル画像 sample 座標系)
///   - top: 最初に「絵柄あり」と判定された行 (= 内側絵柄領域の上端)
///   - bottom: 同様に下端
///   - left, right: 左右の境界
///
/// 検出失敗 (全範囲が白 / 全範囲が絵柄) の場合、画像全体を返す。
fn detect_inner_content_by_projection(buf: &[u8], w: u32, h: u32) -> (u32, u32, u32, u32) {
    const WHITE_THRESHOLD: u8 = 230;
    // 1 行に対して「白ピクセル比率がこの値以下なら絵柄ありとみなす」
    // 0.92 = 92% 以下なら絵柄あり (= 余白行は 92% 超が白)
    // 緩めに設定して「ノイズや薄いトリミング枠」を絵柄扱いしないよう注意
    const WHITE_RATIO_LIMIT: f64 = 0.92;

    let row_white_ratio = |y: u32| -> f64 {
        let row = (y * w) as usize;
        let mut white = 0u32;
        let mut total = 0u32;
        for x in 0..w {
            let v = buf[row + x as usize];
            if v == 128 {
                continue; // テキスト mask は無視
            }
            total += 1;
            if v >= WHITE_THRESHOLD {
                white += 1;
            }
        }
        if total > 0 { white as f64 / total as f64 } else { 1.0 }
    };
    let col_white_ratio = |x: u32| -> f64 {
        let mut white = 0u32;
        let mut total = 0u32;
        for y in 0..h {
            let v = buf[(y * w + x) as usize];
            if v == 128 {
                continue;
            }
            total += 1;
            if v >= WHITE_THRESHOLD {
                white += 1;
            }
        }
        if total > 0 { white as f64 / total as f64 } else { 1.0 }
    };

    // 上から走査
    let mut top = 0u32;
    for y in 0..h {
        if row_white_ratio(y) < WHITE_RATIO_LIMIT {
            top = y;
            break;
        }
    }
    // 下から走査
    let mut bottom = h.saturating_sub(1);
    for y in (0..h).rev() {
        if row_white_ratio(y) < WHITE_RATIO_LIMIT {
            bottom = y;
            break;
        }
    }
    // 左から走査
    let mut left = 0u32;
    for x in 0..w {
        if col_white_ratio(x) < WHITE_RATIO_LIMIT {
            left = x;
            break;
        }
    }
    // 右から走査
    let mut right = w.saturating_sub(1);
    for x in (0..w).rev() {
        if col_white_ratio(x) < WHITE_RATIO_LIMIT {
            right = x;
            break;
        }
    }
    // 結果が逆転していたら (全画面白 等) フル範囲を返す
    if top >= bottom || left >= right {
        return (0, h, 0, w);
    }
    (top, bottom + 1, left, right + 1)
}

/// 【v1.24.x】テキスト bbox ベース affine fit。
/// 両 bbox 群の中心点 (centroid) と各軸の標準偏差 (spread) を取り、
///   scale = ref_spread / psd_spread       (両軸の平均)
///   offset = ref_centroid - psd_centroid * scale
/// で求める。順序や同一性は不問だが、両方が「同じセリフ群」を含む前提。
///
/// 戻り値: Some((scale, offset_x, offset_y, ref_cluster, psd_cluster))
///   ref_cluster / psd_cluster = (cx, cy, spread_x, spread_y) 診断用
fn compute_alignment_from_text_bboxes(
    ref_bboxes: &[BboxF64],
    psd_bboxes: &[BboxF64],
) -> Option<(f64, f64, f64, (f64, f64, f64, f64), (f64, f64, f64, f64))> {
    if ref_bboxes.len() < 2 || psd_bboxes.len() < 2 {
        return None;
    }
    let ref_cluster = bbox_cluster_stats(ref_bboxes);
    let psd_cluster = bbox_cluster_stats(psd_bboxes);
    // 両軸の spread から scale を推定。x / y の平均を取って異方性の影響を緩和。
    // どちらかの spread が極端に小さい (= 全 bbox がほぼ同位置) なら無効扱い。
    if ref_cluster.2 < 1.0 || ref_cluster.3 < 1.0 || psd_cluster.2 < 1.0 || psd_cluster.3 < 1.0 {
        return None;
    }
    let scale_x = ref_cluster.2 / psd_cluster.2;
    let scale_y = ref_cluster.3 / psd_cluster.3;
    // 異方性が大きい場合は両画像の対応関係が崩れている可能性があるが、
    // とりあえず平均を取る。範囲外なら無効扱い。
    let scale = (scale_x + scale_y) / 2.0;
    if !scale.is_finite() || scale <= 0.0 || scale > 100.0 {
        return None;
    }
    let offset_x = ref_cluster.0 - psd_cluster.0 * scale;
    let offset_y = ref_cluster.1 - psd_cluster.1 * scale;
    Some((scale, offset_x, offset_y, ref_cluster, psd_cluster))
}

/// bbox 群の中心点と各軸 spread (標準偏差) を返す。
/// 戻り値: (centroid_x, centroid_y, spread_x, spread_y)
fn bbox_cluster_stats(bboxes: &[BboxF64]) -> (f64, f64, f64, f64) {
    let centers: Vec<(f64, f64)> = bboxes
        .iter()
        .map(|b| ((b.left + b.right) / 2.0, (b.top + b.bottom) / 2.0))
        .collect();
    let n = centers.len() as f64;
    let cx = centers.iter().map(|p| p.0).sum::<f64>() / n;
    let cy = centers.iter().map(|p| p.1).sum::<f64>() / n;
    let var_x = centers.iter().map(|p| (p.0 - cx).powi(2)).sum::<f64>() / n;
    let var_y = centers.iter().map(|p| (p.1 - cy).powi(2)).sum::<f64>() / n;
    (cx, cy, var_x.sqrt(), var_y.sqrt())
}

/// 【v1.24.x】絵柄密度ベース bbox 検出。
/// 画像を GRID×GRID セルに分割し、各セルの黒ピクセル密度を計算。
/// 密度の中央値 × LOW_RATIO 未満のセル (= 周囲のスカスカ余分エリア) を除外し、
/// 残った高密度セルだけで bounding box を計算する。
///
/// 利点:
///   - 固定 inset (例: 15%) より柔軟。余分が少ない PSD は除外少なめ、多い PSD は多めに自動調整
///   - 「PSD の周囲に少しだけ書き込み」「PSD の半分近くが説明エリア」両方に対応
///   - 中央寄り過ぎ / 拡大しすぎ の両方を回避
fn detect_content_bbox_density(buf: &[u8], w: u32, h: u32) -> Option<(f64, f64, f64, f64)> {
    const GRID: u32 = 16;
    const DARK_THRESHOLD: u8 = 200;
    // 採用方式: セル密度の中央値 × MEDIAN_RATIO を閾値として、それ以下のセルを
    // 「周囲のスカスカ余分エリア」とみなして除外。残った高密度セルで bbox を計算する。
    //
    // 利点: 絵柄分布の偏在度に応じて自動調整される。
    //   - 中央偏在 (PSD のコマ周りに余白): 中央値が低めなので閾値が低く、中央コマに絞られる
    //   - 全体均一 (見本トリミング後): 中央値が高めなので閾値も高くなり、ほぼ全範囲に
    //
    // 旧方式 (下位 25% 除外) では、両画像とも同じ割合で削るため絵柄偏在が違う場合でも
    // 結果的にほぼ同寸法の bbox に収束し scale ≈ 1 に縮退する問題があった。
    const MEDIAN_RATIO: f64 = 0.5;

    let cell_w = w / GRID;
    let cell_h = h / GRID;
    if cell_w == 0 || cell_h == 0 {
        return None;
    }

    // 各セルの黒密度を計算 (mask=128 は無視、白は分母に含めるが分子から外す)
    let mut cells: Vec<(u32, u32, f64)> = Vec::with_capacity((GRID * GRID) as usize);
    for gy in 0..GRID {
        for gx in 0..GRID {
            let x0 = gx * cell_w;
            let y0 = gy * cell_h;
            let x1 = if gx + 1 == GRID { w } else { (gx + 1) * cell_w };
            let y1 = if gy + 1 == GRID { h } else { (gy + 1) * cell_h };
            let mut dark = 0u32;
            let mut total = 0u32;
            for y in y0..y1 {
                let row = (y * w) as usize;
                for x in x0..x1 {
                    let v = buf[row + x as usize];
                    if v == 128 { continue; }
                    total += 1;
                    if v < DARK_THRESHOLD { dark += 1; }
                }
            }
            let d = if total > 0 { (dark as f64) / (total as f64) } else { 0.0 };
            cells.push((gx, gy, d));
        }
    }

    // 密度の中央値 × MEDIAN_RATIO を閾値として、それ以下のセルを除外する。
    // 中央値 = 全セルの中央。中央値より十分薄いセルだけが切り捨てられる。
    let mut sorted_d: Vec<f64> = cells.iter().map(|&(_, _, d)| d).collect();
    sorted_d.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = sorted_d.get(sorted_d.len() / 2).copied().unwrap_or(0.0);
    let threshold = median * MEDIAN_RATIO;

    let mut min_x = w as i64;
    let mut max_x = -1i64;
    let mut min_y = h as i64;
    let mut max_y = -1i64;
    let mut adopted = 0u32;
    for &(gx, gy, d) in &cells {
        // threshold 以下のセルを除外。ただし threshold == 0 (= ほぼ全セルが密度 0)
        // の場合は、d > 0 のセルだけを採用する fallback。
        if threshold > 0.0 {
            if d <= threshold { continue; }
        } else if d <= 0.0 { continue; }
        let x0 = gx * cell_w;
        let y0 = gy * cell_h;
        let x1 = if gx + 1 == GRID { w } else { (gx + 1) * cell_w };
        let y1 = if gy + 1 == GRID { h } else { (gy + 1) * cell_h };
        if (x0 as i64) < min_x { min_x = x0 as i64; }
        if (x1 as i64) > max_x { max_x = x1 as i64; }
        if (y0 as i64) < min_y { min_y = y0 as i64; }
        if (y1 as i64) > max_y { max_y = y1 as i64; }
        adopted += 1;
    }
    // 万一何も採用されなかったら、画像全体を bbox として返す (= scale 1, offset 0)
    if adopted == 0 || max_x < min_x || max_y < min_y {
        return Some((0.0, 0.0, w as f64, h as f64));
    }
    Some((min_x as f64, min_y as f64, max_x as f64, max_y as f64))
}

/// (旧) 固定 inset で bbox 検出。新方式 (density) に置き換えたが念のため残す。
#[allow(dead_code)]
fn detect_content_bbox(buf: &[u8], w: u32, h: u32, inset_pct: f64) -> Option<(f64, f64, f64, f64)> {
    let inset_x = ((w as f64) * inset_pct).max(0.0) as u32;
    let inset_y = ((h as f64) * inset_pct).max(0.0) as u32;
    let x_start = inset_x;
    let x_end = w.saturating_sub(inset_x);
    let y_start = inset_y;
    let y_end = h.saturating_sub(inset_y);
    if x_end <= x_start || y_end <= y_start {
        return None;
    }
    // 黒い (luminance < 200) ピクセルの bounding box を取る。
    // mask 部分 (128) は無視 (テキスト領域なので絵柄判定から外す)。
    const DARK_THRESHOLD: u8 = 200;
    let mut min_x = w as i64;
    let mut max_x = -1i64;
    let mut min_y = h as i64;
    let mut max_y = -1i64;
    for y in y_start..y_end {
        let row_start = (y * w) as usize;
        for x in x_start..x_end {
            let v = buf[row_start + x as usize];
            if v == 128 { continue; } // テキスト mask 部分は無視
            if v >= DARK_THRESHOLD { continue; } // 白い (絵柄なし) 部分は無視
            if (x as i64) < min_x { min_x = x as i64; }
            if (x as i64) > max_x { max_x = x as i64; }
            if (y as i64) < min_y { min_y = y as i64; }
            if (y as i64) > max_y { max_y = y as i64; }
        }
    }
    if max_x < min_x || max_y < min_y { return None; }
    Some((min_x as f64, min_y as f64, max_x as f64, max_y as f64))
}

/// 画像を grayscale 化 + テキスト bbox を mask (= 平均輝度に置換) して u8 配列を返す。
/// テキスト位置を中性値で埋めることで、テキストの有無による差分を抑える。
fn make_masked_grayscale(
    img: &image::DynamicImage,
    text_bboxes_full: &[BboxF64],
    img_to_full_scale: f64,
) -> Vec<u8> {
    let (w, h) = img.dimensions();
    let mut buf = Vec::with_capacity((w * h) as usize);
    for y in 0..h {
        for x in 0..w {
            let p = img.get_pixel(x, y);
            // luminance = 0.299R + 0.587G + 0.114B
            let l = (0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32) as u8;
            buf.push(l);
        }
    }
    // テキスト bbox を中性灰 (128) で塗りつぶし (= 比較対象から外す)
    // text_bboxes_full は元画像 px 座標なので、img_to_full_scale で縮小座標に変換
    for bbox in text_bboxes_full {
        let x1 = (bbox.left * img_to_full_scale).max(0.0).min(w as f64) as u32;
        let y1 = (bbox.top * img_to_full_scale).max(0.0).min(h as f64) as u32;
        let x2 = (bbox.right * img_to_full_scale).max(0.0).min(w as f64) as u32;
        let y2 = (bbox.bottom * img_to_full_scale).max(0.0).min(h as f64) as u32;
        for y in y1..y2 {
            let row_start = (y * w) as usize;
            for x in x1..x2 {
                if let Some(b) = buf.get_mut(row_start + x as usize) {
                    *b = 128;
                }
            }
        }
    }
    buf
}

/// PSD ダウンサンプル画像を見本ダウンサンプル画像座標系にマップして、
/// オーバーラップ領域の絶対差分の平均を返す。0 が完全一致。
fn compute_diff(
    psd: &[u8], psd_w: u32, psd_h: u32,
    refr: &[u8], ref_w: u32, ref_h: u32,
    scale: f64, ox: i32, oy: i32,
) -> f64 {
    let mut total: u64 = 0;
    let mut count: u64 = 0;
    let psd_w_f = psd_w as f64;
    let psd_h_f = psd_h as f64;
    // 見本側ピクセルを走査 (ref_w x ref_h)、PSD 側に対応する点を逆算
    for ry in 0..ref_h {
        for rx in 0..ref_w {
            // PSD 座標 = (見本座標 - offset) / scale
            let px_f = ((rx as i32 - ox) as f64) / scale;
            let py_f = ((ry as i32 - oy) as f64) / scale;
            if px_f < 0.0 || py_f < 0.0 || px_f >= psd_w_f || py_f >= psd_h_f {
                continue;
            }
            let px = px_f as u32;
            let py = py_f as u32;
            let ref_v = refr[(ry * ref_w + rx) as usize] as i32;
            let psd_v = psd[(py * psd_w + px) as usize] as i32;
            // 【v1.24.x 改良】テキスト mask 部分は **片方でも mask** されていれば比較スキップ。
            // 旧: 両方 mask のみ skip → PSD 側にテキスト未配置だと「128 vs 背景白 (250)」の
            //     差分が大きく出て、見本のテキスト位置が正しく除外されず alignment が悪化。
            // 新: || で「テキスト位置に該当する全画素を確実に比較対象外」にする。
            if ref_v == 128 || psd_v == 128 { continue; }
            total += (ref_v - psd_v).abs() as u64;
            count += 1;
        }
    }
    if count == 0 { return f64::INFINITY; }
    (total as f64) / (count as f64) / 255.0
}

fn dedup<T: PartialEq + Copy>(v: &[T]) -> Vec<T> {
    let mut out = Vec::with_capacity(v.len());
    for &x in v {
        if !out.contains(&x) {
            out.push(x);
        }
    }
    out
}

// 簡易 base64 デコーダ (data URL のヘッダ "data:...;base64," を取り除いてからデコード)
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let body = if let Some(idx) = input.find("base64,") {
        &input[idx + 7..]
    } else {
        input
    };
    base64::engine::general_purpose::STANDARD
        .decode(body)
        .map_err(|e| format!("{}", e))
}
