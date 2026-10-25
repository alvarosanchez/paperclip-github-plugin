/**
 * Pure filters that decide whether GitHub activity is allowed to reach an agent.
 *
 * Both settings are opt-in and default to an empty list, which means "keep the historical
 * behaviour": every trusted comment is an interaction that can roll an issue back and wake its
 * assignee, and every open GitHub issue is imported into Paperclip.
 *
 * The functions here never touch the network and never read plugin state, so the decision logic is
 * unit-testable in isolation from the sync flow.
 */

/**
 * Splits a saved setting that may arrive either as a real array (normalized state, action input)
 * or as the raw text a settings form submits.
 *
 * Trigger handles never contain whitespace, so they may be separated by commas, newlines, or
 * spaces. Labels frequently contain spaces (`good first issue`), so they are only split on commas
 * and newlines; splitting them on whitespace would silently mangle saved label names.
 */
function splitSettingList(value: unknown, options: { splitOnWhitespace: boolean }): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }

  if (typeof value === 'string') {
    return value.split(options.splitOnWhitespace ? /[\s,]+/g : /[,;\r\n]+/g);
  }

  return [];
}

function stripHandlePrefix(value: string): string {
  return value.trim().replace(/^@+/, '').trim();
}

/**
 * Normalizes `triggerHandles` into the lowercase, `@`-free form used for mention matching.
 *
 * Entries are intentionally not validated against GitHub's username grammar: dropping an
 * unparseable handle would silently disable the mention filter and let every trusted comment wake
 * the agent again. Keeping it means the filter stays on and simply never matches, which fails
 * closed.
 */
export function normalizeTriggerHandles(value: unknown): string[] {
  const entries = splitSettingList(value, { splitOnWhitespace: true })
    .map((entry) => stripHandlePrefix(entry).toLowerCase())
    .filter((entry) => entry.length > 0);

  return [...new Set(entries)];
}

/**
 * Normalizes `requiredLabels` into the trimmed label names used for import filtering.
 *
 * Case is preserved because GitHub label names are display names, but duplicates that only differ
 * by case are collapsed (GitHub treats label names case-insensitively for uniqueness).
 */
export function normalizeRequiredLabels(value: unknown): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];

  for (const entry of splitSettingList(value, { splitOnWhitespace: false })) {
    const label = entry.trim();
    const dedupeKey = label.toLowerCase();
    if (!label || seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    labels.push(label);
  }

  return labels;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds the pattern used to decide whether a comment body addresses one of the configured
 * handles, or `null` when no handles are configured.
 *
 * Boundaries matter: `@soulpal001-morty` must not match `@soulpal001-morty2` or a different
 * hyphenated handle, and an email-ish `someone@handle.example` must not count as a mention either.
 * Handles themselves may contain hyphens, so the terminator excludes the characters a GitHub login
 * can continue with instead of relying on a word boundary.
 */
export function buildTriggerHandleMentionPattern(triggerHandles: readonly string[]): RegExp | null {
  const handles = [...new Set(
    triggerHandles
      .map((handle) => (typeof handle === 'string' ? stripHandlePrefix(handle).toLowerCase() : ''))
      .filter((handle) => handle.length > 0)
  )].sort((left, right) => right.length - left.length || left.localeCompare(right));

  if (handles.length === 0) {
    return null;
  }

  const alternation = handles.map(escapeRegExp).join('|');
  return new RegExp(`(?:^|[^a-z0-9_.+\\-])@(?:${alternation})(?![a-z0-9_-])`, 'i');
}

/**
 * Reports whether a comment body should count as an agent-directed interaction.
 *
 * With no configured handles every comment counts, which is the historical behaviour. Once a
 * handle is configured, a comment only counts when its body mentions one of those handles
 * (case-insensitively).
 */
export function containsTriggerHandleMention(
  body: string | null | undefined,
  triggerHandles: readonly string[]
): boolean {
  const pattern = buildTriggerHandleMentionPattern(triggerHandles);
  if (!pattern) {
    return true;
  }

  if (typeof body !== 'string' || body.length === 0) {
    return false;
  }

  return pattern.test(body);
}

/**
 * Reports whether a GitHub issue carries at least one of the required labels.
 *
 * With no required labels every issue matches, which is the historical behaviour. Label names are
 * compared case-insensitively and trimmed, matching how GitHub treats label names.
 */
export function matchesRequiredLabels(
  issueLabels: ReadonlyArray<{ name?: unknown } | null | undefined> | null | undefined,
  requiredLabels: readonly string[]
): boolean {
  const required = new Set(
    requiredLabels
      .map((label) => (typeof label === 'string' ? label.trim().toLowerCase() : ''))
      .filter((label) => label.length > 0)
  );

  if (required.size === 0) {
    return true;
  }

  return (issueLabels ?? []).some((label) =>
    Boolean(label) && typeof label?.name === 'string' && required.has(label.name.trim().toLowerCase())
  );
}
