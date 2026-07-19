import type { CandidateMatch, ParsedPromoSpec, QaVerdict } from "./types.ts";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

export class AnthropicClient {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(
    apiKey: string,
    model = "claude-sonnet-4-5",
  ) {
    this.apiKey = apiKey;
    this.model = model;
  }

  private async jsonMessage<T>(
    system: string,
    input: unknown,
    maxTokens = 3000,
  ): Promise<T> {
    const response = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        temperature: 0,
        system,
        messages: [{
          role: "user",
          content: JSON.stringify(input),
        }],
      }),
    });

    const payload = await response.json().catch(() => null) as {
      content?: Array<{ type: string; text?: string }>;
      error?: { message?: string };
    } | null;
    if (!response.ok) {
      throw new Error(
        payload?.error?.message ??
          `Anthropic request failed (${response.status})`,
      );
    }

    const text = payload?.content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n") ?? "";
    return parseJsonResponse<T>(text);
  }

  async parsePromoSpec(input: {
    taskName: string;
    taskNotes: string;
    parentName?: string;
    parentNotes?: string;
    currentDate: string;
  }): Promise<ParsedPromoSpec> {
    const parsed = await this.jsonMessage<ParsedPromoSpec>(
      `You extract a Shopify promotion specification from Asana task text.
Return JSON only with this exact shape:
{"banners":[{"label":"string","promo_link":"string|null","start_date":"YYYY-MM-DD|null","end_date":"YYYY-MM-DD|null","copy":"string|null"}],"summary":"string","timezone":"string|null","confidence":0.0,"ambiguities":["string"]}
Rules:
- Read both the QA task and parent task; either may contain the specification.
- Each separately scheduled banner/version is a separate banners entry.
- Resolve month/day dates to a year using the provided currentDate and task context.
- Preserve inclusive dates. A one-day banner has the same start_date and end_date.
- Do not invent missing values. Put null and explain in ambiguities.
- confidence is 0..1 and must be below 0.8 if schedule or matching link is ambiguous.`,
      input,
    );

    validateParsedSpec(parsed);
    return parsed;
  }

  async verifyCandidates(input: {
    spec: ParsedPromoSpec;
    candidates: CandidateMatch[];
    configuredThemeId: string;
    publishedThemeId: string;
  }): Promise<QaVerdict> {
    const compactCandidates = input.candidates.map((candidate) => ({
      expected: candidate.expected,
      matchedBy: candidate.matchedBy,
      matchScore: candidate.matchScore,
      block: candidate.block
        ? {
          sectionId: candidate.block.sectionId,
          sectionType: candidate.block.sectionType,
          blockId: candidate.block.blockId,
          blockType: candidate.block.blockType,
          disabled: candidate.block.disabled,
          settings: candidate.block.settings,
        }
        : null,
    }));

    const verdict = await this.jsonMessage<QaVerdict>(
      `You verify Shopify homepage banner schedule configuration against a parsed Asana spec.
Return JSON only:
{"passed":false,"confidence":0.0,"summary":"string","banners":[{"label":"string","matched_block_id":"string|null","start_field":"string|null","end_field":"string|null","link_field":"string|null","found_start":"YYYY-MM-DD|null","found_end":"YYYY-MM-DD|null","found_link":"string|null","ok":false,"issues":["string"]}],"warnings":["string"]}
Rules:
- Identify semantically equivalent date/link fields even if names vary by theme.
- Compare dates exactly and inclusively. Never treat a one-day difference as acceptable.
- Match expected banners to provided blocks; do not use a block that was not provided.
- Disabled blocks fail.
- Missing expected links/dates or missing matching blocks lower confidence and fail.
- URL encoding differences are acceptable only when decoded URL semantics are identical.
- If configuredThemeId differs from publishedThemeId, add a warning but do not fail solely for that.
- passed can be true only when every expected banner is matched and all dates/links match.
- confidence is 0..1.`,
      {
        spec: input.spec,
        candidates: compactCandidates,
        configuredThemeId: input.configuredThemeId,
        publishedThemeId: input.publishedThemeId,
      },
      4000,
    );

    validateQaVerdict(verdict);
    return verdict;
  }
}

function parseJsonResponse<T>(text: string): T {
  const trimmed = text.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Claude did not return JSON");
  return JSON.parse(trimmed.slice(start, end + 1)) as T;
}

function validateParsedSpec(value: ParsedPromoSpec): void {
  if (!Array.isArray(value?.banners) || !value.banners.length) {
    throw new Error("Claude returned no expected banners");
  }
  if (typeof value.confidence !== "number") {
    throw new Error("Claude spec response omitted confidence");
  }
}

function validateQaVerdict(value: QaVerdict): void {
  if (!Array.isArray(value?.banners) || typeof value.passed !== "boolean") {
    throw new Error("Claude returned an invalid QA verdict");
  }
  if (typeof value.confidence !== "number") {
    throw new Error("Claude QA response omitted confidence");
  }
}
