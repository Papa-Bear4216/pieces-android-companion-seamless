import { useState, useEffect } from "react";
import { registerPlugin } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import { BarcodeScanner } from "@capacitor-mlkit/barcode-scanning";

const AccessibilityScanner = registerPlugin<any>('AccessibilityScanner');

import {
  getProxyBaseUrl, getProxyToken, setProxyBaseUrl, setProxyToken,
  getRemoteGatewayUrl, getRemoteGatewayToken, setRemoteGatewayUrl, setRemoteGatewayToken,
  isScreenContextEnabled, setScreenContextEnabled,
} from "../lib/config";
import { checkProxyHealth, getStatus, HomeNodeUnreachableError } from "../lib/api";
import { recordEvent, classifyMode } from "../lib/usage";
import { flushUsageEvents } from "../lib/flush";
import { parseConnectionQrPayload } from "../lib/connectionQr";
import { decodeJwtForDisplay, formatExpiry } from "../lib/jwtDisplay";
import {
  isNotificationListenerGranted, getNotificationCaptureConfig, setNotificationCapture,
  openNotificationListenerSettings,
  startNotificationCaptureListener,
} from "../lib/notificationCapture";
import {
  smsPermissions, openSmsAppSettings, runSmsBackfill, resetSmsBackfillToRecent,
  listSmsContacts, getSmsAllowlist, setSmsAllowlist, type SmsContact,
} from "../lib/smsBackfill";
import { Switch } from "../components/Switch";
import { ScanIcon, CheckIcon, WifiIcon, CloudIcon } from "../components/Icons";

export default function Setup() {
  // Plan A (LAN)
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  // Plan B (remote gateway) — optional; auto-failover target
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteToken, setRemoteToken] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<"idle" | "ok" | "server-only" | "unreachable">("idle");
  const [scanError, setScanError] = useState<string | null>(null);
  const [screenContext, setScreenContext] = useState(false);
  const [accessibilityGranted, setAccessibilityGranted] = useState(false);

  // Part 1: notification capture
  const [notifCapture, setNotifCapture] = useState(false);
  const [notifAllApps, setNotifAllApps] = useState(false);
  const [notifListenerGranted, setNotifListenerGranted] = useState(false);

  // Part 2: SMS backfill (contact-allowlist model)
  const [smsGranted, setSmsGranted] = useState(false);
  const [contactsGranted, setContactsGranted] = useState(false);
  const [smsBusy, setSmsBusy] = useState(false);
  const [smsError, setSmsError] = useState<string | null>(null);
  const [smsResult, setSmsResult] = useState<string | null>(null);
  const [contacts, setContacts] = useState<SmsContact[]>([]);
  const [contactFilter, setContactFilter] = useState("");
  const [smsAllow, setSmsAllow] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    (async () => {
      const [savedUrl, savedToken, savedRemoteUrl, savedRemoteToken, contextEnabled] =
        await Promise.all([
          getProxyBaseUrl(), getProxyToken(),
          getRemoteGatewayUrl(), getRemoteGatewayToken(),
          isScreenContextEnabled(),
        ]);
      if (savedUrl) setBaseUrl(savedUrl);
      if (savedToken) setToken(savedToken);
      if (savedRemoteUrl) setRemoteUrl(savedRemoteUrl);
      if (savedRemoteToken) setRemoteToken(savedRemoteToken);
      setScreenContext(contextEnabled);
    })();
    AccessibilityScanner.isAccessibilityServiceEnabled().then((r: any) => setAccessibilityGranted(r.enabled));
    refreshNotifState();
    refreshSmsState();
    recordEvent({ type: "screen_view", screen: "setup", timestamp: new Date().toISOString() });
    flushUsageEvents();

    let lastResume = 0;
    const onResume = () => {
      const now = Date.now();
      if (now - lastResume < 500) return;
      lastResume = now;
      AccessibilityScanner.isAccessibilityServiceEnabled()
        .then((r: any) => setAccessibilityGranted(r.enabled))
        .catch(() => {});
      refreshNotifState();
      refreshSmsState();
    };

    let disposed = false;
    let appListenerHandle: { remove: () => Promise<void> } | undefined;
    CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) onResume();
    }).then((handle) => {
      if (disposed) {
        handle.remove();
      } else {
        appListenerHandle = handle;
      }
    }).catch(() => {});

    window.addEventListener("focus", onResume);
    return () => {
      disposed = true;
      window.removeEventListener("focus", onResume);
      appListenerHandle?.remove();
    };
  }, []);

  async function refreshSmsState() {
    const perms = await smsPermissions();
    setSmsGranted(perms.sms);
    setContactsGranted(perms.contacts);
    if (perms.sms) {
      try {
        setSmsAllow(new Set(await getSmsAllowlist()));
      } catch { /* not granted yet */ }
    }
  }

  async function refreshNotifState() {
    const [granted, cfg] = await Promise.all([
      isNotificationListenerGranted(),
      getNotificationCaptureConfig(),
    ]);
    setNotifListenerGranted(granted);
    setNotifCapture(cfg.enabled);
    setNotifAllApps(cfg.allApps);
  }

  async function handleToggleNotifCapture(next: boolean) {
    setNotifCapture(next);
    await setNotificationCapture(next, notifAllApps);
    if (next) startNotificationCaptureListener();
  }

  async function handleToggleNotifAllApps(next: boolean) {
    setNotifAllApps(next);
    await setNotificationCapture(notifCapture, next);
  }

  async function handleOpenPicker() {
    setSmsError(null);
    setPickerOpen(true);
    try {
      setContacts(await listSmsContacts());
    } catch (e) {
      setSmsError(e instanceof Error ? e.message : String(e));
      setPickerOpen(false);
    }
  }

  function toggleContactNumbers(numbers: string[]) {
    setSmsAllow((prev) => {
      const next = new Set(prev);
      const allOn = numbers.every((n) => next.has(n));
      for (const n of numbers) {
        if (allOn) next.delete(n);
        else next.add(n);
      }
      return next;
    });
  }

  async function handleSaveAllowlist() {
    setSmsBusy(true);
    setSmsError(null);
    try {
      const count = await setSmsAllowlist([...smsAllow]);
      setSmsResult(`Allowlist saved — ${count} number${count === 1 ? "" : "s"}.`);
      setPickerOpen(false);
    } catch (e) {
      setSmsError(e instanceof Error ? e.message : String(e));
    }
    setSmsBusy(false);
  }

  async function handleSmsBackfill() {
    setSmsBusy(true);
    setSmsError(null);
    setSmsResult(null);
    try {
      const { ingested, done } = await runSmsBackfill((p) =>
        setSmsResult(`${p.ingested} messages queued${p.done ? "" : "…"}`)
      );
      setSmsResult(
        done
          ? `Done — ${ingested} messages from allowlisted contacts queued for PiecesOS.`
          : `${ingested} queued so far — run again to continue (large history is paced across runs).`
      );
      flushUsageEvents();
    } catch (e) {
      setSmsError(e instanceof Error ? e.message : String(e));
    }
    setSmsBusy(false);
  }

  async function handleResetToRecent() {
    setSmsBusy(true);
    setSmsError(null);
    setSmsResult(null);
    try {
      const target = await resetSmsBackfillToRecent(30);
      const targetDate = new Date(target).toLocaleDateString();
      const res = await runSmsBackfill((p) => {
        setSmsResult(`Syncing recent from ${targetDate}: ${p.ingested} message${p.ingested === 1 ? "" : "s"}…`);
      });
      await flushUsageEvents();
      setSmsResult(
        res.ingested > 0
          ? `Synced ${res.ingested} recent message${res.ingested === 1 ? "" : "s"} from ${targetDate} forward.`
          : `Caught up — no newer messages found since ${targetDate}.`
      );
    } catch (e) {
      setSmsError(e instanceof Error ? e.message : String(e));
    } finally {
      setSmsBusy(false);
    }
  }

  async function handleToggleScreenContext(next: boolean) {
    setScreenContext(next);
    await setScreenContextEnabled(next);
    try {
      await AccessibilityScanner.setScreenContextEnabled({ enabled: next });
    } catch (e) {
      console.warn("[Accessibility] setScreenContextEnabled failed", e);
    }
  }

  async function deepCheckAfterSave(): Promise<"ok" | "server-only"> {
    try {
      await getStatus();
      return "ok";
    } catch (e) {
      if (e instanceof HomeNodeUnreachableError) return "server-only";
      return "server-only";
    }
  }

  async function handleScanToConnect() {
    setScanError(null);
    try {
      const { camera } = await BarcodeScanner.checkPermissions();
      if (camera !== "granted" && camera !== "limited") {
        const req = await BarcodeScanner.requestPermissions();
        if (req.camera !== "granted" && req.camera !== "limited") {
          setScanError("Camera permission is required to scan the connection code.");
          return;
        }
      }

      const { barcodes } = await BarcodeScanner.scan();
      const raw = barcodes[0]?.rawValue;
      if (!raw) return;

      const { baseUrl: scannedUrl, token: scannedToken } = parseConnectionQrPayload(raw);
      setBaseUrl(scannedUrl);
      setToken(scannedToken);
      setChecking(true);
      setResult("idle");
      try {
        const reachable = await checkProxyHealth(scannedUrl);
        if (!reachable) {
          setResult("unreachable");
          return;
        }
        await setProxyBaseUrl(scannedUrl);
        await setProxyToken(scannedToken);
        setResult(await deepCheckAfterSave());
        await recordEvent({
          type: "setup_saved",
          screen: "setup",
          mode: classifyMode(scannedUrl),
          timestamp: new Date().toISOString(),
        });
        flushUsageEvents();
        AccessibilityScanner.flushOutbox().catch(() => {});
      } finally {
        setChecking(false);
      }
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleTestAndSave() {
    setChecking(true);
    setResult("idle");

    const planA = baseUrl.trim() && token.trim();
    const planB = remoteUrl.trim() && remoteToken.trim();
    if (!planA && !planB) {
      setChecking(false);
      setResult("unreachable");
      return;
    }

    const verifyUrl = planA ? baseUrl : remoteUrl;
    const reachable = await checkProxyHealth(verifyUrl);
    if (!reachable) {
      setChecking(false);
      setResult("unreachable");
      return;
    }

    await setProxyBaseUrl(planA ? baseUrl.trim() : "");
    await setProxyToken(planA ? token.trim() : "");
    await setRemoteGatewayUrl(planB ? remoteUrl.trim() : "");
    await setRemoteGatewayToken(planB ? remoteToken.trim() : "");

    setResult(await deepCheckAfterSave());
    setChecking(false);

    await recordEvent({
      type: "setup_saved",
      screen: "setup",
      mode: classifyMode(planA ? baseUrl : remoteUrl),
      timestamp: new Date().toISOString(),
    });
    flushUsageEvents();
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Setup Bridge</h1>
        <p className="hint">
          Connect your Android device to PiecesOS via <strong>Plan A</strong> (LAN proxy at home) or{" "}
          <strong>Plan B</strong> (remote gateway away). Automatic failover kicks in when away from home.
        </p>
      </div>

      <div className="card" style={{ background: "linear-gradient(135deg, rgba(99,102,241,0.12) 0%, var(--surface) 100%)", marginBottom: 16 }}>
        <div className="card-row" style={{ marginBottom: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: "var(--text)" }}>Instant QR Pairing</span>
          <span className="badge primary">Fastest</span>
        </div>
        <p className="hint" style={{ fontSize: 13, margin: "0 0 14px" }}>
          Scan the connection QR code generated by the PC proxy script to configure and test automatically.
        </p>
        <button onClick={handleScanToConnect} disabled={checking} style={{ width: "100%" }}>
          <ScanIcon size={18} />
          {checking ? "Checking…" : "Scan to Connect"}
        </button>
        {scanError && <p className="status-error" style={{ marginTop: 10, fontSize: 13 }}>{scanError}</p>}
      </div>

      <div className="setup-card">
        <div className="setup-card-header">
          <div className="setup-card-title-group">
            <div className="setup-card-icon lan">
              <WifiIcon size={18} />
            </div>
            <div>
              <div className="setup-card-title">Plan A — Home Wi-Fi</div>
              <div className="setup-card-subtitle">Fast local proxy when connected to your home network</div>
            </div>
          </div>
          <span className="badge">LAN</span>
        </div>
        <div className="setup-fields">
          <div className="input-group">
            <label className="input-label">LAN Proxy Address</label>
            <input
              type="text"
              placeholder="http://192.168.1.20:8787"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div className="input-group">
            <label className="input-label">Bearer Token (from PC)</label>
            <input
              type="password"
              placeholder="Proxy bearer token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="setup-card">
        <div className="setup-card-header">
          <div className="setup-card-title-group">
            <div className="setup-card-icon remote">
              <CloudIcon size={18} />
            </div>
            <div>
              <div className="setup-card-title">Plan B — Remote Gateway</div>
              <div className="setup-card-subtitle">Automatic failover when away from home via Tailscale</div>
            </div>
          </div>
          <span className="badge">Failover</span>
        </div>
        <div className="setup-fields">
          <div className="input-group">
            <label className="input-label">Gateway URL</label>
            <input
              type="text"
              placeholder="https://pieces.yourdomain.com"
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
            />
          </div>
          <div className="input-group">
            <label className="input-label">Device Token (from gateway enroll)</label>
            <input
              type="password"
              placeholder="Device JWT"
              value={remoteToken}
              onChange={(e) => setRemoteToken(e.target.value)}
            />
          </div>
          {(() => {
            const info = remoteToken ? decodeJwtForDisplay(remoteToken) : null;
            if (!info?.expiresAt) return null;
            const expired = info.expiresAt.getTime() < Date.now();
            return (
              <p className={`setup-note ${expired ? "status-error" : "hint"}`} style={{ fontSize: 12, margin: "6px 0 0" }}>
                Device token {formatExpiry(info.expiresAt)}
                {expired && " — re-enroll this device on the gateway."}
              </p>
            );
          })()}
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <button
          className="primary-btn-large"
          onClick={handleTestAndSave}
          disabled={checking || (!(baseUrl && token) && !(remoteUrl && remoteToken))}
          style={{ width: "100%" }}
        >
          {checking ? "Testing connection…" : "Test & Save Connection"}
        </button>
      </div>

      {result === "ok" && (
        <div className="card" style={{ marginTop: 12, borderLeft: "4px solid var(--ok)" }}>
          <div className="status-ok">
            <span className="status-pulse-live" />
            <span>Connected & Saved successfully.</span>
          </div>
        </div>
      )}

      {result === "server-only" && (
        <div className="card panel-danger" style={{ marginTop: 12 }}>
          <div className="status-ok" style={{ marginBottom: 4 }}>Saved.</div>
          <p className="status-error" style={{ fontSize: 13, margin: 0 }}>
            Server is reachable, but cannot reach your home PC right now. Check Status tab for details.
          </p>
        </div>
      )}

      {result === "unreachable" && (
        <div className="card panel-danger" style={{ marginTop: 12 }}>
          <p className="status-error" style={{ margin: 0 }}>Could not reach proxy at the specified address.</p>
        </div>
      )}

      <div className="panel">
        <Switch
          checked={screenContext}
          onChange={handleToggleScreenContext}
          label="Enable screen context"
          description="Capture on-screen text from allowed apps using Android's standard Accessibility permission."
        />
        {screenContext && (
          <div style={{ paddingTop: 8, borderTop: "1px solid var(--border-subtle)" }}>
            {accessibilityGranted ? (
              <p className="status-ok" style={{ fontSize: 13, margin: 0 }}>
                <CheckIcon size={14} /> Accessibility permission granted.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <p className="status-error" style={{ fontSize: 13, margin: 0 }}>
                  Accessibility permission not granted yet.
                </p>
                <button className="secondary" onClick={() => AccessibilityScanner.openAccessibilitySettings()}>
                  Open Accessibility Settings
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="panel">
        <Switch
          checked={notifCapture}
          onChange={handleToggleNotifCapture}
          label="Capture notifications"
          description="Stream incoming notification previews (texts, email, chat) to PiecesOS. Sensitive 2FA apps excluded."
        />
        {notifCapture && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 10, borderTop: "1px solid var(--border-subtle)" }}>
            {notifListenerGranted ? (
              <p className="status-ok" style={{ fontSize: 13, margin: 0 }}>
                <CheckIcon size={14} /> Notification access granted.
              </p>
            ) : (
              <div>
                <p className="status-error" style={{ fontSize: 13, margin: "0 0 8px" }}>
                  Notification access not granted yet.
                </p>
                <button className="secondary" onClick={() => openNotificationListenerSettings()}>
                  Open Settings
                </button>
              </div>
            )}
            <Switch
              checked={notifAllApps}
              onChange={handleToggleNotifAllApps}
              label="Capture from all apps"
              description="Capture across every app rather than only allowlisted apps."
            />
          </div>
        )}
      </div>

      <div className="panel">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>SMS History & Sync</span>
          <p className="hint" style={{ margin: 0 }}>
            Sync and backfill SMS/MMS messages exclusively from contacts you explicitly allow below.
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 8 }}>
          {!smsGranted ? (
            <div>
              <p className="status-error" style={{ fontSize: 13, margin: "0 0 8px" }}>
                SMS access not granted yet.
              </p>
              <button className="secondary" onClick={() => openSmsAppSettings()}>
                Open Settings
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="status-ok" style={{ fontSize: 13 }}>
                <CheckIcon size={14} />
                <span>SMS access granted{contactsGranted ? " · contacts readable" : ""}.</span>
              </div>
              <p className="hint" style={{ fontSize: 12, margin: 0 }}>
                Allowlist: <strong>{smsAllow.size}</strong> number{smsAllow.size === 1 ? "" : "s"} selected.
              </p>
              {!contactsGranted && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <p className="status-error" style={{ fontSize: 12, margin: 0 }}>
                    Contacts not readable — grant permission in Android Settings.
                  </p>
                  <button className="secondary pill" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => openSmsAppSettings()}>
                    Settings
                  </button>
                </div>
              )}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                <button className="secondary" onClick={handleOpenPicker} disabled={smsBusy || !contactsGranted}>
                  Choose contacts
                </button>
                <button
                  onClick={handleSmsBackfill}
                  disabled={smsBusy || smsAllow.size === 0}
                >
                  {smsBusy ? "Backfilling…" : "Backfill now"}
                </button>
                <button
                  className="secondary"
                  onClick={handleResetToRecent}
                  disabled={smsBusy || smsAllow.size === 0}
                  title="Jump directly to the last 30 days of messages"
                >
                  Sync Recent (30d)
                </button>
              </div>
            </div>
          )}

          {smsResult && <p className="status-ok" style={{ fontSize: 13 }}>{smsResult}</p>}
          {smsError && <p className="status-error" style={{ fontSize: 13 }}>{smsError}</p>}
        </div>

        {pickerOpen && (
          <div className="picker">
            <input
              type="text"
              placeholder="Filter contacts…"
              value={contactFilter}
              onChange={(e) => setContactFilter(e.target.value)}
              style={{ width: "100%", marginBottom: 8 }}
            />
            <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
              <button
                type="button"
                className="secondary"
                style={{ fontSize: "0.75rem", padding: "4px 10px" }}
                onClick={() => {
                  const visible = contacts.filter((c) =>
                    c.name.toLowerCase().includes(contactFilter.toLowerCase())
                  );
                  setSmsAllow((prev) => {
                    const next = new Set(prev);
                    for (const c of visible) {
                      for (const n of c.numbers) next.add(n);
                    }
                    return next;
                  });
                }}
              >
                Select All
              </button>
              <button
                type="button"
                className="secondary"
                style={{ fontSize: "0.75rem", padding: "4px 10px" }}
                onClick={() => {
                  const visible = contacts.filter((c) =>
                    c.name.toLowerCase().includes(contactFilter.toLowerCase())
                  );
                  setSmsAllow((prev) => {
                    const next = new Set(prev);
                    for (const c of visible) {
                      for (const n of c.numbers) next.delete(n);
                    }
                    return next;
                  });
                }}
              >
                Deselect All
              </button>
              <span className="hint" style={{ marginLeft: "auto", fontSize: "0.75rem", margin: 0 }}>
                {contacts.length} contacts
              </span>
            </div>
            <div style={{ maxHeight: 260, overflowY: "auto" }}>
              {contacts.length === 0 && <p className="hint">Loading contacts…</p>}
              {contacts
                .filter((c) =>
                  c.name.toLowerCase().includes(contactFilter.toLowerCase())
                )
                .map((c) => {
                  const on = c.numbers.length > 0 && c.numbers.every((n) => smsAllow.has(n));
                  return (
                    <label key={`${c.name}:${c.numbers.join(",")}`} className="app-row">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleContactNumbers(c.numbers)}
                      />
                      <span>
                        {c.name}
                        {c.numbers.length > 1 && (
                          <span className="hint"> ({c.numbers.length} numbers)</span>
                        )}
                      </span>
                    </label>
                  );
                })}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button onClick={handleSaveAllowlist} disabled={smsBusy}>
                {smsBusy ? "Saving…" : "Save allowlist"}
              </button>
              <button className="secondary" onClick={() => setPickerOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
