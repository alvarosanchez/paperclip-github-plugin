export interface PaperclipHealthResponse {
  deploymentMode?: string;
  deploymentExposure?: string;
  authReady?: boolean;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizePaperclipHealthResponse(value: unknown): PaperclipHealthResponse | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const deploymentMode = normalizeOptionalString(record.deploymentMode);
  const deploymentExposure = normalizeOptionalString(record.deploymentExposure);
  const authReady = typeof record.authReady === 'boolean' ? record.authReady : undefined;

  if (!deploymentMode && !deploymentExposure && authReady === undefined) {
    return null;
  }

  return {
    ...(deploymentMode ? { deploymentMode } : {}),
    ...(deploymentExposure ? { deploymentExposure } : {}),
    ...(authReady !== undefined ? { authReady } : {})
  };
}

export function requiresPaperclipBoardAccess(value: unknown): boolean {
  const health = normalizePaperclipHealthResponse(value);
  return health?.deploymentMode?.toLowerCase() === 'authenticated';
}

export function shouldShowPaperclipBoardAccessSettings(value: unknown): boolean {
  const health = normalizePaperclipHealthResponse(value);
  const deploymentMode = health?.deploymentMode?.toLowerCase();
  return deploymentMode === 'authenticated' || deploymentMode === 'local_trusted';
}
