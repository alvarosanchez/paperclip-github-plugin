import type { PluginToolDeclaration } from '@paperclipai/plugin-sdk';

const repositoryProperty = {
  type: 'string',
  description: 'GitHub repository as owner/repo or https://github.com/owner/repo. Omit when the current Paperclip project has exactly one mapped repository.'
} as const;

const organizationProperty = {
  type: 'string',
  description: 'GitHub organization login that owns the Projects.'
} as const;

const paperclipIssueIdProperty = {
  type: 'string',
  description: 'Paperclip issue id used to infer the linked GitHub issue and repository when available.'
} as const;

const issueNumberProperty = {
  type: 'integer',
  minimum: 1,
  description: 'GitHub issue number.'
} as const;

const pullRequestNumberProperty = {
  type: 'integer',
  minimum: 1,
  description: 'GitHub pull request number.'
} as const;

const projectIdProperty = {
  type: 'string',
  description: 'GitHub ProjectV2 node id. You can use the id returned by list_organization_projects.'
} as const;

const projectNumberProperty = {
  type: 'integer',
  minimum: 1,
  description: 'GitHub organization project number. Requires organization when projectId is not provided.'
} as const;

const llmModelProperty = {
  type: 'string',
  description: 'Exact LLM name used to draft the GitHub content. When provided, the plugin includes it in the mandatory AI-authorship footer.'
} as const;

const issueTargetSchema = {
  anyOf: [
    {
      required: ['paperclipIssueId']
    },
    {
      required: ['issueNumber']
    }
  ]
} as const;

const pullRequestTargetSchema = {
  anyOf: [
    {
      required: ['paperclipIssueId']
    },
    {
      required: ['pullRequestNumber']
    }
  ]
} as const;

const organizationProjectTargetSchema = {
  anyOf: [
    {
      required: ['projectId']
    },
    {
      required: ['organization', 'projectNumber']
    }
  ]
} as const;

export const GITHUB_AGENT_TOOLS: PluginToolDeclaration[] = [
  {
    name: 'search_repository_items',
    displayName: 'Search Repository Items',
    description: 'Search issues and pull requests in a GitHub repository for triage and deduplication.',
    parametersSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        repository: repositoryProperty,
        query: {
          type: 'string',
          description: 'Free-text search query.'
        },
        type: {
          type: 'string',
          enum: ['issue', 'pull_request', 'all'],
          description: 'Which item type to search.'
        },
        state: {
          type: 'string',
          enum: ['open', 'closed', 'all'],
          description: 'State filter.'
        },
        author: {
          type: 'string',
          description: 'GitHub login that authored the item.'
        },
        assignee: {
          type: 'string',
          description: 'GitHub login assigned to the item.'
        },
        labels: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'Label names that must be present on the item.'
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Maximum number of results to return.'
        }
      }
    }
  },
  {
    name: 'get_issue',
    displayName: 'Get Issue',
    description: 'Read one GitHub issue with its metadata, assignees, labels, milestone, and linked pull requests.',
    parametersSchema: {
      type: 'object',
      additionalProperties: false,
      ...issueTargetSchema,
      properties: {
        repository: repositoryProperty,
        issueNumber: issueNumberProperty,
        paperclipIssueId: paperclipIssueIdProperty
      }
    }
  },
  {
    name: 'list_issue_comments',
    displayName: 'List Issue Comments',
    description: 'Read all comments on a GitHub issue so the agent has the full implementation context.',
    parametersSchema: {
      type: 'object',
      additionalProperties: false,
      ...issueTargetSchema,
      properties: {
        repository: repositoryProperty,
        issueNumber: issueNumberProperty,
        paperclipIssueId: paperclipIssueIdProperty
      }
    }
  },
  {
    name: 'update_issue',
    displayName: 'Update Issue',
    description: 'Update GitHub issue fields such as title, body, state, labels, assignees, or milestone. When body is provided, the plugin appends an AI-authorship footer and includes llmModel when supplied.',
    parametersSchema: {
      type: 'object',
      additionalProperties: false,
      ...issueTargetSchema,
      properties: {
        repository: repositoryProperty,
        issueNumber: issueNumberProperty,
        paperclipIssueId: paperclipIssueIdProperty,
        title: {
          type: 'string'
        },
        body: {
          type: 'string'
        },
        llmModel: llmModelProperty,
        state: {
          type: 'string',
          enum: ['open', 'closed']
        },
        setLabels: {
          type: 'array',
          items: {
            type: 'string'
          }
        },
        addLabels: {
          type: 'array',
          items: {
            type: 'string'
          }
        },
        removeLabels: {
          type: 'array',
          items: {
            type: 'string'
          }
        },
        setAssignees: {
          type: 'array',
          items: {
            type: 'string'
          }
        },
        addAssignees: {
          type: 'array',
          items: {
            type: 'string'
          }
        },
        removeAssignees: {
          type: 'array',
          items: {
            type: 'string'
          }
        },
        milestoneNumber: {
          type: ['integer', 'null'],
          minimum: 1,
          description: 'Milestone number to set, or null to clear the milestone.'
        }
      }
    }
  },
  {
    name: 'add_issue_comment',
    displayName: 'Add Issue Comment',
    description: 'Post a comment on a GitHub issue or pull request. Provide only the human-facing message body; the plugin appends the required AI-authorship footer and includes llmModel when supplied.',
    parametersSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['body'],
      ...issueTargetSchema,
      properties: {
        repository: repositoryProperty,
        issueNumber: issueNumberProperty,
        paperclipIssueId: paperclipIssueIdProperty,
        body: {
          type: 'string',
          description: 'Human-facing comment body without the AI footer.'
        },
        llmModel: llmModelProperty
      }
    }
  },
  {
    name: 'create_pull_request',
    displayName: 'Create Pull Request',
    description: 'Open a GitHub pull request once the implementation branch is pushed. When body is provided, the plugin appends an AI-authorship footer and includes llmModel when supplied.',
    parametersSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['head', 'base', 'title'],
      properties: {
        repository: repositoryProperty,
        head: {
          type: 'string',
          description: 'Head branch name or owner:branch.'
        },
        base: {
          type: 'string',
          description: 'Base branch name.'
        },
        title: {
          type: 'string'
        },
        body: {
          type: 'string'
        },
        llmModel: llmModelProperty,
        draft: {
          type: 'boolean'
        }
      }
    }
  },
  {
    name: 'get_pull_request',
    displayName: 'Get Pull Request',
    description: 'Read one pull request with branch metadata, review summary, and merge readiness.',
    parametersSchema: {
      type: 'object',
      additionalProperties: false,
      ...pullRequestTargetSchema,
      properties: {
        repository: repositoryProperty,
        pullRequestNumber: pullRequestNumberProperty,
        paperclipIssueId: paperclipIssueIdProperty
      }
    }
  },
  {
    name: 'update_pull_request',
    displayName: 'Update Pull Request',
    description: 'Edit pull request title, body, base branch, open or close it, or convert between draft and ready for review. When body is provided, the plugin appends an AI-authorship footer and includes llmModel when supplied.',
    parametersSchema: {
      type: 'object',
      additionalProperties: false,
      ...pullRequestTargetSchema,
      properties: {
        repository: repositoryProperty,
        pullRequestNumber: pullRequestNumberProperty,
        paperclipIssueId: paperclipIssueIdProperty,
        title: {
          type: 'string'
        },
        body: {
          type: 'string'
        },
        llmModel: llmModelProperty,
        base: {
          type: 'string'
        },
        state: {
          type: 'string',
          enum: ['open', 'closed']
        },
        isDraft: {
          type: 'boolean',
          description: 'True converts the pull request to draft. False marks it ready for review.'
        }
      }
    }
  },
  {
    name: 'list_pull_request_files',
    displayName: 'List Pull Request Files',
    description: 'List the changed files in a pull request, including additions, deletions, and patches when available.',
    parametersSchema: {
      type: 'object',
      additionalProperties: false,
      ...pullRequestTargetSchema,
      properties: {
        repository: repositoryProperty,
        pullRequestNumber: pullRequestNumberProperty,
        paperclipIssueId: paperclipIssueIdProperty
      }
    }
  },
  {
    name: 'get_pull_request_checks',
    displayName: 'Get Pull Request Checks',
    description: 'Read CI status for a pull request, including workflow runs, check runs, and commit status contexts.',
    parametersSchema: {
      type: 'object',
      additionalProperties: false,
      ...pullRequestTargetSchema,
      properties: {
        repository: repositoryProperty,
        pullRequestNumber: pullRequestNumberProperty,
        paperclipIssueId: paperclipIssueIdProperty
      }
    }
  },
  {
    name: 'list_pull_request_review_threads',
    displayName: 'List Pull Request Review Threads',
    description: 'Read review threads on a pull request, including file paths, comments, and resolution state.',
    parametersSchema: {
      type: 'object',
      additionalProperties: false,
      ...pullRequestTargetSchema,
      properties: {
        repository: repositoryProperty,
        pullRequestNumber: pullRequestNumberProperty,
        paperclipIssueId: paperclipIssueIdProperty
      }
    }
  },
  {
    name: 'reply_to_review_thread',
    displayName: 'Reply To Review Thread',
    description: 'Reply to an existing pull request review thread. Provide only the human-facing body; the plugin appends the required AI-authorship footer and includes llmModel when supplied.',
    parametersSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['threadId', 'body'],
      properties: {
        threadId: {
          type: 'string',
          description: 'GitHub pull request review thread node id.'
        },
        body: {
          type: 'string',
          description: 'Human-facing reply body without the AI footer.'
        },
        llmModel: llmModelProperty
      }
    }
  },
  {
    name: 'resolve_review_thread',
    displayName: 'Resolve Review Thread',
    description: 'Mark a pull request review thread as resolved after addressing the feedback.',
    parametersSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['threadId'],
      properties: {
        threadId: {
          type: 'string',
          description: 'GitHub pull request review thread node id.'
        }
      }
    }
  },
  {
    name: 'unresolve_review_thread',
    displayName: 'Unresolve Review Thread',
    description: 'Reopen a previously resolved pull request review thread.',
    parametersSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['threadId'],
      properties: {
        threadId: {
          type: 'string',
          description: 'GitHub pull request review thread node id.'
        }
      }
    }
  },
  {
    name: 'request_pull_request_reviewers',
    displayName: 'Request Pull Request Reviewers',
    description: 'Request users or teams to review a pull request.',
    parametersSchema: {
      type: 'object',
      additionalProperties: false,
      ...pullRequestTargetSchema,
      properties: {
        repository: repositoryProperty,
        pullRequestNumber: pullRequestNumberProperty,
        paperclipIssueId: paperclipIssueIdProperty,
        userReviewers: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'string'
          }
        },
        teamReviewers: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'string'
          }
        }
      },
      anyOf: [
        {
          required: ['paperclipIssueId', 'userReviewers']
        },
        {
          required: ['paperclipIssueId', 'teamReviewers']
        },
        {
          required: ['pullRequestNumber', 'userReviewers']
        },
        {
          required: ['pullRequestNumber', 'teamReviewers']
        }
      ]
    }
  },
  {
    name: 'list_organization_projects',
    displayName: 'List Organization Projects',
    description: 'Search or list GitHub organization-level Projects so an agent can choose where to associate pull requests.',
    parametersSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['organization'],
      properties: {
        organization: organizationProperty,
        includeClosed: {
          type: 'boolean',
          description: 'Include closed Projects in the results. Defaults to false.'
        },
        query: {
          type: 'string',
          description: 'Optional free-text filter matched against project titles and descriptions after loading the organization projects.'
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of projects to return.'
        }
      }
    }
  },
  {
    name: 'add_pull_request_to_project',
    displayName: 'Add Pull Request To Project',
    description: 'Associate a GitHub pull request with an organization-level GitHub Project.',
    parametersSchema: {
      type: 'object',
      additionalProperties: false,
      allOf: [pullRequestTargetSchema, organizationProjectTargetSchema],
      properties: {
        repository: repositoryProperty,
        pullRequestNumber: pullRequestNumberProperty,
        paperclipIssueId: paperclipIssueIdProperty,
        projectId: projectIdProperty,
        organization: organizationProperty,
        projectNumber: projectNumberProperty
      }
    }
  }
];

export function getGitHubAgentToolDeclaration(name: string): PluginToolDeclaration {
  const declaration = GITHUB_AGENT_TOOLS.find((entry) => entry.name === name);
  if (!declaration) {
    throw new Error(`Unknown GitHub agent tool declaration: ${name}`);
  }

  return declaration;
}
