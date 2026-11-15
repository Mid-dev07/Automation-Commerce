const HIGH_CONFIDENCE_PATTERNS = [
  /\b(?:verification|confirmation|security|authentication|login|log[\s-]?in|sign[\s-]?in|one[\s-]?time|access|recovery|reset|device)\s+(?:security\s+)?(?:code|pin|password|passcode|token)\b/giu,
  /\b(?:passcode|pass[\s-]?code|one[\s-]?time\s+(?:password|code)|otp)\b/giu,
  /\b(?:steam\s+guard|google\s+verification|meta\s+confirmation|facebook\s+login|discord\s+verification)\s+code\b/giu,
  /\bcode\s+(?:for|to)\s+(?:verify|verification|confirm|confirmation|login|sign[\s-]?in|your\s+account)\b/giu,
  /\b(?:kode\s+(?:verifikasi|konfirmasi|keamanan|login|masuk|otp|akses|sekali\s+pakai)|kode\s+autentikasi)\b/giu,
  /\b(?:c[oó]digo\s+(?:de\s+)?(?:verificaci[oó]n|confirmaci[oó]n|seguridad|acceso)|c[oó]digo\s+de\s+autenticaci[oó]n)\b/giu,
  /\b(?:code\s+de\s+(?:v[eé]rification|confirmation|s[eé]curit[eé]|connexion)|code\s+de\s+v[eé]rification)\b/giu,
  /\b(?:best[aä]tigungs|sicherheits|anmelde|einmal)[\s-]?code\b/giu,
  /\b(?:c[oó]digo\s+de\s+(?:verifica[cç][aã]o|confirma[cç][aã]o)|senha\s+de\s+uso\s+[uú]nico)\b/giu
];

const CONTEXT_PATTERNS = [
  /\b(?:your|the|this|following|unique|temporary)\s+(?:one[\s-]?time\s+)?(?:verification\s+|confirmation\s+|security\s+|login\s+)?code\b/giu,
  /\b(?:enter|type|use|copy|input)\s+(?:the|this|following|your)?\s*(?:verification\s+|confirmation\s+|security\s+|login\s+)?code\b/giu,
  /\bcode\s*(?:is|equals|:|=)\s*/giu,
  /\b(?:code|kode|c[oó]digo)\s*(?:anda\s*)?(?:is|adalah|anda|berikut|:|=)\s*/giu,
  /\b(?:enter|use|masukkan|gunakan)\s+(?:the\s+|this\s+|berikut\s+)?(?:code|kode)\b/giu
];

const NEGATIVE_PATTERNS = [
  /\b(?:order|transaction|invoice|reference|receipt|tracking|ticket|case|account|customer|user|support)\s*(?:number|no\.?|id|#|reference)\b/giu,
  /\b(?:phone|mobile|telephone|whatsapp)\s*(?:number|no\.?|:)?\b/giu,
  /\b(?:amount|total|subtotal|price|payment|paid|balance|fee|due)\s*(?:is|of|:|=)?\s*/giu,
  /\b(?:date|time|expires?|expiry|valid\s+until|sent\s+at)\s*(?:is|on|at|:|=)?\s*/giu,
  /\b(?:postal|zip|routing|swift|iban|reference)\s*(?:code|number|no\.?|:)?\b/giu
];

function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\u00A0\u202F]/g, " ")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function compactCandidate(raw, kind) {
  const compact = raw.replace(/[\s-]/g, "").toUpperCase();
  if (kind === "numeric") {
    if (!/^\d{4,8}$/.test(compact)) return "";
    if (/^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})$/.test(raw.trim())) return "";
    return compact;
  }
  if (!/^[A-Z0-9]{5,10}$/.test(compact) || !/[A-Z]/.test(compact) || !/\d/.test(compact)) return "";
  const prefixed = compact.match(/^(?:G|FB)(\d{4,8})$/);
  return prefixed ? prefixed[1] : compact;
}

function collectCandidates(text) {
  const candidates = new Map();
  const patterns = [
    { kind: "numeric", regex: /(?<![\p{L}\p{N}-])\d(?:[\d \u00A0-]{2,14}\d)(?![\p{L}\p{N}-])/gu },
    { kind: "alphanumeric", regex: /(?<![\p{L}\p{N}])(?=[A-Z0-9-]{5,12}(?![\p{L}\p{N}]))(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)*(?![\p{L}\p{N}])/giu }
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      const code = compactCandidate(match[0], pattern.kind);
      if (!code) continue;
      const existing = candidates.get(code);
      const occurrence = { start: match.index, end: match.index + match[0].length };
      if (existing) existing.occurrences.push(occurrence);
      else candidates.set(code, { code, occurrences: [occurrence] });
    }
  }
  return [...candidates.values()];
}

function nearestSignal(text, start, end, patterns) {
  let best = null;
  for (const pattern of patterns) {
    const regex = new RegExp(pattern.source, pattern.flags);
    for (const match of text.matchAll(regex)) {
      const matchStart = match.index;
      const matchEnd = matchStart + match[0].length;
      const distance = matchEnd < start ? start - matchEnd : matchStart > end ? matchStart - end : 0;
      if (distance > 120) continue;
      const signal = {
        distance,
        score: pattern.score ?? 0,
        start: matchStart,
        end: matchEnd
      };
      if (!best || signal.distance < best.distance ||
          (signal.distance === best.distance && signal.score > best.score)) best = signal;
    }
  }
  return best;
}

const HIGH_PATTERNS = HIGH_CONFIDENCE_PATTERNS.map(regex => ({ source: regex.source, flags: "giu", score: 12 }));
const MEDIUM_PATTERNS = CONTEXT_PATTERNS.map(regex => ({ source: regex.source, flags: "giu", score: 8 }));
const EXCLUSION_PATTERNS = NEGATIVE_PATTERNS.map(regex => ({ source: regex.source, flags: "giu", score: -10 }));

function scoreOccurrence(text, occurrence, code) {
  const high = nearestSignal(text, occurrence.start, occurrence.end, HIGH_PATTERNS);
  const medium = nearestSignal(text, occurrence.start, occurrence.end, MEDIUM_PATTERNS);
  const positive = !high ? medium : !medium ? high :
    high.score - Math.floor(high.distance / 45) >= medium.score - Math.floor(medium.distance / 45) ? high : medium;
  if (!positive) return null;

  const negative = nearestSignal(text, occurrence.start, occurrence.end, EXCLUSION_PATTERNS);
  let score = positive.score - Math.floor(positive.distance / 45);
  if (positive.distance <= 24) score += 2;
  if (/^\d{6}$/.test(code)) score += 1;

  // Only suppress a candidate when a non-OTP identifier label is materially
  // closer to it than the OTP label. This avoids rejecting a real OTP merely
  // because the same email also contains an order or account reference.
  if (negative && negative.distance <= 60 && negative.distance + 8 < positive.distance) {
    score -= 12;
  }

  return { score, positiveDistance: positive.distance, negativeDistance: negative?.distance ?? Infinity };
}

export function extractVerificationCodeDetails(subjectValue, bodyValue) {
  const text = normalizedText(String(subjectValue ?? "") + "\n" + String(bodyValue ?? "")).slice(0, 24000);
  if (!text) return { code: "", status: "not_found", candidate_count: 0 };

  const candidates = collectCandidates(text);
  const ranked = [];
  for (const candidate of candidates) {
    const scores = candidate.occurrences
      .map(occurrence => scoreOccurrence(text, occurrence, candidate.code))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    if (scores.length) ranked.push({ code: candidate.code, score: scores[0].score });
  }

  ranked.sort((a, b) => b.score - a.score);
  if (!ranked.length || ranked[0].score < 8) {
    return { code: "", status: "not_found", candidate_count: candidates.length };
  }

  const first = ranked[0];
  const second = ranked[1];
  if (second && first.score - second.score < 2) {
    return { code: "", status: "ambiguous", candidate_count: ranked.length };
  }

  return { code: first.code, status: "detected", candidate_count: ranked.length };
}

export function extractVerificationCode(subjectValue, bodyValue) {
  return extractVerificationCodeDetails(subjectValue, bodyValue).code;
}
