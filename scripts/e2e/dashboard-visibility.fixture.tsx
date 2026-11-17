// Real exported plugin UI, mounted in Paperclip's React slot wrapper shape.
// Only the host bridge transport is supplied by the isolated test.
import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GitHubSyncDashboardWidget, GitHubSyncKpiDashboardWidget, GitHubSyncGlobalToolbarButton } from '../../dist/ui/index.js';
import { GitHubDashboardVisibilitySettings } from '../../src/ui/dashboard-visibility.tsx';

let companyId = 'marketing';
const subscribers = new Set<() => void>();
function useCompany() {
  const [, render] = useState(0);
  useEffect(() => {
    const update = () => render((value) => value + 1);
    subscribers.add(update);
    return () => { subscribers.delete(update); };
  }, []);
  return companyId;
}
let staleVisibility = null;
let visibilityError = false;
globalThis.__paperclipPluginBridge__ = { sdkUi: {
  useHostContext() { return { companyId: useCompany(), companyPrefix: 'TEST' }; },
  usePluginToast() { return () => {}; },
  usePluginData(key, params) {
    const request = JSON.stringify(params);
    const [state, setState] = useState({ data: undefined, loading: true, error: null });
    const refresh = useCallback(async () => {
      if (key === 'ui.dashboardVisibility' && staleVisibility) {
        setState({ data: staleVisibility, loading: true, error: null });
        return;
      }
      try {
        if (key === 'ui.dashboardVisibility' && visibilityError) throw new Error('Visibility read failed');
        const data = await window.pluginRead(key, JSON.parse(request));
        setState({ data, loading: false, error: null });
      } catch (error) {
        setState({ data: undefined, loading: false, error });
      }
    }, [key, request]);
    useEffect(() => { void refresh(); }, [refresh]);
    return { ...state, refresh };
  },
  usePluginAction(key) {
    return async (params) => {
      if (key === 'ui.setDashboardVisibility' && window.failNextVisibilitySave) {
        window.failNextVisibilitySave = false;
        throw new Error('Visibility save failed');
      }
      return window.pluginAction(key, params);
    };
  }
} };

function App() {
  const selected = useCompany();
  return <>
    <button onClick={() => { companyId = companyId === 'marketing' ? 'platform' : 'marketing'; subscribers.forEach((update) => update()); }}>Switch company</button>
    <span id="company">{selected}</span>
    <div id="toolbar"><GitHubSyncGlobalToolbarButton /><button>Other toolbar action</button></div>
    <div id="widgets" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      <div id="sync-card" style={{ border: '1px solid gray', padding: 16 }}><GitHubSyncDashboardWidget /></div>
      <div id="kpi-card" style={{ border: '1px solid gray', padding: 16 }}><GitHubSyncKpiDashboardWidget /></div>
      <div id="other-card">Another plugin stays visible</div>
    </div>
    <GitHubDashboardVisibilitySettings key={selected} />
  </>;
}
window.setVisibilityFault = (stale, error = false) => {
  staleVisibility = stale;
  visibilityError = error;
  window.dispatchEvent(new Event('paperclip-github-plugin:dashboard-visibility-changed'));
};
createRoot(document.getElementById('root')).render(<App />);
