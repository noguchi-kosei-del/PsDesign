const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff々〆ヵヶ]/u;
const DASH_LIKE_RE = /[\u2010-\u2015\u2212\ufe58\ufe63\uff0d\uff70\u30fc\u2500-\u2503|｜]/g;

export function normalizeOcrRiskText(value) {
  return String(value ?? "")
    .replace(/\{([^{}]+)\}\(([^()]+)\)/g, "$1")
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\s\u3000]+/g, "")
    .replace(DASH_LIKE_RE, "ー")
    .replace(/[、。，．.,!?！？・…ー\-()（）「」『』【】［］\[\]〈〉《》]/g, "")
    .trim();
}
export function containsCjk(value) {
  return CJK_RE.test(String(value ?? ""));
}

function positionalMismatchStats(a, b) {
  const aa = Array.from(a);
  const bb = Array.from(b);
  const len = Math.min(aa.length, bb.length);
  let mismatches = Math.abs(aa.length - bb.length);
  let cjkMismatches = 0;
  for (let i = 0; i < len; i += 1) {
    if (aa[i] === bb[i]) continue;
    mismatches += 1;
    if (containsCjk(aa[i]) || containsCjk(bb[i])) cjkMismatches += 1;
  }
  return { mismatches, cjkMismatches, len: Math.min(aa.length, bb.length), longer: Math.max(aa.length, bb.length) };
}

export function assessOcrRisk(expectedRaw, scannedRaw) {
  const expected = normalizeOcrRiskText(expectedRaw);
  const scanned = normalizeOcrRiskText(scannedRaw);
  if (!expected || !scanned || expected === scanned) {
    return { risky: false, expected, scanned, reason: "" };
  }
  const stats = positionalMismatchStats(expected, scanned);
  const hasCjk = containsCjk(expected) || containsCjk(scanned);
  if (!hasCjk) return { risky: false, expected, scanned, reason: "" };

  const sameLength = expected.length === scanned.length;
  const shortText = stats.longer <= 4;
  const compactText = stats.longer <= 8;
  if (shortText && stats.cjkMismatches >= 1) {
    return {
      risky: true,
      expected,
      scanned,
      reason: "短い漢字語のOCR差分",
      ...stats,
    };
  }
  if (compactText && sameLength && stats.cjkMismatches >= 1 && stats.mismatches <= 2) {
    return {
      risky: true,
      expected,
      scanned,
      reason: "短い語の漢字置換疑い",
      ...stats,
    };
  }
  if (compactText && stats.cjkMismatches >= 2) {
    return {
      risky: true,
      expected,
      scanned,
      reason: "漢字差分が多い短文",
      ...stats,
    };
  }
  return { risky: false, expected, scanned, reason: "", ...stats };
}
