export type PluginConfigBoardTokenRefs = Record<string, string>;

export interface GitHubSyncPluginConfig extends Record<string, unknown> {
  githubTokenRef?: string;
  paperclipBoardApiTokenRefs?: PluginConfigBoardTokenRefs;
  paperclipApiBaseUrl?: string;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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

export function normalizePluginConfig(value: unknown): GitHubSyncPluginConfig {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const record = { ...(value as Record<string, unknown>) };
  const githubTokenRef = normalizeOptionalString(record.githubTokenRef);
  const paperclipBoardApiTokenRefs = normalizePluginConfigBoardTokenRefs(record.paperclipBoardApiTokenRefs);
  const paperclipApiBaseUrl = normalizeOptionalString(record.paperclipApiBaseUrl);

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
  const currentBoardTokenRefs = normalizePluginConfigBoardTokenRefs(current.paperclipBoardApiTokenRefs);
  const patchBoardTokenRefs = normalizePluginConfigBoardTokenRefs(patch.paperclipBoardApiTokenRefs);
  const next = normalizePluginConfig({
    ...current,
    ...patch
  });

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
