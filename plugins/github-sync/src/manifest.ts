import type { PaperclipPluginManifestV1 } from '@paperclipai/plugin-sdk';

const DASHBOARD_WIDGET_CAPABILITY = 'ui.dashboardWidget.register' as unknown as PaperclipPluginManifestV1['capabilities'][number];
const SCHEDULE_TICK_CRON = '* * * * *';

export const manifest: PaperclipPluginManifestV1 = {
  id: 'github-sync',
  apiVersion: 1,
  version: '0.1.2',
  displayName: 'GitHub Sync',
  description: 'Synchronize GitHub issues into Paperclip projects.',
  author: 'Álvaro Sánchez-Mariscal',
  categories: ['workspace'],
  capabilities: [
    'ui.page.register',
    DASHBOARD_WIDGET_CAPABILITY,
    'ui.detailTab.register',
    'ui.commentAnnotation.register',
    'ui.action.register',
    'plugin.state.read',
    'plugin.state.write',
    'instance.settings.register',
    'issues.read',
    'issues.create',
    'issues.update',
    'issue.comments.read',
    'issue.comments.create',
    'jobs.schedule',
    'http.outbound',
    'secrets.read-ref'
  ],
  instanceConfigSchema: {
    type: 'object',
    properties: {
      githubTokenRef: {
        type: 'string',
        title: 'GitHub Token Secret',
        format: 'secret-ref'
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
  entrypoints: {
    worker: './dist/worker.js',
    ui: './dist/ui/'
  },
  ui: {
    slots: [
      {
        type: 'dashboardWidget',
        id: 'github-sync-dashboard-widget',
        displayName: 'GitHub Sync',
        exportName: 'GitHubSyncDashboardWidget'
      },
      {
        type: 'detailTab',
        id: 'github-sync-issue-detail-tab',
        displayName: 'GitHub',
        exportName: 'GitHubSyncIssueDetailTab',
        entityTypes: ['issue']
      },
      {
        type: 'commentAnnotation',
        id: 'github-sync-comment-annotation',
        displayName: 'GitHub Sync Links',
        exportName: 'GitHubSyncCommentAnnotation',
        entityTypes: ['comment']
      },
      {
        type: 'globalToolbarButton',
        id: 'github-sync-global-toolbar-button',
        displayName: 'GitHub Sync',
        exportName: 'GitHubSyncGlobalToolbarButton'
      },
      {
        type: 'toolbarButton',
        id: 'github-sync-toolbar-button',
        displayName: 'GitHub Sync',
        exportName: 'GitHubSyncEntityToolbarButton',
        entityTypes: ['project', 'issue']
      },
      {
        type: 'settingsPage',
        id: 'github-sync-settings-page',
        displayName: 'GitHub Sync',
        exportName: 'GitHubSyncSettingsPage'
      }
    ]
  }
};

export default manifest;
