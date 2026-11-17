import React, { useEffect, useState } from 'react';
import { useHostContext, usePluginAction, usePluginData } from '@paperclipai/plugin-sdk/ui';

interface DashboardVisibility {
  companyId: string;
  visible: boolean;
}

const VISIBILITY_CHANGED_EVENT = 'paperclip-github-plugin:dashboard-visibility-changed';

function useDashboardVisibility() {
  const { companyId } = useHostContext();
  const query = usePluginData<DashboardVisibility>('ui.dashboardVisibility', { companyId });
  useEffect(() => {
    const refresh = () => query.refresh();
    window.addEventListener(VISIBILITY_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(VISIBILITY_CHANGED_EVENT, refresh);
  }, [query.refresh]);
  // A host may retain the previous response while changing company. Never apply it to the next one.
  const current = query.data?.companyId === companyId ? query.data : undefined;
  return { companyId, query, current };
}

export function GitHubCompanyDashboardSurface({ children, hideCardFrame = false }: {
  children: React.ReactNode;
  hideCardFrame?: boolean;
}): React.JSX.Element {
  const { companyId, query, current } = useDashboardVisibility();
  const hidden = Boolean(companyId && (current ? !current.visible : !query.error));
  return (
    <div
      className="ghsync-company-dashboard-surface"
      data-hide-card-frame={hideCardFrame}
      hidden={hidden}
      style={{ display: hidden ? 'none' : 'contents' }}
    >
      {/* Paperclip owns the immediate card wrapper. Hide that entire grid item as well as our content.
          Scope this compatibility rule to our marker, without depending on host class names. */}
      <style>{'div:has(> .ghsync-company-dashboard-surface[data-hide-card-frame="true"][hidden]) { display: none !important; }'}</style>
      {hidden ? null : children}
    </div>
  );
}

export function GitHubDashboardVisibilitySettings(): React.JSX.Element {
  const { companyId, query, current } = useDashboardVisibility();
  const save = usePluginAction('ui.setDashboardVisibility');
  const [saving, setSaving] = useState(false);
  const [draftVisible, setDraftVisible] = useState<boolean | null>(null);
  useEffect(() => {
    if (current?.visible === draftVisible) setDraftVisible(null);
  }, [current?.visible, draftVisible]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setError(null); }, [companyId]);

  async function changeVisibility(visible: boolean) {
    setSaving(true);
    setDraftVisible(visible);
    setError(null);
    try {
      await save({ companyId, visible });
      window.dispatchEvent(new Event(VISIBILITY_CHANGED_EVENT));
    } catch (cause) {
      setDraftVisible(null);
      setError(cause instanceof Error ? cause.message : 'Unable to save dashboard visibility.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="ghsync__section">
      <h4>Dashboard visibility</h4>
      <p>
        Hide GitHub dashboard cards and the global sync button for this company. Settings remain available;
        credentials, repository mappings, and automatic sync are unchanged.
      </p>
      <label>
        <input
          type="checkbox"
          checked={draftVisible ?? current?.visible ?? true}
          disabled={!companyId || !current || saving}
          onChange={(event) => { void changeVisibility(event.target.checked); }}
        />
        {' '}Show GitHub on this company’s dashboard
      </label>
      {!companyId ? <p>Select a company to change its dashboard visibility.</p> : null}
      {query.error ? <p role="alert">Unable to load dashboard visibility: {query.error.message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
