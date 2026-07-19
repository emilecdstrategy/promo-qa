import { FormEvent, ReactNode, useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  Gauge,
  KeyRound,
  LoaderCircle,
  LogOut,
  Menu,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Store as StoreIcon,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { api, ApiError, patch, post } from "./api";
import type {
  ActivityItem,
  OverviewData,
  RunResponse,
  Status,
  Store,
} from "./types";

type Page = "overview" | "stores" | "activity" | "manual";

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [page, setPage] = useState<Page>("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [automationEnabled, setAutomationEnabled] = useState(true);

  useEffect(() => {
    api("/session")
      .then(() => {
        setAuthenticated(true);
        return api<{ enabled: boolean }>("/settings/automation");
      })
      .then((settings) => setAutomationEnabled(settings.enabled))
      .catch(() => setAuthenticated(false));
  }, []);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 3500);
  }, []);

  if (authenticated === null) {
    return <FullScreenLoader label="Securing your workspace" />;
  }
  if (!authenticated) {
    return <Login onSuccess={() => setAuthenticated(true)} />;
  }

  const navigate = (next: Page) => {
    setPage(next);
    setMobileNav(false);
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "is-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><Zap size={18} strokeWidth={2.4} /></div>
          <div>
            <strong>Promo QA</strong>
            <span>Operations console</span>
          </div>
        </div>
        <nav className="nav-list" aria-label="Main navigation">
          <NavItem icon={<Gauge />} label="Overview" active={page === "overview"} onClick={() => navigate("overview")} />
          <NavItem icon={<StoreIcon />} label="Stores" active={page === "stores"} onClick={() => navigate("stores")} />
          <NavItem icon={<Activity />} label="Activity" active={page === "activity"} onClick={() => navigate("activity")} />
          <NavItem icon={<Play />} label="Manual QA" active={page === "manual"} onClick={() => navigate("manual")} />
        </nav>
        <div className="sidebar-footer">
          <div className={`system-mini ${automationEnabled ? "" : "paused"}`}>
            <span className={automationEnabled ? "live-dot" : "paused-dot"} />
            <div>
              <strong>{automationEnabled ? "Automation live" : "Automation paused"}</strong>
              <span>{automationEnabled ? "Runs every 10 minutes" : "Scheduled checks are off"}</span>
            </div>
          </div>
          <button
            className="nav-item logout"
            onClick={async () => {
              await post("/logout");
              setAuthenticated(false);
            }}
          >
            <LogOut /> Sign out
          </button>
        </div>
      </aside>
      {mobileNav && <button className="nav-backdrop" onClick={() => setMobileNav(false)} aria-label="Close navigation" />}

      <main className="main">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu /></button>
          <div className="topbar-copy">
            <span>ECD Digital Strategy</span>
            <strong>{pageTitle(page)}</strong>
          </div>
          <div className="topbar-status"><ShieldCheck size={16} /> Secure admin</div>
        </header>
        <div className="page">
          {page === "overview" && (
            <Overview
              onNavigate={navigate}
              automationEnabled={automationEnabled}
              onAutomationChange={setAutomationEnabled}
              notify={notify}
            />
          )}
          {page === "stores" && <Stores notify={notify} />}
          {page === "activity" && <ActivityLog />}
          {page === "manual" && <ManualRun notify={notify} />}
        </div>
      </main>
      {toast && <div className="toast"><CheckCircle2 /> {toast}</div>}
    </div>
  );
}

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await post("/login", { password });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-layout">
      <div className="login-glow" />
      <section className="login-card">
        <div className="brand login-brand">
          <div className="brand-mark"><Zap size={19} /></div>
          <div><strong>Promo QA</strong><span>Admin dashboard</span></div>
        </div>
        <div className="login-heading">
          <div className="login-icon"><KeyRound /></div>
          <h1>Welcome back</h1>
          <p>Enter your admin password to access automation controls.</p>
        </div>
        <form onSubmit={submit}>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter admin password"
              required
            />
          </label>
          {error && <div className="form-error"><AlertTriangle /> {error}</div>}
          <button className="button primary full" disabled={loading}>
            {loading ? <LoaderCircle className="spin" /> : <ArrowRight />}
            {loading ? "Signing in…" : "Open dashboard"}
          </button>
        </form>
        <p className="secure-note"><ShieldCheck /> Protected with an encrypted, expiring session</p>
      </section>
    </div>
  );
}

function Overview({
  onNavigate,
  automationEnabled,
  onAutomationChange,
  notify,
}: {
  onNavigate: (page: Page) => void;
  automationEnabled: boolean;
  onAutomationChange: (enabled: boolean) => void;
  notify: (message: string) => void;
}) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [error, setError] = useState("");
  const [savingAutomation, setSavingAutomation] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const [overview, recent] = await Promise.all([
        api<OverviewData>("/overview"),
        api<{ items: ActivityItem[] }>("/activity?limit=6"),
      ]);
      setData(overview);
      setActivity(recent.items);
      onAutomationChange(overview.automation.enabled);
    } catch (err) {
      setError(errorText(err));
    }
  }, [onAutomationChange]);

  async function toggleAutomation(next: boolean) {
    setSavingAutomation(true);
    try {
      const result = await patch<{ enabled: boolean }>("/settings/automation", {
        enabled: next,
      });
      onAutomationChange(result.enabled);
      setData((current) => current
        ? {
          ...current,
          automation: { ...current.automation, enabled: result.enabled },
          configuration: { ...current.configuration, scheduler: result.enabled },
        }
        : current);
      notify(result.enabled ? "Automation turned on" : "Automation turned off");
    } catch (err) {
      notify(errorText(err));
    } finally {
      setSavingAutomation(false);
    }
  }

  useEffect(() => { void load(); }, [load]);
  if (!data && !error) return <PageLoader />;
  if (error) return <ErrorState message={error} retry={load} />;
  if (!data) return null;

  const healthy = automationEnabled &&
    data.configuration.asana &&
    data.configuration.anthropic &&
    Boolean(data.lastRun?.status !== "error");

  return (
    <>
      <PageHeading
        eyebrow="Command center"
        title="Everything at a glance"
        description="Monitor your promo QA automation, spot issues, and take action."
        action={<button className="button secondary" onClick={load}><RefreshCw /> Refresh</button>}
      />
      <section className={`automation-toggle ${automationEnabled ? "on" : "off"}`}>
        <div className="automation-toggle-copy">
          <div className={`automation-toggle-icon ${automationEnabled ? "on" : "off"}`}>
            {automationEnabled ? <Zap /> : <Pause />}
          </div>
          <div>
            <strong>{automationEnabled ? "Automatic QA is on" : "Automatic QA is off"}</strong>
            <span>
              {automationEnabled
                ? "Scheduled checks run every 10 minutes and can complete or comment on Asana tasks."
                : "Scheduled checks are paused. Manual QA still works from the Manual QA page."}
            </span>
          </div>
        </div>
        <label className="automation-switch">
          <span>{automationEnabled ? "On" : "Off"}</span>
          <input
            type="checkbox"
            checked={automationEnabled}
            disabled={savingAutomation}
            onChange={(event) => void toggleAutomation(event.target.checked)}
          />
        </label>
      </section>
      <section className={`health-banner ${healthy ? "healthy" : "warning"}`}>
        <div className="health-icon">{healthy ? <CheckCircle2 /> : <AlertTriangle />}</div>
        <div>
          <strong>
            {!automationEnabled
              ? "Automation is paused"
              : healthy
              ? "All systems operational"
              : "Automation needs attention"}
          </strong>
          <span>
            {!automationEnabled
              ? "Turn automation back on when you want scheduled checks to resume."
              : healthy
              ? `Next scheduled check ${relativeTime(data.nextRunAt)}`
              : "Review the configuration and latest activity below."}
          </span>
        </div>
        <button className="text-button" onClick={() => onNavigate("manual")}>Run a check <ChevronRight /></button>
      </section>
      <div className="stats-grid">
        <StatCard label="Active stores" value={data.stores.active} detail={`${data.stores.configured} credentials configured`} icon={<StoreIcon />} />
        <StatCard label="Checks · 24h" value={data.recent.total} detail={`${data.recent.skipped} skipped`} icon={<Activity />} />
        <StatCard label="Passed · 24h" value={data.recent.passed} detail={percent(data.recent.passed, data.recent.total)} icon={<CheckCircle2 />} tone="success" />
        <StatCard label="Needs attention" value={data.recent.failed + data.recent.errors} detail={`${data.recent.errors} processing errors`} icon={<AlertTriangle />} tone={data.recent.failed + data.recent.errors ? "danger" : "muted"} />
      </div>
      <div className="overview-grid">
        <section className="panel activity-panel">
          <PanelHeader title="Recent activity" subtitle="Latest task-level results" action={<button className="text-button" onClick={() => onNavigate("activity")}>View all <ChevronRight /></button>} />
          {activity.length
            ? <div className="activity-list">{activity.map((item) => <ActivityRow key={item.id} item={item} />)}</div>
            : <EmptyState icon={<Activity />} title="No activity yet" text="The first scheduled or manual run will appear here." />}
        </section>
        <section className="panel">
          <PanelHeader title="System status" subtitle="Live configuration checks" />
          <div className="config-list">
            <ConfigRow
              label="Scheduler"
              detail={automationEnabled ? "Every 10 minutes" : "Paused"}
              ok={automationEnabled}
            />
            <ConfigRow label="Asana connection" detail="Task access ready" ok={data.configuration.asana} />
            <ConfigRow label="Claude verification" detail="AI checks ready" ok={data.configuration.anthropic} />
            <ConfigRow label="Email alerts" detail="Gmail SMTP" ok={data.configuration.smtp} />
          </div>
          <div className="last-run">
            <Clock3 />
            <div><span>Last automation run</span><strong>{data.lastRun ? formatDateTime(data.lastRun.started_at) : "No runs recorded"}</strong></div>
          </div>
        </section>
      </div>
    </>
  );
}

function Stores({ notify }: { notify: (message: string) => void }) {
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Store | "new" | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<{ stores: Store[] }>("/stores");
      setStores(result.stores);
      setError("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <PageHeading
        eyebrow="Store registry"
        title="Connected stores"
        description="Manage Shopify stores and their encrypted Theme Access credentials."
        action={<button className="button primary" onClick={() => setEditing("new")}><Plus /> Add store</button>}
      />
      <div className="info-strip"><ShieldCheck /><span>Theme Access passwords are encrypted at rest and can never be viewed after saving.</span></div>
      {loading ? <PageLoader /> : error ? <ErrorState message={error} retry={load} /> : (
        <section className="panel table-panel">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Store</th><th>Status</th><th>Credentials</th><th>Last updated</th><th /></tr></thead>
              <tbody>
                {stores.map((store) => (
                  <tr key={store.id}>
                    <td>
                      <div className="store-cell">
                        <div className="store-avatar">{store.store_slug.slice(0, 2).toUpperCase()}</div>
                        <div><strong>{titleCase(store.store_slug)}</strong><span>{store.shop_domain}</span></div>
                      </div>
                    </td>
                    <td><StatusBadge status={store.active ? "active" : "inactive"} /></td>
                    <td><span className={`credential ${store.has_token ? "ok" : ""}`}>{store.has_token ? <Check /> : <X />} {store.has_token ? "Configured" : "Missing"}</span></td>
                    <td className="muted">{formatDate(store.updated_at)}</td>
                    <td><button className="button ghost compact" onClick={() => setEditing(store)}><Settings2 /> Manage</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!stores.length && <EmptyState icon={<StoreIcon />} title="No stores connected" text="Add your first store to begin checking promotions." />}
        </section>
      )}
      {editing && (
        <StoreDialog
          store={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (message) => {
            setEditing(null);
            notify(message);
            await load();
          }}
        />
      )}
    </>
  );
}

function StoreDialog({ store, onClose, onSaved }: {
  store: Store | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [slug, setSlug] = useState(store?.store_slug ?? "");
  const [domain, setDomain] = useState(store?.shop_domain ?? "");
  const [token, setToken] = useState("");
  const [active, setActive] = useState(store?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const body = { storeSlug: slug, shopDomain: domain, token, active };
      if (store) await patch(`/stores/${encodeURIComponent(store.store_slug)}`, body);
      else await post("/stores", body);
      onSaved(store ? "Store settings updated" : "Store connected successfully");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="store-title">
        <div className="dialog-header">
          <div><span>{store ? "Store settings" : "New connection"}</span><h2 id="store-title">{store ? titleCase(store.store_slug) : "Add Shopify store"}</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        <form onSubmit={save}>
          <div className="dialog-body">
            <label className="field"><span>Store slug</span><input value={slug} onChange={(event) => setSlug(slugify(event.target.value))} placeholder="power-planter-augers" required /><small>The handle used in Shopify admin URLs.</small></label>
            <label className="field"><span>Permanent Shopify domain</span><input value={domain} onChange={(event) => setDomain(event.target.value.toLowerCase())} placeholder="store-name.myshopify.com" required /></label>
            <label className="field">
              <span>{store ? "Rotate Theme Access password" : "Theme Access password"}</span>
              <input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={store ? "Leave blank to keep current password" : "shptka_…"} required={!store} />
              <small>{store ? "Enter a new password only when rotating credentials." : "Created by the Theme Access app in Shopify."}</small>
            </label>
            {store && (
              <label className="toggle-row">
                <div><strong>Automation active</strong><span>Include this store in scheduled QA checks</span></div>
                <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />
              </label>
            )}
            {error && <div className="form-error"><AlertTriangle /> {error}</div>}
          </div>
          <div className="dialog-footer"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={saving}>{saving ? <LoaderCircle className="spin" /> : <Check />} {saving ? "Saving…" : "Save store"}</button></div>
        </form>
      </section>
    </div>
  );
}

function ActivityLog() {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [status, setStatus] = useState("");
  const [store, setStore] = useState("");
  const [trigger, setTrigger] = useState("");
  const [selected, setSelected] = useState<ActivityItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const query = new URLSearchParams({ limit: "50" });
    if (status) query.set("status", status);
    if (store) query.set("store", store);
    if (trigger) query.set("trigger", trigger);
    try {
      const [result, storeResult] = await Promise.all([
        api<{ items: ActivityItem[] }>(`/activity?${query}`),
        api<{ stores: Store[] }>("/stores"),
      ]);
      setItems(result.items);
      setStores(storeResult.stores);
      setError("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [status, store, trigger]);
  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <PageHeading eyebrow="Audit trail" title="Activity log" description="A detailed history of every scheduled and manual task check." action={<button className="button secondary" onClick={load}><RefreshCw /> Refresh</button>} />
      <section className="panel filter-panel">
        <div className="filter-label"><Search /> Filter results</div>
        <select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option><option value="passed">Passed</option><option value="failed">Failed</option><option value="error">Error</option><option value="skipped_unregistered">Skipped</option></select>
        <select value={store} onChange={(event) => setStore(event.target.value)}><option value="">All stores</option>{stores.map((item) => <option key={item.id} value={item.store_slug}>{titleCase(item.store_slug)}</option>)}</select>
        <select value={trigger} onChange={(event) => setTrigger(event.target.value)}><option value="">All triggers</option><option value="cron">Scheduled</option><option value="manual">Manual</option></select>
      </section>
      {loading ? <PageLoader /> : error ? <ErrorState message={error} retry={load} /> : (
        <section className="panel table-panel">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Result</th><th>Task</th><th>Store</th><th>Trigger</th><th>Confidence</th><th>When</th><th /></tr></thead>
              <tbody>{items.map((item) => (
                <tr key={item.id} className="clickable-row" onClick={() => setSelected(item)}>
                  <td><StatusBadge status={item.status} /></td>
                  <td><div className="task-cell"><strong>{item.task_name || `Task ${item.task_gid}`}</strong><span>{item.action_taken === "none" ? "No Asana action" : `Asana: ${item.action_taken}`}</span></div></td>
                  <td>{item.store_slug ? titleCase(item.store_slug) : "—"}</td>
                  <td><span className="trigger-badge">{item.automation_runs.trigger === "cron" ? <Clock3 /> : <Play />}{item.automation_runs.dry_run ? "Dry run" : item.automation_runs.trigger === "cron" ? "Scheduled" : "Manual live"}</span></td>
                  <td>{item.confidence == null ? "—" : `${Math.round(item.confidence * 100)}%`}</td>
                  <td className="muted">{relativeTime(item.started_at)}</td>
                  <td><ChevronRight className="row-chevron" /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {!items.length && <EmptyState icon={<Search />} title="No matching activity" text="Try changing the filters or run a manual QA check." />}
        </section>
      )}
      {selected && <ActivityDrawer item={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function ActivityDrawer({ item, onClose }: { item: ActivityItem; onClose: () => void }) {
  const banners = extractBanners(item.details);
  return (
    <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="drawer">
        <div className="drawer-header">
          <div><StatusBadge status={item.status} /><h2>{item.task_name || `Task ${item.task_gid}`}</h2><span>{formatDateTime(item.started_at)}</span></div>
          <button className="icon-button" onClick={onClose}><X /></button>
        </div>
        <div className="drawer-body">
          <div className="detail-grid">
            <Detail label="Store" value={item.store_slug ? titleCase(item.store_slug) : "Unknown"} />
            <Detail label="Theme ID" value={item.theme_id || "—"} />
            <Detail label="Published theme" value={item.published_theme_id || "—"} />
            <Detail label="Confidence" value={item.confidence == null ? "—" : `${Math.round(item.confidence * 100)}%`} />
            <Detail label="Duration" value={formatDuration(item.duration_ms)} />
            <Detail label="Action" value={item.action_taken} />
          </div>
          <a className="button secondary full" href={`https://app.asana.com/0/0/${item.task_gid}`} target="_blank" rel="noreferrer">Open task in Asana <ArrowRight /></a>
          {banners.length > 0 && (
            <section className="detail-section"><h3>Banner checks</h3>{banners.map((banner, index) => (
              <div className="banner-check" key={`${banner.label}-${index}`}>
                <div><strong>{banner.label || `Banner ${index + 1}`}</strong><StatusBadge status={banner.ok ? "passed" : "failed"} /></div>
                <Compare label="Start date" expected={banner.expectedStart} actual={banner.found_start} />
                <Compare label="End date" expected={banner.expectedEnd} actual={banner.found_end} />
                <Compare label="Link" expected={banner.expectedLink} actual={banner.found_link} />
                {banner.issues?.map((issue: string) => <p className="issue" key={issue}><AlertTriangle /> {issue}</p>)}
              </div>
            ))}</section>
          )}
          {item.error_message && <section className="detail-section"><h3>Error</h3><div className="error-box">{item.error_message}</div></section>}
          <details className="raw-details"><summary>Technical details</summary><pre>{JSON.stringify(item.details, null, 2)}</pre></details>
        </div>
      </aside>
    </div>
  );
}

function ManualRun({ notify }: { notify: (message: string) => void }) {
  const [task, setTask] = useState("");
  const [mode, setMode] = useState<"dry" | "live">("dry");
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResponse | null>(null);
  const [error, setError] = useState("");

  async function run(liveConfirmed = false) {
    if (mode === "live" && !liveConfirmed) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setRunning(true);
    setResult(null);
    setError("");
    try {
      const response = await post<RunResponse>("/run", {
        taskGid: task,
        dryRun: mode === "dry",
        confirmLive: liveConfirmed,
      });
      setResult(response);
      notify(mode === "dry" ? "Dry run completed" : "Live run completed");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <PageHeading eyebrow="On-demand verification" title="Run a QA check" description="Test any assigned promo task now, without waiting for the next scheduled run." />
      <div className="manual-grid">
        <section className="panel manual-form">
          <div className="step-label"><span>1</span> Choose a task</div>
          <label className="field"><span>Asana task URL or GID</span><input value={task} onChange={(event) => setTask(event.target.value)} placeholder="https://app.asana.com/0/… or 121599…" /><small>The task must include a Shopify theme customizer URL.</small></label>
          <div className="step-label"><span>2</span> Select run mode</div>
          <div className="mode-picker">
            <button className={mode === "dry" ? "selected" : ""} onClick={() => setMode("dry")}><ShieldCheck /><div><strong>Dry run</strong><span>Check everything without changing Asana</span></div><CircleDot /></button>
            <button className={mode === "live" ? "selected live" : ""} onClick={() => setMode("live")}><Zap /><div><strong>Live run</strong><span>May complete the task or post a comment</span></div><CircleDot /></button>
          </div>
          {error && <div className="form-error"><AlertTriangle /> {error}</div>}
          <button className={`button full ${mode === "live" ? "danger" : "primary"}`} disabled={!task.trim() || running} onClick={() => void run()}>{running ? <LoaderCircle className="spin" /> : <Play />} {running ? "Checking task…" : mode === "dry" ? "Start safe dry run" : "Review live run"}</button>
        </section>
        <section className="panel what-happens">
          <PanelHeader title="What gets checked" subtitle="The exact QA pipeline" />
          <ProcessStep number="01" title="Read Asana specification" text="Pulls the QA task, parent promo brief, dates, and destination links." />
          <ProcessStep number="02" title="Inspect Shopify theme" text="Reads the linked theme's homepage configuration with Theme Access." />
          <ProcessStep number="03" title="Verify every banner" text="Claude maps flexible fields, then deterministic checks validate dates and links." />
          <ProcessStep number="04" title="Report the outcome" text={mode === "dry" ? "Shows the verdict here with no external changes." : "Passes complete the task; failures comment and mention the creator."} />
        </section>
      </div>
      {result && <RunResultPanel result={result} />}
      {confirming && (
        <div className="dialog-backdrop">
          <section className="dialog confirm-dialog">
            <div className="confirm-icon"><AlertTriangle /></div>
            <h2>Confirm live Asana run</h2>
            <p>This run can complete the task when it passes, or post a failure comment and mention the task creator.</p>
            <div className="dialog-footer"><button className="button secondary" onClick={() => setConfirming(false)}>Cancel</button><button className="button danger" onClick={() => void run(true)}><Zap /> Run live now</button></div>
          </section>
        </div>
      )}
    </>
  );
}

function RunResultPanel({ result }: { result: RunResponse }) {
  return (
    <section className="panel result-panel">
      <PanelHeader title="Run result" subtitle={`${result.processed} task${result.processed === 1 ? "" : "s"} checked · ${result.dryRun ? "No changes made" : "Live actions enabled"}`} />
      {result.results.map((item) => (
        <div className="result-summary" key={item.taskGid}>
          <div className={`result-icon ${item.status}`} >{item.status === "passed" ? <CheckCircle2 /> : item.status === "failed" ? <XCircle /> : <AlertTriangle />}</div>
          <div><StatusBadge status={item.status} /><h3>{item.taskName || `Asana task ${item.taskGid}`}</h3><p>{item.storeSlug ? `${titleCase(item.storeSlug)} · Theme ${item.themeId}` : String(item.details || "No details")}</p></div>
          {item.confidence != null && <div className="confidence"><strong>{Math.round(item.confidence * 100)}%</strong><span>confidence</span></div>}
        </div>
      ))}
      <details className="raw-details"><summary>View full verification output</summary><pre>{JSON.stringify(result.results, null, 2)}</pre></details>
    </section>
  );
}

function NavItem({ icon, label, active, onClick }: { icon: ReactNode; label: string; active: boolean; onClick: () => void }) {
  return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}>{icon}<span>{label}</span>{active && <span className="nav-indicator" />}</button>;
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action && <div className="page-actions">{action}</div>}</div>;
}

function StatCard({ label, value, detail, icon, tone = "" }: { label: string; value: number; detail: string; icon: ReactNode; tone?: string }) {
  return <article className={`stat-card ${tone}`}><div className="stat-top"><span>{label}</span><div className="stat-icon">{icon}</div></div><strong>{value}</strong><small>{detail}</small></article>;
}

function PanelHeader({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) {
  return <div className="panel-header"><div><h2>{title}</h2><p>{subtitle}</p></div>{action}</div>;
}

function ConfigRow({ label, detail, ok }: { label: string; detail: string; ok: boolean }) {
  return <div className="config-row"><div className={`config-icon ${ok ? "ok" : ""}`}>{ok ? <Check /> : <X />}</div><div><strong>{label}</strong><span>{detail}</span></div><StatusBadge status={ok ? "ready" : "issue"} /></div>;
}

function ActivityRow({ item }: { item: ActivityItem }) {
  return <div className="activity-row"><div className={`activity-icon ${item.status}`}>{statusIcon(item.status)}</div><div className="activity-copy"><strong>{item.task_name || `Task ${item.task_gid}`}</strong><span>{item.store_slug ? titleCase(item.store_slug) : "Unknown store"} · {item.automation_runs.dry_run ? "Dry run" : item.action_taken}</span></div><div className="activity-meta"><StatusBadge status={item.status} /><time>{relativeTime(item.started_at)}</time></div></div>;
}

function StatusBadge({ status }: { status: string }) {
  const label = status.replace(/^skipped_/, "").replaceAll("_", " ");
  return <span className={`status-badge ${status}`}><i />{label}</span>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="detail"><span>{label}</span><strong>{value}</strong></div>;
}

function Compare({ label, expected, actual }: { label: string; expected?: string | null; actual?: string | null }) {
  return <div className="compare-row"><span>{label}</span><div><small>Expected</small><code>{expected || "Not specified"}</code></div><ArrowRight /><div><small>Found</small><code>{actual || "Not found"}</code></div></div>;
}

function ProcessStep({ number, title, text }: { number: string; title: string; text: string }) {
  return <div className="process-step"><span>{number}</span><div><strong>{title}</strong><p>{text}</p></div></div>;
}

function EmptyState({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return <div className="empty-state"><div>{icon}</div><h3>{title}</h3><p>{text}</p></div>;
}

function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return <div className="error-state"><AlertTriangle /><h3>Something went wrong</h3><p>{message}</p><button className="button secondary" onClick={retry}><RefreshCw /> Try again</button></div>;
}

function PageLoader() {
  return <div className="page-loader"><LoaderCircle className="spin" /><span>Loading dashboard data…</span></div>;
}

function FullScreenLoader({ label }: { label: string }) {
  return <div className="full-loader"><div className="brand-mark"><Zap /></div><LoaderCircle className="spin" /><span>{label}</span></div>;
}

function statusIcon(status: Status) {
  if (status === "passed") return <CheckCircle2 />;
  if (status === "failed") return <XCircle />;
  if (status === "error") return <AlertTriangle />;
  return <Clock3 />;
}

function pageTitle(page: Page) {
  return { overview: "Overview", stores: "Stores", activity: "Activity", manual: "Manual QA" }[page];
}

function titleCase(value: string) {
  return value.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function relativeTime(value: string) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function formatDuration(milliseconds: number) {
  return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(1)}s`;
}

function percent(value: number, total: number) {
  return total ? `${Math.round(value / total * 100)}% success rate` : "No checks yet";
}

function errorText(error: unknown) {
  if (error instanceof ApiError && error.status === 401) return "Your session expired. Refresh to sign in again.";
  return error instanceof Error ? error.message : "Unexpected error";
}

function extractBanners(details: unknown): Array<Record<string, any>> {
  if (!details || typeof details !== "object") return [];
  const source = details as Record<string, any>;
  const verdict = source.verdict && typeof source.verdict === "object" ? source.verdict : source;
  const expected = source.spec?.banners || [];
  if (!Array.isArray(verdict.banners)) return [];
  return verdict.banners.map((banner: Record<string, any>, index: number) => ({
    ...banner,
    expectedStart: expected[index]?.start_date,
    expectedEnd: expected[index]?.end_date,
    expectedLink: expected[index]?.promo_link,
  }));
}
