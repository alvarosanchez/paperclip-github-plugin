export const GITHUB_SYNC_PLUGIN_ID = 'paperclip-github-plugin';
export const COMPANY_METRIC_API_ROUTE_KEY = 'record-company-metric-event';
export const COMPANY_METRIC_API_ROUTE_PATH = '/company-metrics/events';
export const COMPANY_METRIC_API_ROUTE_URL_PATH =
  `/api/plugins/${GITHUB_SYNC_PLUGIN_ID}/api${COMPANY_METRIC_API_ROUTE_PATH}`;

export type CompanyMetricApiRouteMetric = 'pull_request_created';
