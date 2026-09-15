import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { getStatus, getCachedStatus, ProxyNotConfiguredError, HomeNodeUnreachableError } from "../lib/api";
import { recordEvent } from "../lib/usage";
import { flushUsageEvents } from "../lib/flush";
import { isShizukuToolkitEnabled, isScreenContextEnabled } from "../lib/config";
import { onPassiveCapture, getLastPassiveCapture, startPassiveCaptureListener } from "../lib/passiveCapture";
import { withPlayCategoryFallback } from "../lib/playCategories";
import { registerPlugin } from "@capacitor/core";
import { Switch } from "../components/Switch";
import { RefreshIcon } from "../components/Icons";

const ShizukuMonitor = registerPlugin<any>('ShizukuMonitor');
const AccessibilityScanner = registerPlugin<any>('AccessibilityScanner');

// Must exactly match ShizukuMonitorPlugin.ALLOWED_COMMANDS on the Java side —
// that's the real enforcement point, this list just drives the UI.
const PRESET_COMMANDS = [
  "dumpsys battery", "dumpsys cpuinfo", "dumpsys meminfo",
  "pm list packages -3", "ifconfig wlan0", "getprop ro.build.version.release",
];

type State =
  | { kind: "loading" }
  | { kind: "ok"; health: string; version: string }
  | { kind: "not-configured" }
  | { kind: "home-offline"; message: string; stale?: { health: string; version: string; at: string } }
  | { kind: "error"; message: string };

type AppEntry = { packageName: string; label: string; isSystemApp: boolean; hasLauncherIcon: boolean; category: string };

const PASSIVE_MODE_CONFIRM_PHRASE = "I understand";

export default function Status() {
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [toolkitEnabled, setToolkitEnabled] = useState(false);
  const [contextEnabled, setContextEnabled] = useState(false);
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [allowlist, setAllowlistState] = useState<Set<string>>(new Set());
  const [showPicker, setShowPicker] = useState(false);
  const [recentPackages, setRecentPackages] = useState<Set<string>>(new Set());
  const [usageAccessGranted, setUsageAccessGranted] = useState(false);
  const [showSystemApps, setShowSystemApps] = useState(false);
  // Hidden by default: an app with no launcher icon (getLaunchIntentForPackage
  // returns null natively) can never be brought to the foreground, so it can
  // never have on-screen text worth capturing - filtering it out of the
  // picker's main list reduces noise for the common case. Not a hard
  // exclusion like EXCLUDED_PREFIXES/EXCLUDED_NOISE_PREFIXES (Java-side,
  // enforced even against a manually-edited allowlist) - this is just a
  // default view filter the user can lift with the toggle below, since a
  // background-only package is unusual but not impossible to want.
  const [showBackgroundApps, setShowBackgroundApps] = useState(false);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  // Total foreground ms per package over the same window as recentPackages
  // (see getRecentlyUsedPackages) — only populated when Usage Access is
  // granted, same gate as recentPackages itself. Empty otherwise, which the
  // "Active time" sort mode below falls back gracefully from (0 for every
  // app just means that sort ties everything and falls through to name).
  const [usageMs, setUsageMs] = useState<Record<string, number>>({});
  const [pickerSearch, setPickerSearch] = useState("");
  const [pickerCategoryFilter, setPickerCategoryFilter] = useState<string>("all");
  type SortMode = "name" | "recent" | "active-time" | "category";
  const [sortMode, setSortMode] = useState<SortMode>("category");
  const [passiveMode, setPassiveMode] = useState(false);
  const [passiveConfirmText, setPassiveConfirmText] = useState("");
  const [showPassiveConfirm, setShowPassiveConfirm] = useState(false);
  const [lastPassiveCapture, setLastPassiveCapture] = useState<{ pkg: string; at: string } | null>(getLastPassiveCapture());

  async function load() {
    setState({ kind: "loading" });
    try {
      const { health, version } = await getStatus();
      setState({ kind: "ok", health, version });
    } catch (err) {
      if (err instanceof ProxyNotConfiguredError) {
        setState({ kind: "not-configured" });
      } else if (err instanceof HomeNodeUnreachableError) {
        const cached = await getCachedStatus();
        setState({
          kind: "home-offline",
          message: err.message,
          stale: cached ? { ...cached.value, at: cached.at } : undefined,
        });
      } else {
        setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  useEffect(() => {
    load();
    isShizukuToolkitEnabled().then(setToolkitEnabled);
    isScreenContextEnabled().then(setContextEnabled);
    AccessibilityScanner.getPassiveModeEnabled().then((r: any) => setPassiveMode(r.enabled));
    // Load the real saved allowlist on mount — without this, allowlist stays
    // the empty Set() default until the user opens the app picker at least
    // once this session, wrongly disabling Scan Screen Text / Passive mode
    // even when a real allowlist is already saved natively.
    AccessibilityScanner.getAllowlist().then(({ packages }: { packages: string[] }) => setAllowlistState(new Set(packages)));
    recordEvent({ type: "screen_view", screen: "status", timestamp: new Date().toISOString() });
    flushUsageEvents();

    // The actual passive-capture listener is registered app-wide in
    // App.tsx (so it keeps running regardless of which screen is open) —
    // this just subscribes to it for the "Last passive capture" display.
    return onPassiveCapture((capture) => setLastPassiveCapture(capture));
  }, []);

  async function handleTogglePassiveMode(next: boolean) {
    if (!next) {
      setPassiveMode(false);
      setShowPassiveConfirm(false);
      setPassiveConfirmText("");
      await AccessibilityScanner.setPassiveModeEnabled({ enabled: false });
      return;
    }
    setShowPassiveConfirm(true);
  }

  async function confirmPassiveMode() {
    if (passiveConfirmText.trim() !== PASSIVE_MODE_CONFIRM_PHRASE) return;
    setPassiveMode(true);
    setShowPassiveConfirm(false);
    setPassiveConfirmText("");
    // Covers turning passive mode on mid-session, when App.tsx's startup
    // check already ran and found it off — startPassiveCaptureListener is a
    // no-op if App.tsx already started it.
    startPassiveCaptureListener();
    await AccessibilityScanner.setPassiveModeEnabled({ enabled: true });
  }

  async function openPicker() {
    try {
      const [{ apps }, { packages }, { granted }] = await Promise.all([
        AccessibilityScanner.listInstalledApps(),
        AccessibilityScanner.getAllowlist(),
        AccessibilityScanner.isUsageAccessGranted(),
      ]);
      // Fills in a real category (from the offline Play Store scrape seed)
      // only where the OS-reported category is "Uncategorized" — never
      // overrides a category Android itself declared.
      setApps(apps.map(withPlayCategoryFallback));
      setUsageAccessGranted(granted);

      // Suggestion, not an override — recent packages are pre-checked only if
      // the saved allowlist is empty (first-run convenience). An existing
      // allowlist reflects a deliberate prior choice and is never silently
      // expanded by this.
      if (granted) {
        const { packages: recent, usageMs: usage } = await AccessibilityScanner.getRecentlyUsedPackages({ days: 7 });
        setRecentPackages(new Set(recent));
        setUsageMs(usage ?? {});
        if (packages.length === 0 && recent.length > 0) {
          const installedNames = new Set(apps.map((a: AppEntry) => a.packageName));
          const suggested = recent.filter((p: string) => installedNames.has(p));
          setAllowlistState(new Set(suggested));
          await AccessibilityScanner.setAllowlist({ packages: suggested });
        } else {
          setAllowlistState(new Set(packages));
        }
      } else {
        setAllowlistState(new Set(packages));
      }

      setShowPicker(true);
    } catch (e: any) {
      alert("Could not load app list: " + (e.message || String(e)));
    }
  }

  function toggleCategoryCollapsed(category: string) {
    const next = new Set(collapsedCategories);
    if (next.has(category)) next.delete(category);
    else next.add(category);
    setCollapsedCategories(next);
  }

  async function toggleApp(packageName: string) {
    const next = new Set(allowlist);
    if (next.has(packageName)) next.delete(packageName);
    else next.add(packageName);
    await applyAllowlist(next);
  }

  // A real toggle, not just "add all" - if every app in the group is
  // already selected, this deselects the whole group instead of being a
  // no-op, so the header checkbox's own checked state stays meaningful
  // (checked = "all of these are in the allowlist").
  async function toggleGroup(groupApps: AppEntry[]) {
    const next = new Set(allowlist);
    const allSelected = groupApps.every(a => next.has(a.packageName));
    for (const a of groupApps) {
      if (allSelected) next.delete(a.packageName);
      else next.add(a.packageName);
    }
    await applyAllowlist(next);
  }

  async function applyAllowlist(next: Set<string>) {
    setAllowlistState(next);
    await AccessibilityScanner.setAllowlist({ packages: Array.from(next) });

    if (next.size === 0 && passiveMode) {
      setPassiveMode(false);
      await AccessibilityScanner.setPassiveModeEnabled({ enabled: false });
    }
  }

  async function selectAllApps() {
    // apps is already pre-filtered by the Java side (banking/password-manager
    // packages excluded from the list entirely, both by package prefix AND by
    // app-label keyword as of 2026-08-30 — see AccessibilityPlugin.isExcluded),
    // so "all" here still respects that boundary — it's a bulk-edit convenience,
    // not a wider grant. setAllowlist also re-checks label-based exclusion
    // server-side as defense in depth, so this stays safe even if this list
    // were ever stale.
    // Deliberately NOT scoped to the "hide background-only apps" view filter
    // below (showBackgroundApps) — that filter only controls what's shown,
    // Select All still means every capturable app, matching its existing
    // pre-filter behavior rather than silently changing meaning based on a
    // view toggle's current state.
    await applyAllowlist(new Set(apps.map(a => a.packageName)));
  }

  async function deselectAllApps() {
    await applyAllowlist(new Set());
  }

  async function runPreset(cmd: string) {
    try {
      const res = await ShizukuMonitor.executeCommand({ command: cmd });
      await recordEvent({
        type: "system_telemetry",
        screen: "background",
        telemetry: `Command: ${cmd}\n\n${res.output}`,
        timestamp: new Date().toISOString(),
      });
      await flushUsageEvents();
      alert("Executed & synced to PiecesOS.");
    } catch (e: any) {
      alert("Error: " + (e.message || String(e)));
    }
  }

  async function scanScreenText() {
    try {
      const res = await AccessibilityScanner.getActiveScreenText();
      if (res.status === "success") {
        await recordEvent({
          type: "system_telemetry",
          screen: "background",
          telemetry: `Package: ${res.package}\n\n${res.textNodes}`,
          package: res.package,
          app_label: res.appLabel,
          timestamp: new Date().toISOString(),
        });
        await flushUsageEvents();
        alert(`Captured & synced ${res.textNodes.length} characters from ${res.package}.`);
      } else {
        alert(res.status);
      }
    } catch (e: any) {
      alert("Accessibility error: " + (e.message || String(e)));
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-header-top">
          <h1>System Status</h1>
          <button className="secondary pill" onClick={load} title="Refresh connection">
            <RefreshIcon size={14} /> Refresh
          </button>
        </div>
        <p className="hint">Live bridge health and diagnostics between Android and your PC's PiecesOS.</p>
      </div>

      {state.kind === "loading" && (
        <div className="card">
          <p className="hint" style={{ margin: 0 }}>Checking PiecesOS connection…</p>
        </div>
      )}

      {state.kind === "not-configured" && (
        <div className="card">
          <p className="status-error" style={{ marginBottom: 12 }}>Not set up yet.</p>
          <button onClick={() => navigate("/setup")}>Go to Setup</button>
        </div>
      )}

      {state.kind === "home-offline" && (
        <div className="card panel-danger">
          <p className="status-error" style={{ marginBottom: 8 }}>Home PC is offline or unreachable. {state.message}</p>
          <button onClick={load} style={{ alignSelf: "flex-start", marginBottom: 8 }}>Retry</button>

          {state.stale && (
            <p className="hint setup-note" style={{ margin: 0 }}>
              Last known: PiecesOS {state.stale.version}, as of {new Date(state.stale.at).toLocaleString()}.
            </p>
          )}
        </div>
      )}

      {state.kind === "error" && (
        <div className="card panel-danger">
          <p className="status-error" style={{ marginBottom: 12 }}>{state.message}</p>
          <button onClick={load} style={{ alignSelf: "flex-start" }}>Retry</button>
        </div>
      )}

      {state.kind === "ok" && (
        <>
          <div className="status-hero-card">
            <div className="card-row">
              <div className="status-ok">
                <span className="status-pulse-live" />
                <span style={{ fontSize: 16, fontWeight: 700 }}>PiecesOS Connected</span>
              </div>
              <span className="badge success">Active</span>
            </div>
            <div className="metrics-grid">
              <div className="metric-box">
                <div className="metric-label">Health</div>
                <div className="metric-val">{state.health}</div>
              </div>
              <div className="metric-box">
                <div className="metric-label">Version</div>
                <div className="metric-val">{state.version}</div>
              </div>
              <div className="metric-box">
                <div className="metric-label">Allowlist</div>
                <div className="metric-val">{allowlist.size} apps</div>
              </div>
            </div>
          </div>

          {!toolkitEnabled && !contextEnabled && (
            <p className="hint setup-note">
              Screen context and the Shizuku toolkit are both off. Enable either in Setup.
            </p>
          )}

          {toolkitEnabled && (
            <div className="panel" style={{ marginTop: 20 }}>
              <p className="panel-title">Shizuku Diagnostics</p>
              <div className="chip-row">
                {PRESET_COMMANDS.map(c => (
                  <button key={c} className="chip" onClick={() => runPreset(c)}>
                    {c}
                  </button>
                ))}
              </div>
            </div>
          )}

          {contextEnabled && (
            <div className="panel" style={{ marginTop: 20 }}>
              <p className="panel-title">Screen Context</p>
              <p className="hint" style={{ margin: 0 }}>
                Screen-text capture only reads from apps you've explicitly allowed below.
              </p>
              <button className="secondary" onClick={openPicker}>
                Choose allowed apps ({allowlist.size} selected)
              </button>
              <button onClick={scanScreenText} disabled={allowlist.size === 0}>
                Scan Screen Text
              </button>

              {showPicker && (() => {
                // A currently-allowlisted app is never hidden by this filter,
                // even if it has no launcher icon - toggling the filter off
                // must not make an existing selection disappear from view.
                const backgroundFiltered = apps.filter(
                  a => showBackgroundApps || a.hasLauncherIcon || allowlist.has(a.packageName)
                );
                const hiddenBackgroundCount = apps.length - backgroundFiltered.length;

                // Search matches label or package name, case-insensitive.
                // Category filter and search compose - both narrow the same
                // list, neither resets the other.
                const query = pickerSearch.trim().toLowerCase();
                const searched = query
                  ? backgroundFiltered.filter(a =>
                      a.label.toLowerCase().includes(query) || a.packageName.toLowerCase().includes(query))
                  : backgroundFiltered;
                const categoryFiltered = pickerCategoryFilter === "all"
                  ? searched
                  : searched.filter(a => a.category === pickerCategoryFilter);

                const allCategoryNames = Array.from(new Set(apps.map(a => a.category))).sort();

                const userApps = categoryFiltered.filter(a => !a.isSystemApp);
                const systemApps = categoryFiltered.filter(a => a.isSystemApp);
                const recentApps = userApps.filter(a => recentPackages.has(a.packageName));
                const recentNames = new Set(recentApps.map(a => a.packageName));

                const renderAppRow = (app: AppEntry) => (
                  <label key={app.packageName} className="app-row">
                    <input
                      type="checkbox"
                      checked={allowlist.has(app.packageName)}
                      onChange={() => toggleApp(app.packageName)}
                    />
                    {app.label} <span className="app-row-pkg">({app.packageName})</span>
                    {sortMode === "active-time" && usageMs[app.packageName] > 0 && (
                      <span className="app-row-pkg" style={{ marginLeft: "auto" }}>
                        {/* MIN_FOREGROUND_MS_FOR_RECENT (native) is 60s, so this is never 0m for
                            anything that actually appears in usageMs - but Math.max guards it
                            anyway in case that threshold ever changes without this comment
                            being noticed. */}
                        {Math.max(1, Math.round(usageMs[app.packageName] / 60000))}m
                      </span>
                    )}
                  </label>
                );

                // "category" reuses the existing grouped-by-category layout
                // (with its own Recently Used carve-out and collapsible
                // sections) - the other three modes are a single flat list,
                // since flattening AND grouping-by-category at the same time
                // doesn't make sense as one ordering.
                const byCategory = new Map<string, AppEntry[]>();
                if (sortMode === "category") {
                  for (const app of userApps) {
                    if (recentNames.has(app.packageName)) continue;
                    const list = byCategory.get(app.category) ?? [];
                    list.push(app);
                    byCategory.set(app.category, list);
                  }
                }
                const categoryNames = Array.from(byCategory.keys())
                  .filter(c => c !== "Uncategorized")
                  .sort();
                if (byCategory.has("Uncategorized")) categoryNames.push("Uncategorized");

                const flatSortComparators: Record<Exclude<SortMode, "category">, (a: AppEntry, b: AppEntry) => number> = {
                  name: (a, b) => a.label.localeCompare(b.label),
                  recent: (a, b) => {
                    const aRecent = recentNames.has(a.packageName) ? 1 : 0;
                    const bRecent = recentNames.has(b.packageName) ? 1 : 0;
                    return bRecent - aRecent || a.label.localeCompare(b.label);
                  },
                  "active-time": (a, b) => {
                    const diff = (usageMs[b.packageName] ?? 0) - (usageMs[a.packageName] ?? 0);
                    return diff !== 0 ? diff : a.label.localeCompare(b.label);
                  },
                };
                const flatSortedUserApps = sortMode === "category"
                  ? []
                  : [...userApps].sort(flatSortComparators[sortMode]);

                return (
                  <div className="picker">
                    <input
                      type="search"
                      placeholder="Search apps…"
                      value={pickerSearch}
                      onChange={(e) => setPickerSearch(e.target.value)}
                      style={{ marginBottom: 8 }}
                    />

                    <div className="picker-actions" style={{ flexWrap: "wrap" }}>
                      <select
                        value={pickerCategoryFilter}
                        onChange={(e) => setPickerCategoryFilter(e.target.value)}
                        style={{ padding: "6px 10px", fontSize: 12.5, borderRadius: 8, border: "1.5px solid var(--border)", background: "var(--surface)", color: "var(--text)" }}
                      >
                        <option value="all">All categories</option>
                        {allCategoryNames.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <select
                        value={sortMode}
                        onChange={(e) => setSortMode(e.target.value as SortMode)}
                        style={{ padding: "6px 10px", fontSize: 12.5, borderRadius: 8, border: "1.5px solid var(--border)", background: "var(--surface)", color: "var(--text)" }}
                      >
                        <option value="category">Sort: Category</option>
                        <option value="name">Sort: Name</option>
                        <option value="recent">Sort: Recently used</option>
                        <option value="active-time">Sort: Active time</option>
                      </select>
                    </div>

                    <div className="picker-actions">
                      <button className="secondary" onClick={selectAllApps}>Select all</button>
                      <button className="secondary" onClick={deselectAllApps}>Deselect all</button>
                    </div>

                    {hiddenBackgroundCount > 0 && (
                      <label className="app-row" style={{ marginBottom: 6 }}>
                        <input
                          type="checkbox"
                          checked={showBackgroundApps}
                          onChange={(e) => setShowBackgroundApps(e.target.checked)}
                        />
                        Show background-only apps ({hiddenBackgroundCount} hidden — no launcher icon, can't ever be brought on-screen)
                      </label>
                    )}

                    {!usageAccessGranted && (
                      <div className="picker-notice">
                        <p>Grant Usage Access to auto-suggest apps you've used this week.</p>
                        <button className="secondary" onClick={() => AccessibilityScanner.openUsageAccessSettings()}>
                          Grant Usage Access
                        </button>
                      </div>
                    )}

                    {sortMode !== "category" && (
                      userApps.length === 0
                        ? <p className="hint">No apps match.</p>
                        : flatSortedUserApps.map(renderAppRow)
                    )}

                    {sortMode === "category" && recentApps.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <div className="picker-group-header">
                          <input
                            type="checkbox"
                            title="Select all in this group"
                            checked={recentApps.every(a => allowlist.has(a.packageName))}
                            onChange={() => toggleGroup(recentApps)}
                          />
                          <span className="picker-group-label recent" style={{ cursor: "default" }}>
                            Recently used (last 7 days)
                          </span>
                        </div>
                        {recentApps.map(renderAppRow)}
                      </div>
                    )}

                    {sortMode === "category" && categoryNames.map(category => {
                      const collapsed = collapsedCategories.has(category);
                      const categoryApps = (byCategory.get(category) ?? []).sort((a, b) => a.label.localeCompare(b.label));
                      return (
                        <div key={category} style={{ marginBottom: 4 }}>
                          <div className="picker-group-header">
                            <input
                              type="checkbox"
                              title="Select all in this category"
                              checked={categoryApps.every(a => allowlist.has(a.packageName))}
                              onChange={() => toggleGroup(categoryApps)}
                            />
                            <span className="picker-group-label" onClick={() => toggleCategoryCollapsed(category)}>
                              {collapsed ? '▸' : '▾'} {category} ({categoryApps.length})
                            </span>
                          </div>
                          {!collapsed && categoryApps.map(renderAppRow)}
                        </div>
                      );
                    })}

                    {systemApps.length > 0 && (() => {
                      const sortedSystemApps = systemApps
                        .slice()
                        .sort(sortMode === "category" ? flatSortComparators.name : flatSortComparators[sortMode]);
                      return (
                        <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 4 }}>
                          <div className="picker-group-header">
                            <input
                              type="checkbox"
                              title="Select all system apps"
                              checked={sortedSystemApps.every(a => allowlist.has(a.packageName))}
                              onChange={() => toggleGroup(sortedSystemApps)}
                            />
                            <span className="picker-group-label" onClick={() => setShowSystemApps(!showSystemApps)}>
                              {showSystemApps ? '▾' : '▸'} System apps ({systemApps.length})
                            </span>
                          </div>
                          {showSystemApps && sortedSystemApps.map(renderAppRow)}
                        </div>
                      );
                    })()}

                    <button className="secondary" style={{ marginTop: 8 }} onClick={() => setShowPicker(false)}>
                      Done
                    </button>
                  </div>
                );
              })()}

              <div className="panel panel-danger" style={{ marginTop: 14 }}>
                <Switch
                  checked={passiveMode}
                  disabled={allowlist.size === 0}
                  onChange={handleTogglePassiveMode}
                  danger={true}
                  label={<strong>Passive mode (advanced)</strong>}
                  description={
                    <span>
                      Push screen text from allowed apps to PiecesOS continuously whenever it changes and settles for ~2s.
                      {allowlist.size === 0 && " (Select at least one app above to enable)"}
                    </span>
                  }
                />

                {showPassiveConfirm && (
                  <div className="confirm-box">
                    <p>
                      This will continuously send text from {allowlist.size} allowed app{allowlist.size === 1 ? '' : 's'} to
                      PiecesOS in the background, without asking each time. Type "{PASSIVE_MODE_CONFIRM_PHRASE}" to confirm.
                    </p>
                    <input
                      value={passiveConfirmText}
                      onChange={(e) => setPassiveConfirmText(e.target.value)}
                      placeholder={PASSIVE_MODE_CONFIRM_PHRASE}
                    />
                    <div className="confirm-actions">
                      <button
                        className="danger"
                        onClick={confirmPassiveMode}
                        disabled={passiveConfirmText.trim() !== PASSIVE_MODE_CONFIRM_PHRASE}
                      >
                        Confirm
                      </button>
                      <button
                        className="secondary"
                        onClick={() => { setShowPassiveConfirm(false); setPassiveConfirmText(""); }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {passiveMode && lastPassiveCapture && (
                  <div className="status-ok" style={{ fontSize: 12, marginTop: 8, fontWeight: 500 }}>
                    <span className="status-pulse-live" />
                    <span>Last passive capture: {lastPassiveCapture.pkg} at {new Date(lastPassiveCapture.at).toLocaleTimeString()}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
