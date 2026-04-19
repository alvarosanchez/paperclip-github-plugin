export type PluginConfigBoardTokenRefs = Record<string, string>;
export type PluginConfigGitHubTokenRefs = Record<string, string>;

export interface GitHubSyncPluginConfig extends Record<string, unknown> {
  githubTokenRefs?: PluginConfigGitHubTokenRefs;
  githubTokenRef?: string;
  paperclipBoardApiTokenRefs?: PluginConfigBoardTokenRefs;
  paperclipApiBaseUrl?: string;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizePaperclipApiBaseUrl(value: unknown): string | undefined {
  const normalizedValue = normalizeOptionalString(value);
  if (!normalizedValue) {
    return undefined;
  }

  try {
    return new URL(normalizedValue).origin;
  } catch {
    return undefined;
  }
}

export function normalizePluginConfigBoardTokenRefs(value: unknown): PluginConfigBoardTokenRefs | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .map(([companyId, secretRef]) => {
      const normalizedCompanyId = normalizeOptionalString(companyId);
      const normalizedSecretRef = normalizeOptionalString(secretRef);
      return normalizedCompanyId && normalizedSecretRef
        ? [normalizedCompanyId, normalizedSecretRef] as const
        : null;
    })
    .filter((entry): entry is readonly [string, string] => Boolean(entry));

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

export function normalizePluginConfigGitHubTokenRefs(value: unknown): PluginConfigGitHubTokenRefs | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .map(([companyId, secretRef]) => {
      const normalizedCompanyId = normalizeOptionalString(companyId);
      const normalizedSecretRef = normalizeOptionalString(secretRef);
      return normalizedCompanyId && normalizedSecretRef
        ? [normalizedCompanyId, normalizedSecretRef] as const
        : null;
    })
    .filter((entry): entry is readonly [string, string] => Boolean(entry));

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

export function normalizePluginConfig(value: unknown): GitHubSyncPluginConfig {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const record = { ...(value as Record<string, unknown>) };
  const githubTokenRefs = normalizePluginConfigGitHubTokenRefs(record.githubTokenRefs);
  const githubTokenRef = normalizeOptionalString(record.githubTokenRef);
  const paperclipBoardApiTokenRefs = normalizePluginConfigBoardTokenRefs(record.paperclipBoardApiTokenRefs);
  const paperclipApiBaseUrl = normalizePaperclipApiBaseUrl(record.paperclipApiBaseUrl);

  if (githubTokenRefs) {
    record.githubTokenRefs = githubTokenRefs;
  } else {
    delete record.githubTokenRefs;
  }

  if (githubTokenRef) {
    record.githubTokenRef = githubTokenRef;
  } else {
    delete record.githubTokenRef;
  }

  if (paperclipBoardApiTokenRefs) {
    record.paperclipBoardApiTokenRefs = paperclipBoardApiTokenRefs;
  } else {
    delete record.paperclipBoardApiTokenRefs;
  }

  if (paperclipApiBaseUrl) {
    record.paperclipApiBaseUrl = paperclipApiBaseUrl;
  } else {
    delete record.paperclipApiBaseUrl;
  }

  return record as GitHubSyncPluginConfig;
}

export function mergePluginConfig(
  currentValue: unknown,
  patch: Partial<GitHubSyncPluginConfig>
): GitHubSyncPluginConfig {
  const current = normalizePluginConfig(currentValue);
  const currentGitHubTokenRefs = normalizePluginConfigGitHubTokenRefs(current.githubTokenRefs);
  const patchGitHubTokenRefs = normalizePluginConfigGitHubTokenRefs(patch.githubTokenRefs);
  const currentBoardTokenRefs = normalizePluginConfigBoardTokenRefs(current.paperclipBoardApiTokenRefs);
  const patchBoardTokenRefs = normalizePluginConfigBoardTokenRefs(patch.paperclipBoardApiTokenRefs);
  const next = normalizePluginConfig({
    ...current,
    ...patch
  });

  if ('githubTokenRefs' in patch) {
    const mergedGitHubTokenRefs = {
      ...(currentGitHubTokenRefs ?? {}),
      ...(patchGitHubTokenRefs ?? {})
    };

    if (Object.keys(mergedGitHubTokenRefs).length > 0) {
      next.githubTokenRefs = mergedGitHubTokenRefs;
    } else {
      delete next.githubTokenRefs;
    }
  } else if (currentGitHubTokenRefs) {
    next.githubTokenRefs = currentGitHubTokenRefs;
  }

  if ('paperclipBoardApiTokenRefs' in patch) {
    const mergedBoardTokenRefs = {
      ...(currentBoardTokenRefs ?? {}),
      ...(patchBoardTokenRefs ?? {})
    };

    if (Object.keys(mergedBoardTokenRefs).length > 0) {
      next.paperclipBoardApiTokenRefs = mergedBoardTokenRefs;
    } else {
      delete next.paperclipBoardApiTokenRefs;
    }
  } else if (currentBoardTokenRefs) {
    next.paperclipBoardApiTokenRefs = currentBoardTokenRefs;
  }

  return next;
}
