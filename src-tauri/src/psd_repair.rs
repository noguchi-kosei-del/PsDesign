use std::fs;
use std::path::Path;

pub fn repair_psd_to_file(input: &Path, output: &Path) -> Result<(), String> {
    let bytes = fs::read(input).map_err(|e| format!("PSD修復用の読み込みに失敗 {}: {}", input.display(), e))?;
    let repaired = reconstruct_psd(&bytes)?;
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("PSD修復用フォルダ作成に失敗 {}: {}", parent.display(), e))?;
    }
    fs::write(output, repaired)
        .map_err(|e| format!("PSD修復ファイルの書き込みに失敗 {}: {}", output.display(), e))
}

fn reconstruct_psd(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() < 26 {
        return Err("PSDヘッダーが短すぎます".to_string());
    }
    if read_u32(bytes, 0)? != 0x3842_5053 {
        return Err("PSDシグネチャ 8BPS が見つかりません".to_string());
    }
    let version = read_u16(bytes, 4)?;
    let is_psb = match version {
        1 => false,
        2 => true,
        _ => return Err(format!("未対応のPSD/PSBバージョンです: {}", version)),
    };

    let mut out = Vec::with_capacity(bytes.len());
    out.extend_from_slice(&bytes[..26]);
    let mut offset = 26usize;

    copy_u32_len_section(bytes, &mut offset, &mut out, "Color Mode Data")?;
    copy_u32_len_section(bytes, &mut offset, &mut out, "Image Resources")?;

    let s4_hdr = if is_psb { 8usize } else { 4usize };
    ensure_range(bytes, offset, s4_hdr, "Layer and Mask length")?;
    let s4_len = read_section_len(bytes, offset, is_psb)?;
    let s4_content_start = offset + s4_hdr;
    let s4_end = checked_add(s4_content_start, s4_len, "Layer and Mask end")?;
    if s4_end > bytes.len() {
        return Err("Layer and Mask セクション長がファイル終端を超えています".to_string());
    }

    let s4_out_start = out.len();
    out.resize(out.len() + s4_hdr, 0);
    let mut cur = s4_content_start;

    if s4_len > 0 {
        let layer_info_len = read_section_len(bytes, cur, is_psb)?;
        let layer_info_total = checked_add(s4_hdr, layer_info_len, "Layer Info total")?;
        ensure_range(bytes, cur, layer_info_total, "Layer Info")?;
        if cur + layer_info_total > s4_end {
            return Err("Layer Info が Layer and Mask セクションを超えています".to_string());
        }
        out.extend_from_slice(&bytes[cur..cur + layer_info_total]);
        cur += layer_info_total;

        if cur + 4 <= s4_end {
            let global_mask_len = read_u32(bytes, cur)? as usize;
            let global_mask_total = checked_add(4, global_mask_len, "Global Mask total")?;
            ensure_range(bytes, cur, global_mask_total, "Global Mask")?;
            if cur + global_mask_total > s4_end {
                return Err("Global Mask が Layer and Mask セクションを超えています".to_string());
            }
            out.extend_from_slice(&bytes[cur..cur + global_mask_total]);
        }
    }

    let new_s4_len = out.len() - s4_out_start - s4_hdr;
    write_section_len(&mut out, s4_out_start, is_psb, new_s4_len)?;
    offset = s4_end;

    if offset < bytes.len() {
        out.extend_from_slice(&bytes[offset..]);
    }
    Ok(out)
}

fn copy_u32_len_section(bytes: &[u8], offset: &mut usize, out: &mut Vec<u8>, label: &str) -> Result<(), String> {
    let len = read_u32(bytes, *offset)? as usize;
    let total = checked_add(4, len, label)?;
    ensure_range(bytes, *offset, total, label)?;
    out.extend_from_slice(&bytes[*offset..*offset + total]);
    *offset += total;
    Ok(())
}

fn read_section_len(bytes: &[u8], offset: usize, is_psb: bool) -> Result<usize, String> {
    if is_psb {
        let len = read_u64(bytes, offset)?;
        usize::try_from(len).map_err(|_| "PSBセクション長が大きすぎます".to_string())
    } else {
        Ok(read_u32(bytes, offset)? as usize)
    }
}

fn write_section_len(out: &mut [u8], offset: usize, is_psb: bool, len: usize) -> Result<(), String> {
    if is_psb {
        let v = u64::try_from(len).map_err(|_| "PSB修復セクション長が大きすぎます".to_string())?;
        out[offset..offset + 8].copy_from_slice(&v.to_be_bytes());
    } else {
        let v = u32::try_from(len).map_err(|_| "PSD修復セクション長が大きすぎます".to_string())?;
        out[offset..offset + 4].copy_from_slice(&v.to_be_bytes());
    }
    Ok(())
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, String> {
    ensure_range(bytes, offset, 2, "u16")?;
    Ok(u16::from_be_bytes([bytes[offset], bytes[offset + 1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    ensure_range(bytes, offset, 4, "u32")?;
    Ok(u32::from_be_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ]))
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, String> {
    ensure_range(bytes, offset, 8, "u64")?;
    Ok(u64::from_be_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7],
    ]))
}

fn ensure_range(bytes: &[u8], offset: usize, len: usize, label: &str) -> Result<(), String> {
    let end = checked_add(offset, len, label)?;
    if end > bytes.len() {
        return Err(format!("{} の範囲がファイル終端を超えています", label));
    }
    Ok(())
}

fn checked_add(a: usize, b: usize, label: &str) -> Result<usize, String> {
    a.checked_add(b)
        .ok_or_else(|| format!("{} のサイズ計算がオーバーフローしました", label))
}
