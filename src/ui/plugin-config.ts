export interface PluginConfigSecretRef {
  type: 'secret_ref';
  secretId: string;
  version?: number | 'latest';
}

export type PluginConfigSecretReference = string | PluginConfigSecretRef;
export type PluginConfigBoardTokenRefs = Record<string, PluginConfigSecretReference>;
export type PluginConfigGitHubTokenRefs = Record<string, PluginConfigSecretReference>;

export interface GitHubSyncPluginConfig extends Record<string, unknown> {
  githubTokenRefs?: PluginConfigGitHubTokenRefs;
  paperclipBoardApiTokenRefs?: PluginConfigBoardTokenRefs;
  paperclipApiBaseUrl?: string;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function createPluginConfigSecretRef(secretId: string): PluginConfigSecretRef {
  return { type: 'secret_ref', secretId };
}

export function normalizePluginConfigSecretRef(value: unknown): PluginConfigSecretReference | undefined {
  const stringRef = normalizeOptionalString(value);
  if (stringRef) {
    return stringRef;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const secretId = normalizeOptionalString(record.secretId);
  if (record.type !== 'secret_ref' || !secretId) {
    return undefined;
  }

  const version = record.version === 'latest'
    ? 'latest' as const
    : typeof record.version === 'number' && Number.isSafeInteger(record.version) && record.version > 0
      ? record.version
      : undefined;
  return {
    type: 'secret_ref',
    secretId,
    ...(version ? { version } : {})
  };
}

export function normalizePaperclipApiBaseUrl(value: unknown): string | undefined {
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
      const normalizedSecretRef = normalizePluginConfigSecretRef(secretRef);
      return normalizedCompanyId && normalizedSecretRef
        ? [normalizedCompanyId, normalizedSecretRef] as const
        : null;
    })
    .filter((entry): entry is readonly [string, PluginConfigSecretReference] => Boolean(entry));

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
      const normalizedSecretRef = normalizePluginConfigSecretRef(secretRef);
      return normalizedCompanyId && normalizedSecretRef
        ? [normalizedCompanyId, normalizedSecretRef] as const
        : null;
    })
    .filter((entry): entry is readonly [string, PluginConfigSecretReference] => Boolean(entry));

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
  const paperclipBoardApiTokenRefs = normalizePluginConfigBoardTokenRefs(record.paperclipBoardApiTokenRefs);
  const paperclipApiBaseUrl = normalizePaperclipApiBaseUrl(record.paperclipApiBaseUrl);

  if (githubTokenRefs) {
    record.githubTokenRefs = githubTokenRefs;
  } else {
    delete record.githubTokenRefs;
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

export function resolvePaperclipApiBaseUrlForPluginAction(value: unknown, fallbackOrigin?: unknown): string | undefined {
  return normalizePluginConfig(value).paperclipApiBaseUrl ?? normalizePaperclipApiBaseUrl(fallbackOrigin);
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
