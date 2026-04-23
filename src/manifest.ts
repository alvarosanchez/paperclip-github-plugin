import { createRequire } from 'node:module';
import type { PaperclipPluginManifestV1 } from '@paperclipai/plugin-sdk';

import { GITHUB_AGENT_TOOLS } from './github-agent-tools.ts';
import { COMPANY_METRIC_WEBHOOK_ENDPOINT_KEY, GITHUB_SYNC_PLUGIN_ID } from './kpi-contract.ts';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version?: unknown };
const DASHBOARD_WIDGET_CAPABILITY = 'ui.dashboardWidget.register' as unknown as PaperclipPluginManifestV1['capabilities'][number];
const SCHEDULE_TICK_CRON = '* * * * *';
const MANIFEST_VERSION =
  process.env.PLUGIN_VERSION?.trim()
  || (typeof packageJson.version === 'string' && packageJson.version.trim())
  || process.env.npm_package_version?.trim()
  || '0.0.0-dev';

export const manifest: PaperclipPluginManifestV1 = {
  id: GITHUB_SYNC_PLUGIN_ID,
  apiVersion: 1,
  version: MANIFEST_VERSION,
  displayName: 'GitHub Sync',
  description: 'Synchronize GitHub issues into Paperclip projects.',
  author: 'Álvaro Sánchez-Mariscal',
  categories: ['connector', 'ui'],
  capabilities: [
    'ui.sidebar.register',
    'ui.page.register',
    DASHBOARD_WIDGET_CAPABILITY,
    'ui.detailTab.register',
    'ui.commentAnnotation.register',
    'ui.action.register',
    'plugin.state.read',
    'plugin.state.write',
    'instance.settings.register',
    'projects.read',
    'issues.read',
    'issues.create',
    'issues.update',
    'issue.comments.read',
    'issue.comments.create',
    'agents.read',
    'jobs.schedule',
    'webhooks.receive',
    'http.outbound',
    'secrets.read-ref',
    'agent.tools.register'
  ],
  instanceConfigSchema: {
    type: 'object',
    properties: {
      githubTokenRefs: {
        type: 'object',
        title: 'GitHub Token Secrets',
        additionalProperties: {
          type: 'string'
        }
      },
      paperclipBoardApiTokenRefs: {
        type: 'object',
        title: 'Paperclip Board Token Secrets',
        additionalProperties: {
          type: 'string'
        }
      },
      paperclipApiBaseUrl: {
        type: 'string',
        title: 'Trusted Paperclip API Origin'
      }
    }
  },
  jobs: [
    {
      jobKey: 'sync.github-issues',
      displayName: 'Sync GitHub issues',
      description: 'Checks for GitHub issue updates and syncs them on the configured cadence.',
      schedule: SCHEDULE_TICK_CRON
    }
  ],
  webhooks: [
    {
      endpointKey: COMPANY_METRIC_WEBHOOK_ENDPOINT_KEY,
      displayName: 'Record Company KPI Event',
      description: 'Record Paperclip-attributed pull request activity from agent flows that use gh or other non-plugin GitHub clients.'
    }
  ],
  tools: GITHUB_AGENT_TOOLS,
  entrypoints: {
    worker: './dist/worker.js',
    ui: './dist/ui/'
  },
  ui: {
    slots: [
      {
        type: 'page',
        id: 'paperclip-github-plugin-project-pull-requests-page',
        displayName: 'Pull Requests',
        exportName: 'GitHubSyncProjectPullRequestsPage',
        routePath: 'github-pull-requests'
      },
      {
        type: 'projectSidebarItem',
        id: 'paperclip-github-plugin-project-pull-requests-sidebar-item',
        displayName: 'Pull Requests',
        exportName: 'GitHubSyncProjectPullRequestsSidebarItem',
        entityTypes: ['project'],
        order: 40
      },
      {
        type: 'dashboardWidget',
        id: 'paperclip-github-plugin-dashboard-widget',
        displayName: 'GitHub Sync',
        exportName: 'GitHubSyncDashboardWidget'
      },
      {
        type: 'dashboardWidget',
        id: 'paperclip-github-plugin-kpi-dashboard-widget',
        displayName: 'GitHub KPIs',
        exportName: 'GitHubSyncKpiDashboardWidget'
      },
      {
        type: 'taskDetailView',
        id: 'paperclip-github-plugin-issue-detail-tab',
        displayName: 'GitHub',
        exportName: 'GitHubSyncIssueTaskDetailView',
        entityTypes: ['issue']
      },
      {
        type: 'commentAnnotation',
        id: 'paperclip-github-plugin-comment-annotation',
        displayName: 'GitHub Sync Links',
        exportName: 'GitHubSyncCommentAnnotation',
        entityTypes: ['comment']
      },
      {
        type: 'globalToolbarButton',
        id: 'paperclip-github-plugin-global-toolbar-button',
        displayName: 'GitHub Sync',
        exportName: 'GitHubSyncGlobalToolbarButton'
      },
      {
        type: 'toolbarButton',
        id: 'paperclip-github-plugin-toolbar-button',
        displayName: 'GitHub Sync',
        exportName: 'GitHubSyncEntityToolbarButton',
        entityTypes: ['project']
      },
      {
        type: 'settingsPage',
        id: 'paperclip-github-plugin-settings-page',
        displayName: 'GitHub Sync',
        exportName: 'GitHubSyncSettingsPage'
      }
    ]
  }
};

export default manifest;
