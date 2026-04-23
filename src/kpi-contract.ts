export const GITHUB_SYNC_PLUGIN_ID = 'paperclip-github-plugin';
export const COMPANY_METRIC_WEBHOOK_ENDPOINT_KEY = 'record-company-metric-event';
export const COMPANY_METRIC_WEBHOOK_PATH =
  `/api/plugins/${GITHUB_SYNC_PLUGIN_ID}/webhooks/${COMPANY_METRIC_WEBHOOK_ENDPOINT_KEY}`;
export const COMPANY_METRIC_WEBHOOK_AUTH_HEADER = 'authorization';

export type CompanyMetricWebhookMetric = 'pull_request_created';
