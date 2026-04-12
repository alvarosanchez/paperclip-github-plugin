export interface RepositoryMappingSnapshot {
  repositoryUrl: string;
  paperclipProjectId?: string;
}

export interface CompanyProjectSummary {
  id: string;
  name: string;
}

export interface ProjectWorkspaceSummary {
  repoUrl?: string | null;
  sourceType?: string | null;
  isPrimary?: boolean | null;
}

export interface ExistingProjectSyncCandidate {
  projectId: string;
  projectName: string;
  repositoryUrl: string;
  sourceType?: string;
  isPrimary: boolean;
}

function parseGitHubRepositoryReference(repositoryInput: string): string | null {
  const trimmed = repositoryInput.trim();
  if (!trimmed) {
    return null;
  }

  const slugMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (slugMatch) {
    const [, owner, repo] = slugMatch;
    return `https://github.com/${owner}/${repo}`;
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
      return null;
    }

    const pathSegments = url.pathname.split('/').filter(Boolean);
    if (pathSegments.length !== 2) {
      return null;
    }

    const [owner, rawRepo] = pathSegments;
    const repo = rawRepo.replace(/\.git$/, '');
    if (!owner || !repo) {
      return null;
    }

    return `https://github.com/${owner}/${repo}`;
  } catch {
    return null;
  }
}

function compareByProjectName(left: ExistingProjectSyncCandidate, right: ExistingProjectSyncCandidate): number {
  const projectNameComparison = left.projectName.localeCompare(right.projectName, undefined, { sensitivity: 'base' });
  if (projectNameComparison !== 0) {
    return projectNameComparison;
  }

  return left.repositoryUrl.localeCompare(right.repositoryUrl, undefined, { sensitivity: 'base' });
}

export function discoverExistingProjectSyncCandidates(params: {
  projects: CompanyProjectSummary[];
  workspacesByProjectId: Record<string, ProjectWorkspaceSummary[] | undefined>;
}): ExistingProjectSyncCandidate[] {
  const discoveredCandidates: ExistingProjectSyncCandidate[] = [];
  const seenCandidates = new Set<string>();

  for (const project of params.projects) {
    const projectId = project.id.trim();
    const projectName = project.name.trim();
    if (!projectId || !projectName) {
      continue;
    }

    const workspaces = params.workspacesByProjectId[projectId] ?? [];
    for (const workspace of workspaces) {
      const repositoryUrl = parseGitHubRepositoryReference(workspace.repoUrl ?? '');
      if (!repositoryUrl) {
        continue;
      }

      const candidateKey = `${projectId}:${repositoryUrl}`;
      if (seenCandidates.has(candidateKey)) {
        continue;
      }
      seenCandidates.add(candidateKey);

      discoveredCandidates.push({
        projectId,
        projectName,
        repositoryUrl,
        sourceType: typeof workspace.sourceType === 'string' && workspace.sourceType.trim()
          ? workspace.sourceType.trim()
          : undefined,
        isPrimary: workspace.isPrimary === true
      });
    }
  }

  return discoveredCandidates.sort(compareByProjectName);
}

export function filterExistingProjectSyncCandidates(
  candidates: ExistingProjectSyncCandidate[],
  mappings: RepositoryMappingSnapshot[]
): ExistingProjectSyncCandidate[] {
  const mappedProjectIds = new Set(
    mappings
      .map((mapping) => mapping.paperclipProjectId?.trim())
      .filter((value): value is string => Boolean(value))
  );
  const mappedRepositoryUrls = new Set(
    mappings
      .map((mapping) => parseGitHubRepositoryReference(mapping.repositoryUrl))
      .filter((value): value is string => Boolean(value))
  );

  return candidates.filter((candidate) =>
    !mappedProjectIds.has(candidate.projectId) && !mappedRepositoryUrls.has(candidate.repositoryUrl)
  );
}
