export interface GitHubSyncAssigneeOption {
  kind: 'agent' | 'user';
  id: string;
  name: string;
  title?: string;
  status?: string;
}

export function normalizeCompanyAssigneeOptionsResponse(response: unknown): GitHubSyncAssigneeOption[] {
  if (!Array.isArray(response)) {
    throw new Error('Unexpected company agents response: expected an array.');
  }

  return response
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const record = entry as Record<string, unknown>;
      const kind = record.kind === 'user' ? 'user' : 'agent';
      const id = typeof record.id === 'string' ? record.id.trim() : '';
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      const status = typeof record.status === 'string' ? record.status.trim() : '';
      const title = typeof record.title === 'string' ? record.title.trim() : '';

      if (!id || !name || status === 'terminated') {
        return null;
      }

      return {
        kind,
        id,
        name,
        ...(title ? { title } : {}),
        ...(status ? { status } : {})
      };
    })
    .filter((entry): entry is GitHubSyncAssigneeOption => entry !== null)
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'user' ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
}
