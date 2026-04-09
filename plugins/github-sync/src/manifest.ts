import type { PaperclipPluginManifestV1 } from '@paperclipai/plugin-sdk';

const DASHBOARD_WIDGET_CAPABILITY = 'ui.dashboardWidget.register' as unknown as PaperclipPluginManifestV1['capabilities'][number];

export const manifest: PaperclipPluginManifestV1 = {
  id: 'github-sync',
  apiVersion: 1,
  version: '0.1.0',
  displayName: 'GitHub Sync',
  description: 'Synchronize GitHub issues into Paperclip projects.',
  author: 'Álvaro Sánchez-Mariscal',
  categories: ['workspace'],
  capabilities: [
    'ui.page.register',
    DASHBOARD_WIDGET_CAPABILITY,
    'plugin.state.read',
    'plugin.state.write',
    'instance.settings.register',
    'issues.create',
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
      description: 'Imports GitHub repository issues into Paperclip.',
      schedule: '*/15 * * * *'
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
        type: 'settingsPage',
        id: 'github-sync-settings-page',
        displayName: 'GitHub Sync',
        exportName: 'GitHubSyncSettingsPage'
      }
    ]
  }
};

export default manifest;
