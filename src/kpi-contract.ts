export const GITHUB_SYNC_PLUGIN_ID = 'paperclip-github-plugin';
export const COMPANY_METRIC_API_ROUTE_KEY = 'record-company-metric-event';
export const COMPANY_METRIC_API_ROUTE_PATH = '/company-metrics/events';
export const COMPANY_METRIC_API_ROUTE_URL_PATH =
  `/api/plugins/${GITHUB_SYNC_PLUGIN_ID}/api${COMPANY_METRIC_API_ROUTE_PATH}`;
export const ISSUE_LINK_API_ROUTE_KEY = 'link-github-item';
export const ISSUE_LINK_API_ROUTE_PATH = '/issue-link';
export const ISSUE_LINK_API_ROUTE_URL_PATH =
  `/api/plugins/${GITHUB_SYNC_PLUGIN_ID}/api${ISSUE_LINK_API_ROUTE_PATH}`;
export const PULL_REQUEST_ASSET_API_ROUTE_KEY = 'upload-pull-request-asset';
export const PULL_REQUEST_ASSET_API_ROUTE_PATH = '/pull-request-assets';
export const PULL_REQUEST_ASSET_API_ROUTE_URL_PATH =
  `/api/plugins/${GITHUB_SYNC_PLUGIN_ID}/api${PULL_REQUEST_ASSET_API_ROUTE_PATH}`;

export type CompanyMetricApiRouteMetric = 'pull_request_created';
