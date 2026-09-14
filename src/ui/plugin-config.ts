/**
 * Paperclip 2026.831 binds plugin secret refs only when plugin config stores them as the shared
 * `{ type: "secret_ref", secretId, version? }` binding, and the worker can only resolve bound refs.
 * Older releases mirrored bare secret-id strings; the helpers below accept both shapes and always
 * write bindings so a re-save upgrades legacy rows.
 */
export interface PluginSecretRefBinding {
  type: 'secret_ref';
  secretId: string;
  version?: number | 'latest';
}

export type PluginConfigSecretRefInput = string | PluginSecretRefBinding;
export type PluginConfigBoardTokenRefs = Record<string, PluginSecretRefBinding>;
export type PluginConfigGitHubTokenRefs = Record<string, PluginSecretRefBinding>;

export interface GitHubSyncPluginConfig extends Record<string, unknown> {
  githubTokenRefs?: PluginConfigGitHubTokenRefs;
  paperclipBoardApiTokenRefs?: PluginConfigBoardTokenRefs;
  paperclipApiBaseUrl?: string;
}

export interface GitHubSyncPluginConfigPatch extends Record<string, unknown> {
  githubTokenRefs?: Record<string, PluginConfigSecretRefInput>;
  paperclipBoardApiTokenRefs?: Record<string, PluginConfigSecretRefInput>;
  paperclipApiBaseUrl?: string;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isPluginSecretRefBinding(value: unknown): value is PluginSecretRefBinding {
  return (
    isPlainRecord(value)
    && value.type === 'secret_ref'
    && typeof value.secretId === 'string'
    && Boolean(value.secretId.trim())
  );
}

export function normalizePluginSecretRefBinding(value: unknown): PluginSecretRefBinding | undefined {
  if (isPluginSecretRefBinding(value)) {
    const version = value.version;
    return {
      type: 'secret_ref',
      secretId: value.secretId.trim(),
      ...(version === 'latest' || (typeof version === 'number' && Number.isInteger(version) && version > 0)
        ? { version }
        : {})
    };
  }

  const secretId = normalizeOptionalString(value);
  return secretId ? { type: 'secret_ref', secretId } : undefined;
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

function normalizeCompanySecretRefMap(value: unknown): Record<string, PluginSecretRefBinding> | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .map(([companyId, secretRef]) => {
      const normalizedCompanyId = normalizeOptionalString(companyId);
      const normalizedSecretRef = normalizePluginSecretRefBinding(secretRef);
      return normalizedCompanyId && normalizedSecretRef
        ? [normalizedCompanyId, normalizedSecretRef] as const
        : null;
    })
    .filter((entry): entry is readonly [string, PluginSecretRefBinding] => Boolean(entry));

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

/**
 * Reports whether a raw plugin config row still stores any secret ref in the legacy bare
 * secret-id string shape. Such rows normalize to the same `{ type: "secret_ref" }` bindings a
 * patch produces, so callers must not skip a write based on normalized equality alone: the host
 * only binds (and the worker only resolves) refs stored as binding objects.
 */
export function hasLegacyPluginSecretRefs(value: unknown): boolean {
  if (!isPlainRecord(value)) {
    return false;
  }

  return [value.githubTokenRefs, value.paperclipBoardApiTokenRefs].some((refs) =>
    isPlainRecord(refs)
    && Object.values(refs).some((secretRef) => !isPluginSecretRefBinding(secretRef) && Boolean(normalizeOptionalString(secretRef)))
  );
}

export function normalizePluginConfigBoardTokenRefs(value: unknown): PluginConfigBoardTokenRefs | undefined {
  return normalizeCompanySecretRefMap(value);
}

export function normalizePluginConfigGitHubTokenRefs(value: unknown): PluginConfigGitHubTokenRefs | undefined {
  return normalizeCompanySecretRefMap(value);
}

export function normalizePluginConfig(value: unknown): GitHubSyncPluginConfig {
  if (!isPlainRecord(value)) {
    return {};
  }

  const record = { ...value };
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
  patch: GitHubSyncPluginConfigPatch
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
