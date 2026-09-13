import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { registerPlugin } from "@capacitor/core";
import { BarcodeScanner } from "@capacitor-mlkit/barcode-scanning";

const ShizukuMonitor = registerPlugin<any>('ShizukuMonitor');
const AccessibilityScanner = registerPlugin<any>('AccessibilityScanner');
import {
  getProxyBaseUrl, getProxyToken, setProxyBaseUrl, setProxyToken,
  getRemoteGatewayUrl, getRemoteGatewayToken, setRemoteGatewayUrl, setRemoteGatewayToken,
  isShizukuToolkitEnabled, setShizukuToolkitEnabled,
  isScreenContextEnabled, setScreenContextEnabled,
} from "../lib/config";
import { checkProxyHealth, getStatus, HomeNodeUnreachableError } from "../lib/api";
import { recordEvent, classifyMode } from "../lib/usage";
import { flushUsageEvents } from "../lib/flush";
import { parseConnectionQrPayload } from "../lib/connectionQr";
import { decodeJwtForDisplay, formatExpiry } from "../lib/jwtDisplay";
import {
  isNotificationListenerGranted, getNotificationCaptureConfig, setNotificationCapture,
  grantNotificationListenerViaShizuku, openNotificationListenerSettings,
  startNotificationCaptureListener,
} from "../lib/notificationCapture";
import {
  smsPermissions, grantSmsViaShizuku, runSmsBackfill,
  listSmsContacts, getSmsAllowlist, setSmsAllowlist, type SmsContact,
} from "../lib/smsBackfill";

export default function Setup() {
  const navigate = useNavigate();
  // Plan A (LAN)
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  // Plan B (remote gateway) — optional; auto-failover target
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteToken, setRemoteToken] = useState("");
  const [checking, setChecking] = useState(false);
  // "ok" = full end-to-end chain verified (proxy/gateway -> PiecesOS).
  // "server-only" = the proxy/gateway process answers but PiecesOS itself
  // doesn't - previously this was indistinguishable from "ok", since the
  // save flow only ever checked checkProxyHealth()'s unauthenticated
  // /mobile/health, which proves nothing about the home PC. Found in
  // practice 2026-08-29: Setup said "Connected" while Status simultaneously
  // said "Home PC is offline."
  const [result, setResult] = useState<"idle" | "ok" | "server-only" | "unreachable">("idle");
  const [scanError, setScanError] = useState<string | null>(null);
  const [shizukuToolkit, setShizukuToolkit] = useState(false);
  const [screenContext, setScreenContext] = useState(false);
  const [accessibilityGranted, setAccessibilityGranted] = useState(false);

  // Part 1: notification capture
  const [notifCapture, setNotifCapture] = useState(false);
  const [notifAllApps, setNotifAllApps] = useState(false);
  const [notifListenerGranted, setNotifListenerGranted] = useState(false);
  const [notifBusy, setNotifBusy] = useState(false);
  const [notifError, setNotifError] = useState<string | null>(null);

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
      const [savedUrl, savedToken, savedRemoteUrl, savedRemoteToken, toolkitEnabled, contextEnabled] =
        await Promise.all([
          getProxyBaseUrl(), getProxyToken(),
          getRemoteGatewayUrl(), getRemoteGatewayToken(),
          isShizukuToolkitEnabled(), isScreenContextEnabled(),
        ]);
      if (savedUrl) setBaseUrl(savedUrl);
      if (savedToken) setToken(savedToken);
      if (savedRemoteUrl) setRemoteUrl(savedRemoteUrl);
      if (savedRemoteToken) setRemoteToken(savedRemoteToken);
      setShizukuToolkit(toolkitEnabled);
      setScreenContext(contextEnabled);
    })();
    AccessibilityScanner.isAccessibilityServiceEnabled().then((r: any) => setAccessibilityGranted(r.enabled));
    refreshNotifState();
    refreshSmsState();
    recordEvent({ type: "screen_view", screen: "setup", timestamp: new Date().toISOString() });
    flushUsageEvents();
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

  async function handleGrantNotifListener() {
    setNotifBusy(true);
    setNotifError(null);
    try {
      await grantNotificationListenerViaShizuku();
      await refreshNotifState();
    } catch (e) {
      setNotifError(e instanceof Error ? e.message : String(e));
    }
    setNotifBusy(false);
  }

  async function handleGrantSms() {
    setSmsBusy(true);
    setSmsError(null);
    try {
      const { sms, contacts: c } = await grantSmsViaShizuku();
      setSmsGranted(sms);
      setContactsGranted(c);
      await refreshSmsState();
    } catch (e) {
      setSmsError(e instanceof Error ? e.message : String(e));
    }
    setSmsBusy(false);
  }

  async function handleOpenPicker() {
    setSmsError(null);
    setPickerOpen(true);
    if (contacts.length === 0) {
      try {
        setContacts(await listSmsContacts());
      } catch (e) {
        setSmsError(e instanceof Error ? e.message : String(e));
        setPickerOpen(false);
      }
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

  async function handleToggleScreenContext(next: boolean) {
    setScreenContext(next);
    await setScreenContextEnabled(next);
    try {
      await AccessibilityScanner.setScreenContextEnabled({ enabled: next });
    } catch (e) {
      console.warn("[Accessibility] setScreenContextEnabled failed", e);
    }
  }

  async function handleToggleShizuku(next: boolean) {
    setShizukuToolkit(next);
    await setShizukuToolkitEnabled(next);
    try {
      await ShizukuMonitor.setToolkitEnabled({ enabled: next });
    } catch (e) {
      console.warn("[Shizuku] setToolkitEnabled failed", e);
    }
    if (next) {
      // First-enable: try to turn on the accessibility service right away
      // rather than waiting for the next app launch. Best-effort — if
      // Shizuku isn't granted yet, the Status tab will surface that.
      try {
        await ShizukuMonitor.enableAccessibilityService();
      } catch (e) {
        console.warn("[Shizuku] enableAccessibilityService failed (grant Shizuku permission first)", e);
      }
    }
  }

  // Runs AFTER the shallow checkProxyHealth() pass and AFTER saving, since
  // getStatus() reads from the just-saved config, not from function
  // arguments - this proves the FULL chain (proxy/gateway -> PiecesOS), not
  // just that the gateway process itself is up. Never throws: a deep-check
  // failure downgrades the already-"ok" shallow result to "server-only"
  // rather than failing setup entirely, since the shallow health check
  // already succeeded and the config is already saved correctly.
  async function deepCheckAfterSave(): Promise<"ok" | "server-only"> {
    try {
      await getStatus();
      return "ok";
    } catch (e) {
      if (e instanceof HomeNodeUnreachableError) return "server-only";
      // Any other error here (unexpected shape, etc.) is still evidence
      // the deep chain isn't fully healthy - treat it the same way rather
      // than silently claiming "ok".
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
      if (!raw) {
        // User backed out of the scanner without capturing a code - not an
        // error worth surfacing, just a no-op.
        return;
      }

      const { baseUrl: scannedUrl, token: scannedToken } = parseConnectionQrPayload(raw);
      setBaseUrl(scannedUrl);
      setToken(scannedToken);
      // Mirrors handleTestAndSave's own test-then-save sequencing, so a
      // successful scan behaves exactly like a successful manual entry +
      // tap of "Test & Save" - no separate save step for the user to forget.
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
        // Deep check (up to ~35s on a retry) deliberately happens while
        // `checking` is still true - button stays disabled and shows
        // "Checking…" for the FULL flow, not just the fast shallow check.
        // Previously setChecking(false) fired here, which re-enabled the
        // button and let a second scan start concurrently with this one
        // still finishing.
        setResult(await deepCheckAfterSave());
        await recordEvent({
          type: "setup_saved",
          screen: "setup",
          mode: classifyMode(scannedUrl),
          timestamp: new Date().toISOString(),
        });
        flushUsageEvents();
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

    // At least one profile must be fully filled. Prefer to verify Plan A if
    // it's set; otherwise verify Plan B.
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

    // Save whichever profiles are complete; clear the ones that aren't so a
    // half-filled profile can't shadow a working one in the failover list.
    await setProxyBaseUrl(planA ? baseUrl.trim() : "");
    await setProxyToken(planA ? token.trim() : "");
    await setRemoteGatewayUrl(planB ? remoteUrl.trim() : "");
    await setRemoteGatewayToken(planB ? remoteToken.trim() : "");

    setResult(await deepCheckAfterSave());
    setChecking(false);

    if (shizukuToolkit) {
      try {
        const res = await ShizukuMonitor.executeCommand({ command: "dumpsys meminfo" });
        await recordEvent({
          type: "system_telemetry",
          screen: "background",
          telemetry: res.output,
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        console.warn("[Shizuku] Auto-init failed (Is the daemon started?)", e);
      }
    }

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
      <h1>Setup</h1>
      <p className="hint">
        Fill in <strong>Plan A</strong> for home Wi-Fi, <strong>Plan B</strong> for away, or both —
        the app tries Plan A first and falls over to Plan B automatically (on timeout, a refused
        connection, a stale token, or a server error). Either one alone is a valid setup.
      </p>

      <button onClick={handleScanToConnect} disabled={checking}>
        Scan to Connect
      </button>
      <p className="hint setup-note">
        Fastest option for Plan A: scan a connection code shown by the LAN proxy's companion
        setup script. Fills in Plan A and saves automatically.
      </p>
      {scanError && <p className="status-error">{scanError}</p>}

      <fieldset style={{ border: "1px solid var(--border, #333)", borderRadius: 8, padding: 12, marginTop: 8 }}>
        <legend><strong>Plan A — home Wi-Fi (LAN proxy)</strong></legend>
        <label>
          LAN proxy address
          <input
            type="text"
            placeholder="http://192.168.1.20:8787"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
        <label>
          Bearer token (from that PC)
          <input type="password" placeholder="proxy bearer token" value={token}
            onChange={(e) => setToken(e.target.value)} />
        </label>
      </fieldset>

      <fieldset style={{ border: "1px solid var(--border, #333)", borderRadius: 8, padding: 12, marginTop: 8 }}>
        <legend><strong>Plan B — away (remote gateway)</strong></legend>
        <label>
          Gateway URL
          <input
            type="text"
            placeholder="https://pieces.yourdomain.com"
            value={remoteUrl}
            onChange={(e) => setRemoteUrl(e.target.value)}
          />
        </label>
        <label>
          Device token (from the gateway's enroll command)
          <input type="password" placeholder="device JWT" value={remoteToken}
            onChange={(e) => setRemoteToken(e.target.value)} />
        </label>
        {(() => {
          // Gateway tokens are JWTs (365-day expiry, apps/pieces-gateway/src/jwt.ts).
          const info = remoteToken ? decodeJwtForDisplay(remoteToken) : null;
          if (!info?.expiresAt) return null;
          const expired = info.expiresAt.getTime() < Date.now();
          return (
            <p className={`setup-note ${expired ? "status-error" : "hint"}`}>
              Device token {formatExpiry(info.expiresAt)}
              {expired && " — re-enroll this device on the gateway."}
            </p>
          );
        })()}
      </fieldset>

      <button
        onClick={handleTestAndSave}
        disabled={checking || (!(baseUrl && token) && !(remoteUrl && remoteToken))}
      >
        {checking ? "Checking…" : "Test & Save"}
      </button>

      {result === "ok" && <p className="status-ok">Connected. Saved.</p>}
      {result === "server-only" && (
        <>
          <p className="status-ok">Saved.</p>
          <p className="status-error">
            But the server can't reach your home PC right now (it may just be starting up, or
            genuinely offline). Check Status for details — you don't need to redo Setup, this
            usually clears on its own.
          </p>
        </>
      )}
      {result === "unreachable" && <p className="status-error">Could not reach proxy at that address.</p>}

      <div className="panel">
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={screenContext}
            onChange={(e) => handleToggleScreenContext(e.target.checked)}
          />
          <strong>Enable screen context</strong>
        </label>
        <p className="hint" style={{ margin: 0 }}>
          Off by default. Turning this on lets you pick specific apps (in the Status tab's
          app picker) whose on-screen text gets captured and sent to PiecesOS as context.
          No Shizuku required — just Android's standard Accessibility permission, same
          mechanism screen readers use. You'll need to grant it once in system Settings.
        </p>
        {screenContext && (
          <div>
            {accessibilityGranted ? (
              <p className="status-ok" style={{ margin: 0 }}>Accessibility permission granted.</p>
            ) : (
              <>
                <p className="status-error" style={{ margin: "0 0 8px 0" }}>
                  Accessibility permission not granted yet.
                </p>
                <button onClick={() => AccessibilityScanner.openAccessibilitySettings()}>
                  Open Accessibility Settings
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="panel">
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={shizukuToolkit}
            onChange={(e) => handleToggleShizuku(e.target.checked)}
          />
          <strong>Enable Shizuku toolkit (advanced)</strong>
        </label>
        <p className="hint" style={{ margin: 0 }}>
          Off by default. Turning this on lets the app run privileged diagnostic commands
          via Shizuku, and auto-re-enable screen context's Accessibility permission if it
          gets dropped (e.g. after a reboot) instead of you having to re-grant it manually.
          Not required for screen context itself — only useful if you want the diagnostics
          toolkit or the auto-re-enable convenience. Requires the Shizuku app installed and
          its daemon running.
        </p>
      </div>

      <div className="panel">
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={notifCapture}
            onChange={(e) => handleToggleNotifCapture(e.target.checked)}
          />
          <strong>Capture notifications</strong>
        </label>
        <p className="hint" style={{ margin: 0 }}>
          Off by default. Streams every app's notification previews (texts, chat, email,
          Slack…) to PiecesOS as they arrive — one live feed across all apps. Preview text
          only; full message bodies for SMS come from the SMS History section below.
          Banking / 2FA / password apps are always excluded.
        </p>
        {notifCapture && (
          <div style={{ marginTop: 8 }}>
            {notifListenerGranted ? (
              <p className="status-ok" style={{ margin: "0 0 8px 0" }}>
                Notification access granted.
              </p>
            ) : (
              <>
                <p className="status-error" style={{ margin: "0 0 8px 0" }}>
                  Notification access not granted yet.
                </p>
                <button onClick={handleGrantNotifListener} disabled={notifBusy}>
                  {notifBusy ? "Granting…" : "Grant via Shizuku"}
                </button>
                <button
                  onClick={() => openNotificationListenerSettings()}
                  style={{ marginLeft: 8 }}
                >
                  Open Settings
                </button>
              </>
            )}
            {notifError && <p className="status-error" style={{ margin: "8px 0 0 0" }}>{notifError}</p>}
            <label className="toggle-row" style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                checked={notifAllApps}
                onChange={(e) => handleToggleNotifAllApps(e.target.checked)}
              />
              <span>Capture from <strong>all</strong> apps (not just the picked ones)</span>
            </label>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="toggle-row">
          <strong>SMS history</strong>
        </div>
        <p className="hint" style={{ margin: 0 }}>
          Full text bodies + a backfill of existing SMS/MMS, but only from the contacts you
          pick below. Everything else — OTP shortcodes, spam, unknown numbers — is left out.
        </p>
        <div style={{ marginTop: 8 }}>
          {!smsGranted ? (
            <>
              <p className="status-error" style={{ margin: "0 0 8px 0" }}>
                SMS access not granted yet.
              </p>
              <button onClick={handleGrantSms} disabled={smsBusy}>
                {smsBusy ? "Granting…" : "Grant via Shizuku"}
              </button>
            </>
          ) : (
            <>
              <p className="status-ok" style={{ margin: "0 0 8px 0" }}>
                SMS access granted{contactsGranted ? " · contacts readable" : ""}.
              </p>
              <p className="hint" style={{ margin: "0 0 8px 0" }}>
                Allowlist: <strong>{smsAllow.size}</strong> number{smsAllow.size === 1 ? "" : "s"} selected.
              </p>
              {!contactsGranted && (
                <p className="status-error" style={{ margin: "0 0 8px 0" }}>
                  Contacts not readable — tap "Grant via Shizuku" again to add READ_CONTACTS.
                </p>
              )}
              <button onClick={handleOpenPicker} disabled={smsBusy || !contactsGranted}>
                Choose contacts
              </button>
              <button
                onClick={handleSmsBackfill}
                disabled={smsBusy || smsAllow.size === 0}
                style={{ marginLeft: 8 }}
              >
                {smsBusy ? "Backfilling…" : "Backfill now"}
              </button>
            </>
          )}
          {smsResult && <p className="status-ok" style={{ margin: "8px 0 0 0" }}>{smsResult}</p>}
          {smsError && <p className="status-error" style={{ margin: "8px 0 0 0" }}>{smsError}</p>}
        </div>

        {pickerOpen && (
          <div style={{ marginTop: 12, borderTop: "1px solid var(--border, #333)", paddingTop: 12 }}>
            <input
              type="text"
              placeholder="Filter contacts…"
              value={contactFilter}
              onChange={(e) => setContactFilter(e.target.value)}
              style={{ width: "100%", marginBottom: 8 }}
            />
            <div style={{ maxHeight: 260, overflowY: "auto" }}>
              {contacts.length === 0 && <p className="hint">Loading contacts…</p>}
              {contacts
                .filter((c) =>
                  c.name.toLowerCase().includes(contactFilter.toLowerCase())
                )
                .slice(0, 300)
                .map((c) => {
                  const on = c.numbers.length > 0 && c.numbers.every((n) => smsAllow.has(n));
                  return (
                    <label key={`${c.name}:${c.numbers.join(",")}`} className="toggle-row" style={{ padding: "4px 0" }}>
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
            <div style={{ marginTop: 8 }}>
              <button onClick={handleSaveAllowlist} disabled={smsBusy}>
                {smsBusy ? "Saving…" : "Save allowlist"}
              </button>
              <button onClick={() => setPickerOpen(false)} style={{ marginLeft: 8 }}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <nav className="tabbar">
        <button onClick={() => navigate("/status")}>Status</button>
        <button onClick={() => navigate("/ask")}>Ask</button>
        <button onClick={() => navigate("/recent")}>Recent</button>
        <button onClick={() => navigate("/search")}>Search</button>
      </nav>
    </div>
  );
}
