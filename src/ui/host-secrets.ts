/**
 * Company secret helpers shared by the settings page.
 *
 * GitHub Sync stores its own GitHub token as a per-company secret named
 * `github_sync_<companyId>` and references it from plugin config. Paperclip's own GitHub
 * features (managed-checkout git credentials, the merged-PR confirmation sweep, the
 * execution-workspace reaper and the built-in GitHub external-object provider) resolve a
 * company secret by *name* instead, probing `GITHUB_TOKEN`, `GH_TOKEN` and
 * `PAPERCLIP_GITHUB_TOKEN`. Operators who want both to authenticate can opt into mirroring
 * the same token under the host's canonical name.
 */

/** Secret names Paperclip probes for a company GitHub token, in host probe order. */
export const HOST_GITHUB_TOKEN_SECRET_NAMES = ['GITHUB_TOKEN', 'GH_TOKEN', 'PAPERCLIP_GITHUB_TOKEN'] as const;

/** The name GitHub Sync writes when the operator opts into host token exposure. */
export const HOST_GITHUB_TOKEN_SECRET_NAME = HOST_GITHUB_TOKEN_SECRET_NAMES[0];

export interface CompanySecretSummary {
  id: string;
  name: string;
  /** Paperclip secret lifecycle status: `active`, `disabled`, `archived` or `deleted`. */
  status?: string;
}

export interface PaperclipJsonRequest {
  url: string;
  init?: RequestInit;
}

export type PaperclipJsonFetcher = <T>(url: string, init?: RequestInit) => Promise<T>;

export function buildCompanySecretListRequest(companyId: string): PaperclipJsonRequest {
  return {
    url: `/api/companies/${encodeURIComponent(companyId)}/secrets`
  };
}

export function buildCompanySecretCreateRequest(
  companyId: string,
  name: string,
  value: string
): PaperclipJsonRequest {
  return {
    url: `/api/companies/${encodeURIComponent(companyId)}/secrets`,
    init: {
      method: 'POST',
      body: JSON.stringify({
        name,
        value
      })
    }
  };
}

export function buildCompanySecretRotateRequest(secretId: string, value: string): PaperclipJsonRequest {
  return {
    url: `/api/secrets/${encodeURIComponent(secretId)}/rotate`,
    init: {
      method: 'POST',
      body: JSON.stringify({
        value
      })
    }
  };
}

/**
 * Match an existing company secret by name.
 *
 * GitHub Sync's own secrets are created by this UI with a generated lowercase name, so matching
 * them case-insensitively avoids duplicating a row that an older release wrote with different
 * casing. The host's `GITHUB_TOKEN` probe compares names with a plain SQL equality, so that one
 * must be matched exactly: rotating a `github_token` row would leave the host probe unsatisfied.
 */
export function findCompanySecretByName(
  secrets: ReadonlyArray<CompanySecretSummary>,
  name: string,
  options: { caseSensitive?: boolean } = {}
): CompanySecretSummary | null {
  const caseSensitive = options.caseSensitive === true;
  // The host compares the stored name byte for byte, so the exact branch must not trim either
  // side: a row stored as `GITHUB_TOKEN ` is a different secret as far as the host probe is
  // concerned, and rotating it would leave the probe unsatisfied.
  const expectedName = caseSensitive ? name : name.trim().toLowerCase();
  return secrets.find((secret) => {
    if (typeof secret?.name !== 'string') {
      return false;
    }

    const candidate = caseSensitive ? secret.name : secret.name.trim().toLowerCase();
    return candidate === expectedName;
  }) ?? null;
}

export async function resolveOrCreateCompanySecret(
  fetchJson: PaperclipJsonFetcher,
  companyId: string,
  name: string,
  value: string,
  options: { caseSensitive?: boolean } = {}
): Promise<CompanySecretSummary> {
  const listRequest = buildCompanySecretListRequest(companyId);
  const existingSecrets = await fetchJson<Array<CompanySecretSummary>>(listRequest.url, listRequest.init);
  const existing = findCompanySecretByName(Array.isArray(existingSecrets) ? existingSecrets : [], name, options);

  if (existing) {
    const rotateRequest = buildCompanySecretRotateRequest(existing.id, value);
    return fetchJson<CompanySecretSummary>(rotateRequest.url, rotateRequest.init);
  }

  const createRequest = buildCompanySecretCreateRequest(companyId, name, value);
  return fetchJson<CompanySecretSummary>(createRequest.url, createRequest.init);
}

/**
 * Mirror the validated GitHub token into the company secret Paperclip's own GitHub features read.
 * Creates `GITHUB_TOKEN` when it is missing and rotates it in place when it already exists, so the
 * operator never ends up with two divergent copies.
 */
export async function exposeGitHubTokenToPaperclipHost(
  fetchJson: PaperclipJsonFetcher,
  companyId: string,
  token: string
): Promise<CompanySecretSummary> {
  const trimmedCompanyId = companyId.trim();
  if (!trimmedCompanyId) {
    throw new Error('Company context is required to expose the GitHub token to Paperclip.');
  }

  const trimmedToken = token.trim();
  if (!trimmedToken) {
    throw new Error('A GitHub token is required to expose it to Paperclip.');
  }

  const listRequest = buildCompanySecretListRequest(trimmedCompanyId);
  const existingSecrets = await fetchJson<Array<CompanySecretSummary>>(listRequest.url, listRequest.init);
  const existing = findCompanySecretByName(
    Array.isArray(existingSecrets) ? existingSecrets : [],
    HOST_GITHUB_TOKEN_SECRET_NAME,
    {
      caseSensitive: true
    }
  );

  if (existing) {
    // Paperclip refuses to rotate a non-active secret, and the host's git-credential probe
    // silently skips one, so rotating it would look like success while changing nothing.
    if (typeof existing.status === 'string' && existing.status !== 'active') {
      throw new Error(
        `The ${HOST_GITHUB_TOKEN_SECRET_NAME} company secret is ${existing.status}, not active.`
        + ' Re-activate it in Settings -> Secrets and save the token again, because Paperclip'
        + ' ignores a secret in this state.'
      );
    }

    const rotateRequest = buildCompanySecretRotateRequest(existing.id, trimmedToken);
    return fetchJson<CompanySecretSummary>(rotateRequest.url, rotateRequest.init);
  }

  const createRequest = buildCompanySecretCreateRequest(
    trimmedCompanyId,
    HOST_GITHUB_TOKEN_SECRET_NAME,
    trimmedToken
  );

  try {
    return await fetchJson<CompanySecretSummary>(createRequest.url, createRequest.init);
  } catch (error) {
    // Paperclip derives a unique secret `key` from the name, so an existing secret whose name
    // only differs in case (`github_token`) blocks creating `GITHUB_TOKEN` with a 409 that is
    // otherwise hard to act on.
    const message = error instanceof Error ? error.message : String(error);
    if (/already exists/i.test(message)) {
      throw new Error(
        `Paperclip already has a company secret that conflicts with ${HOST_GITHUB_TOKEN_SECRET_NAME}`
        + ` (${message}). Paperclip matches this name exactly, so rename or delete the conflicting`
        + ` secret, or set ${HOST_GITHUB_TOKEN_SECRET_NAME} manually in Settings -> Secrets.`,
        { cause: error }
      );
    }

    throw error;
  }
}
