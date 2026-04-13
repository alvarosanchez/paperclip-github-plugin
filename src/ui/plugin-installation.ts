const SETTINGS_INDEX_HREF = '/instance/settings/plugins';
const GITHUB_SYNC_PLUGIN_KEY = 'paperclip-github-plugin';
const GITHUB_SYNC_PLUGIN_DISPLAY_NAME = 'GitHub Sync';

function getStringValue(record: Record<string, unknown> | null, key: string): string | null {
  if (!record) {
    return null;
  }

  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function resolveGitHubSyncPluginRecord(records: unknown): Record<string, unknown> | null {
  if (!Array.isArray(records)) {
    return null;
  }

  for (const entry of records) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const manifest = record.manifest && typeof record.manifest === 'object' ? record.manifest as Record<string, unknown> : null;
    const key =
      getStringValue(record, 'pluginKey')
      ?? getStringValue(record, 'key')
      ?? getStringValue(record, 'packageName')
      ?? getStringValue(record, 'name')
      ?? getStringValue(manifest, 'id');
    const displayName =
      getStringValue(record, 'displayName')
      ?? getStringValue(manifest, 'displayName');
    const id =
      getStringValue(record, 'id')
      ?? getStringValue(record, 'pluginId');

    if (id && (key === GITHUB_SYNC_PLUGIN_KEY || displayName === GITHUB_SYNC_PLUGIN_DISPLAY_NAME)) {
      return record;
    }
  }

  return null;
}

export function resolveInstalledGitHubSyncPluginId(
  records: unknown,
  preferredPluginId?: string | null
): string | null {
  if (typeof preferredPluginId === 'string' && preferredPluginId.trim()) {
    return preferredPluginId.trim();
  }

  const record = resolveGitHubSyncPluginRecord(records);
  return getStringValue(record, 'id') ?? getStringValue(record, 'pluginId');
}

export function resolvePluginSettingsHref(records: unknown): string {
  const pluginId = resolveInstalledGitHubSyncPluginId(records);
  return pluginId ? `${SETTINGS_INDEX_HREF}/${pluginId}` : SETTINGS_INDEX_HREF;
}
