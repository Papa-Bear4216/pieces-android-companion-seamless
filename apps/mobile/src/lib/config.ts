import { Preferences } from "@capacitor/preferences";

// Dual-profile connection (merged from shizuku-monitor):
//  - Plan A (LAN / USB): fast local path, e.g. http://192.168.1.x:8787
//  - Plan B (Remote gateway): automatic fallback via Tailscale, e.g.
//    https://pieces.yourdomain.com  (a device JWT, not the LAN bearer)
// api.ts / flush.ts try Plan A first, fall over to Plan B on timeout, refused
// connection, 401/403, or 5xx. Either profile alone is a valid config.
//
// Uses Capacitor's Preferences plugin (native storage) rather than
// localStorage — these tokens are real credentials, not UI state.

const PROXY_BASE_URL_KEY = "pieces-android:proxyBaseUrl";
const PROXY_TOKEN_KEY = "pieces-android:proxyToken";
const REMOTE_GATEWAY_URL_KEY = "pieces-android:remoteGatewayUrl";
const REMOTE_GATEWAY_TOKEN_KEY = "pieces-android:remoteGatewayToken";
const SHIZUKU_ENABLED_KEY = "pieces-android:shizukuToolkitEnabled";
const SCREEN_CONTEXT_ENABLED_KEY = "pieces-android:screenContextEnabled";
const NOTIFICATION_CAPTURE_ENABLED_KEY = "pieces-android:notificationCaptureEnabled";
const SMS_BACKFILL_HIGH_WATER_KEY = "pieces-android:smsBackfillHighWater";

export async function getProxyBaseUrl(): Promise<string | null> {
  const { value } = await Preferences.get({ key: PROXY_BASE_URL_KEY });
  return value;
}

export async function setProxyBaseUrl(url: string): Promise<void> {
  await Preferences.set({ key: PROXY_BASE_URL_KEY, value: url.replace(/\/$/, "") });
}

export async function getProxyToken(): Promise<string | null> {
  const { value } = await Preferences.get({ key: PROXY_TOKEN_KEY });
  return value;
}

export async function setProxyToken(token: string): Promise<void> {
  await Preferences.set({ key: PROXY_TOKEN_KEY, value: token });
}

export async function getRemoteGatewayUrl(): Promise<string | null> {
  const { value } = await Preferences.get({ key: REMOTE_GATEWAY_URL_KEY });
  return value;
}

export async function setRemoteGatewayUrl(url: string): Promise<void> {
  await Preferences.set({ key: REMOTE_GATEWAY_URL_KEY, value: url.replace(/\/$/, "") });
}

export async function getRemoteGatewayToken(): Promise<string | null> {
  const { value } = await Preferences.get({ key: REMOTE_GATEWAY_TOKEN_KEY });
  return value;
}

export async function setRemoteGatewayToken(token: string): Promise<void> {
  await Preferences.set({ key: REMOTE_GATEWAY_TOKEN_KEY, value: token });
}

export interface ConnectionTarget {
  baseUrl: string;
  token: string;
  mode: "lan" | "remote";
}

/** Ordered [Plan A, Plan B], each included only if both its URL and token are set. */
export async function getConnectionTargets(): Promise<ConnectionTarget[]> {
  const [lanUrl, lanToken, remoteUrl, remoteToken] = await Promise.all([
    getProxyBaseUrl(), getProxyToken(), getRemoteGatewayUrl(), getRemoteGatewayToken(),
  ]);
  const targets: ConnectionTarget[] = [];
  if (lanUrl && lanToken) targets.push({ baseUrl: lanUrl, token: lanToken, mode: "lan" });
  if (remoteUrl && remoteToken) targets.push({ baseUrl: remoteUrl, token: remoteToken, mode: "remote" });
  return targets;
}

export async function isConfigured(): Promise<boolean> {
  return (await getConnectionTargets()).length > 0;
}

export async function clearConfig(): Promise<void> {
  await Promise.all([
    Preferences.remove({ key: PROXY_BASE_URL_KEY }),
    Preferences.remove({ key: PROXY_TOKEN_KEY }),
    Preferences.remove({ key: REMOTE_GATEWAY_URL_KEY }),
    Preferences.remove({ key: REMOTE_GATEWAY_TOKEN_KEY }),
  ]);
}

// Off by default. The Shizuku toolkit (privileged shell diagnostics + the
// system-wide accessibility screen-text capture) is powerful enough that it
// must be an explicit, informed opt-in — never auto-enabled just because the
// Shizuku app happens to be installed and granted.
export async function isShizukuToolkitEnabled(): Promise<boolean> {
  const { value } = await Preferences.get({ key: SHIZUKU_ENABLED_KEY });
  return value === "true";
}

export async function setShizukuToolkitEnabled(enabled: boolean): Promise<void> {
  await Preferences.set({ key: SHIZUKU_ENABLED_KEY, value: String(enabled) });
}

// Independent of Shizuku. Screen-context capture only needs Android's
// standard Accessibility Service permission — a manual one-time toggle in
// system Settings, same mechanism screen readers and password managers use.
// Off by default, same reasoning as the Shizuku toolkit: this is powerful
// enough that it must be an explicit, informed opt-in.
export async function isScreenContextEnabled(): Promise<boolean> {
  const { value } = await Preferences.get({ key: SCREEN_CONTEXT_ENABLED_KEY });
  return value === "true";
}

export async function setScreenContextEnabled(enabled: boolean): Promise<void> {
  await Preferences.set({ key: SCREEN_CONTEXT_ENABLED_KEY, value: String(enabled) });
}

// Part 1: notification listener master switch. Off by default, same reasoning
// as the others — this captures every app's notification content, so it must
// be an explicit opt-in, and the native service also fail-closes on this flag.
export async function isNotificationCaptureEnabled(): Promise<boolean> {
  const { value } = await Preferences.get({ key: NOTIFICATION_CAPTURE_ENABLED_KEY });
  return value === "true";
}

export async function setNotificationCaptureEnabled(enabled: boolean): Promise<void> {
  await Preferences.set({ key: NOTIFICATION_CAPTURE_ENABLED_KEY, value: String(enabled) });
}

// Part 2: SMS backfill high-water mark (epoch millis of the newest message
// already ingested). 0 = nothing backfilled yet, next run pulls all history.
// Advanced page-by-page so a crash mid-backfill resumes rather than restarts.
export async function getSmsBackfillHighWater(): Promise<number> {
  const { value } = await Preferences.get({ key: SMS_BACKFILL_HIGH_WATER_KEY });
  const n = value ? Number(value) : 0;
  return Number.isFinite(n) ? n : 0;
}

export async function setSmsBackfillHighWater(millis: number): Promise<void> {
  await Preferences.set({ key: SMS_BACKFILL_HIGH_WATER_KEY, value: String(millis) });
}
