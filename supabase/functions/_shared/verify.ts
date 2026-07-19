import type {
  BannerVerdict,
  CandidateMatch,
  ExpectedBanner,
  QaVerdict,
  ThemeBlock,
} from "./types.ts";

type JsonObject = Record<string, unknown>;

export function collectBannerBlocks(
  template: JsonObject,
  sectionHint?: string,
): ThemeBlock[] {
  const sections = isObject(template.sections) ? template.sections : {};
  const all: ThemeBlock[] = [];

  for (const [sectionId, rawSection] of Object.entries(sections)) {
    if (!isObject(rawSection)) continue;
    if (sectionHint && !hintMatches(sectionHint, sectionId)) continue;

    const sectionType = String(rawSection.type ?? "");
    const sectionLooksRelevant = sectionHint ||
      /(hero|slide|banner|promo|carousel)/i.test(sectionType);
    if (!sectionLooksRelevant) continue;

    const blocks = isObject(rawSection.blocks) ? rawSection.blocks : {};
    for (const [blockId, rawBlock] of Object.entries(blocks)) {
      if (!isObject(rawBlock)) continue;
      all.push({
        sectionId,
        sectionType,
        blockId,
        blockType: String(rawBlock.type ?? ""),
        disabled: rawBlock.disabled === true || rawSection.disabled === true,
        settings: isObject(rawBlock.settings) ? rawBlock.settings : {},
      });
    }

    if (!Object.keys(blocks).length && isObject(rawSection.settings)) {
      all.push({
        sectionId,
        sectionType,
        blockId: "__section__",
        blockType: sectionType,
        disabled: rawSection.disabled === true,
        settings: rawSection.settings,
      });
    }
  }

  return all;
}

export function matchExpectedBanners(
  expectedBanners: ExpectedBanner[],
  blocks: ThemeBlock[],
  blockHint?: string,
): CandidateMatch[] {
  const unused = new Set(blocks.map((block) => block.blockId));
  return expectedBanners.map((expected) => {
    const ranked = blocks
      .filter((block) => unused.has(block.blockId))
      .map((block) => ({
        block,
        score: scoreBlock(expected, block, blockHint),
      }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];

    if (!best || best.score < 1) {
      return {
        expected,
        block: null,
        matchScore: best?.score ?? 0,
        matchedBy: "none",
      };
    }

    unused.delete(best.block.blockId);
    const byHint = Boolean(
      blockHint && hintMatches(blockHint, best.block.blockId),
    );
    return {
      expected,
      block: best.block,
      matchScore: Math.min(1, best.score / 2),
      matchedBy: byHint ? "block_hint" : "link",
    };
  });
}

export function applyDeterministicGuards(
  aiVerdict: QaVerdict,
  matches: CandidateMatch[],
  configuredThemeId: string,
  publishedThemeId: string,
): QaVerdict {
  const guardedBanners = aiVerdict.banners.map((verdict, index) =>
    guardBanner(verdict, matches[index])
  );
  const warnings = [...new Set(aiVerdict.warnings ?? [])];
  if (configuredThemeId !== publishedThemeId) {
    warnings.push(
      `Configured theme ${configuredThemeId} is not the published theme ${publishedThemeId}.`,
    );
  }

  const missing = matches.length !== guardedBanners.length ||
    matches.some((match) => !match.block);
  const passed = !missing && guardedBanners.length > 0 &&
    guardedBanners.every((banner) => banner.ok);

  return {
    ...aiVerdict,
    passed,
    confidence: clamp01(
      Math.min(aiVerdict.confidence, ...matches.map((m) => m.matchScore)),
    ),
    banners: guardedBanners,
    warnings,
    summary: passed
      ? aiVerdict.summary
      : aiVerdict.summary || "One or more banner schedule checks failed.",
  };
}

export function formatFailureComment(verdict: QaVerdict): string {
  const lines = ["Automated promo QA found configuration issues:"];
  for (const banner of verdict.banners) {
    if (banner.ok) continue;
    lines.push(
      `- ${banner.label}: ${banner.issues.join("; ") || "did not pass"}`,
    );
  }
  for (const warning of verdict.warnings) lines.push(`- Warning: ${warning}`);
  lines.push(`Confidence: ${Math.round(verdict.confidence * 100)}%`);
  return lines.join("\n");
}

function guardBanner(
  verdict: BannerVerdict,
  match: CandidateMatch | undefined,
): BannerVerdict {
  const issues = [...new Set(verdict.issues ?? [])];
  const block = match?.block;
  if (!match || !block) {
    issues.push("No matching banner block was found by promo link.");
    return { ...verdict, matched_block_id: null, ok: false, issues };
  }
  if (verdict.matched_block_id !== block.blockId) {
    issues.push(
      `AI selected an unexpected block; expected candidate ${block.blockId}.`,
    );
  }
  if (block.disabled) {
    issues.push("The matched banner block or section is disabled.");
  }

  const foundStart = readMappedValue(block.settings, verdict.start_field);
  const foundEnd = readMappedValue(block.settings, verdict.end_field);
  const foundLink = readMappedValue(block.settings, verdict.link_field);
  const expected = match.expected;

  if (!expected.start_date) {
    issues.push("The Asana spec has no unambiguous start date.");
  } else if (normalizeDate(foundStart) !== normalizeDate(expected.start_date)) {
    issues.push(
      `Start date mismatch: expected ${expected.start_date}, found ${
        foundStart ?? "missing"
      }.`,
    );
  }
  if (!expected.end_date) {
    issues.push("The Asana spec has no unambiguous end date.");
  } else if (normalizeDate(foundEnd) !== normalizeDate(expected.end_date)) {
    issues.push(
      `End date mismatch: expected ${expected.end_date}, found ${
        foundEnd ?? "missing"
      }.`,
    );
  }
  if (!expected.promo_link) {
    issues.push("The Asana spec has no unambiguous promo link.");
  } else if (!foundLink || !urlsEquivalent(expected.promo_link, foundLink)) {
    issues.push(
      `Link mismatch: expected ${expected.promo_link}, found ${
        foundLink ?? "missing"
      }.`,
    );
  }

  return {
    ...verdict,
    matched_block_id: block.blockId,
    found_start: foundStart,
    found_end: foundEnd,
    found_link: foundLink,
    ok: issues.length === 0,
    issues,
  };
}

function scoreBlock(
  expected: ExpectedBanner,
  block: ThemeBlock,
  blockHint?: string,
): number {
  const values = Object.values(block.settings)
    .filter((value): value is string => typeof value === "string");
  let score = 0;
  if (
    expected.promo_link &&
    values.some((value) =>
      looksLikeUrl(value) && urlsEquivalent(value, expected.promo_link!)
    )
  ) score += 1;
  if (
    expected.start_date &&
    values.some((value) => normalizeDate(value) === expected.start_date)
  ) {
    score += 0.45;
  }
  if (
    expected.end_date &&
    values.some((value) => normalizeDate(value) === expected.end_date)
  ) {
    score += 0.45;
  }
  if (blockHint && hintMatches(blockHint, block.blockId)) score += 0.2;
  if (block.disabled) score -= 0.1;
  return score;
}

function readMappedValue(
  settings: Record<string, unknown>,
  field: string | null,
): string | null {
  if (!field) return null;
  const value = settings[field];
  return typeof value === "string"
    ? value
    : value == null
    ? null
    : String(value);
}

export function urlsEquivalent(left: string, right: string): boolean {
  try {
    const a = canonicalUrl(left);
    const b = canonicalUrl(right);
    return a === b || discountIdentity(a) === discountIdentity(b);
  } catch {
    return decodeRepeatedly(left).replace(/\/$/, "") ===
      decodeRepeatedly(right).replace(/\/$/, "");
  }
}

function canonicalUrl(raw: string): string {
  const url = new URL(decodeRepeatedly(raw));
  const params = [...url.searchParams.entries()]
    .sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv));
  url.search = new URLSearchParams(params).toString();
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

function discountIdentity(canonical: string): string {
  const url = new URL(canonical);
  const match = url.pathname.match(/\/discount\/([^/]+)/i);
  return match
    ? `${decodeRepeatedly(match[1]).toLowerCase()}|${
      decodeRepeatedly(url.searchParams.get("redirect") ?? "")
    }`
    : canonical;
}

function decodeRepeatedly(value: string): string {
  let decoded = value;
  for (let index = 0; index < 3; index++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function normalizeDate(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? null;
}

function looksLikeUrl(value: string): boolean {
  return /^(https?:\/\/|shopify:\/\/|\/)/i.test(value);
}

function hintMatches(hint: string, id: string): boolean {
  return hint === id || hint.includes(id) || id.includes(hint);
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
