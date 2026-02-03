export const FALLBACK_OTHER_AI_MODELS: Record<string, string[]> = {
  // Fallbacks are used when we cannot fetch model lists (no API key, CLI doesn't support listing).
  // Users can still override these in Settings > Other AI.
  claude: ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"],
  gemini: ["gemini-3-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro"],
};

export function getFallbackOtherAiModels(provider: string): string[] {
  return FALLBACK_OTHER_AI_MODELS[provider] ?? [];
}

export function normalizeModelList(models: string[]): string[] {
  return Array.from(
    new Set(
      models
        .map((model) => model.trim())
        .filter((model) => model.length > 0),
    ),
  );
}

const titleCaseToken = (token: string) => {
  const normalized = token.trim();
  if (!normalized) {
    return normalized;
  }
  if (/^\d+(\.\d+)?$/.test(normalized)) {
    return normalized;
  }
  const lower = normalized.toLowerCase();
  const specials: Record<string, string> = {
    pro: "Pro",
    flash: "Flash",
    preview: "Preview",
    opus: "Opus",
    sonnet: "Sonnet",
    haiku: "Haiku",
    codex: "Codex",
  };
  const special = specials[lower];
  if (special) {
    return special;
  }
  return lower.charAt(0).toUpperCase() + lower.slice(1);
};

// Human-friendly label for known provider model slugs; O(k) time, O(k) space where k = slug length.
export function formatOtherAiModelSlug(provider: string, slug: string): string {
  const trimmed = slug.trim();
  if (!trimmed) {
    return "";
  }
  const normalizedProvider = provider.trim().toLowerCase();
  if (normalizedProvider !== "claude" && normalizedProvider !== "gemini") {
    return trimmed;
  }

  const prefix = `${normalizedProvider}-`;
  let base = trimmed.replace(/_/g, "-");
  if (base.toLowerCase().startsWith(prefix)) {
    base = base.slice(prefix.length);
  }

  const tokens = base.split("-").filter(Boolean);
  const parts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const current = tokens[i];
    const next = tokens[i + 1];
    // Prefer "4.5" instead of "4-5" when the second segment looks like a minor version.
    if (
      /^\d+$/.test(current) &&
      next &&
      /^\d+$/.test(next) &&
      current.length <= 2 &&
      next.length === 1
    ) {
      parts.push(`${current}.${next}`);
      i += 1;
      continue;
    }
    parts.push(current);
  }

  const display = parts.map(titleCaseToken).join(" ").trim();
  return display || trimmed;
}
