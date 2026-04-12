import { parseRepositoryReference } from '../github-repo.ts';

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
  const discoveredCandidates = new Map<string, ExistingProjectSyncCandidate>();

  for (const project of params.projects) {
    const projectId = project.id.trim();
    const projectName = project.name.trim();
    if (!projectId || !projectName) {
      continue;
    }

    const workspaces = params.workspacesByProjectId[projectId] ?? [];
    for (const workspace of workspaces) {
      const parsedRepository = parseRepositoryReference(workspace.repoUrl ?? '');
      if (!parsedRepository) {
        continue;
      }

      const repositoryUrl = parsedRepository.url;
      const candidateKey = `${projectId}:${repositoryUrl}`;
      const sourceType =
        typeof workspace.sourceType === 'string' && workspace.sourceType.trim()
          ? workspace.sourceType.trim()
          : undefined;
      const isPrimary = workspace.isPrimary === true;
      const existingCandidate = discoveredCandidates.get(candidateKey);
      if (existingCandidate) {
        discoveredCandidates.set(candidateKey, {
          ...existingCandidate,
          sourceType: existingCandidate.sourceType ?? sourceType,
          isPrimary: existingCandidate.isPrimary || isPrimary
        });
        continue;
      }

      discoveredCandidates.set(candidateKey, {
        projectId,
        projectName,
        repositoryUrl,
        sourceType,
        isPrimary
      });
    }
  }

  return [...discoveredCandidates.values()].sort(compareByProjectName);
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
      .map((mapping) => parseRepositoryReference(mapping.repositoryUrl)?.url)
      .filter((value): value is string => Boolean(value))
  );

  return candidates.filter((candidate) =>
    !mappedProjectIds.has(candidate.projectId) && !mappedRepositoryUrls.has(candidate.repositoryUrl)
  );
}
