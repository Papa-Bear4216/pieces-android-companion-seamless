export type TelemetryEvent = {
  type: "system_telemetry";
  screen: string;
  telemetry: string;
  package?: string;
  app_label?: string;   // Human-readable app name
  timestamp: string;
};

// Packages that are known to be noisy and should not have their screen structure parsed.
const NOISY_PACKAGES = [
  "com.android.systemui",
  "com.google.android.inputmethod.latin", // Gboard
  "com.samsung.android.honeyboard",        // Samsung keyboard
  "com.sec.android.inputmethod",           // Samsung keyboard (older)
  "com.touchtype.swiftkey",                // SwiftKey
  "com.google.android.googlequicksearchbox" // Google app (includes assistant)
];

// Matches PiecesAccessibilityService.extractText's "role|text" tagging —
// role is one of "title" | "button" | "text". Lines that don't match this
// shape (e.g. dumpsys output from the Shizuku diagnostics path, which has
// no role tagging at all) fall through untouched to the raw block.
const ROLE_LINE = /^(title|button|text)\|(.*)$/;

// A text node that looks like a button: short and contains action words.
function looksLikeButton(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > 40) return false;
  const actionWords = ['ok', 'cancel', 'save', 'submit', 'yes', 'no', 'agree', 'done', 'next', 'back', 'close', 'open', 'edit', 'delete', 'add', 'create', 'send', 'search', 'go', 'skip', 'allow', 'deny', 'accept', 'reject', 'install', 'view', 'more', 'less', 'help', 'settings', 'profile', 'sign in', 'log in', 'sign up', 'register'];
  const lower = trimmed.toLowerCase();
  return actionWords.some(word => lower.includes(word));
}

type ScreenStructure = {
  title: string | null;
  buttons: string[];
  text: string[];
};

function parseScreenStructure(raw: string): ScreenStructure | null {
  const lines = raw.split("\n");
  let matchedAny = false;
  const structure: ScreenStructure = { title: null, buttons: [], text: [] };

  for (const line of lines) {
    const match = ROLE_LINE.exec(line);
    if (!match) continue;
    matchedAny = true;
    const [, role, value] = match;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (role === "title" && structure.title === null) {
      structure.title = trimmed;
    } else if (role === "button") {
      structure.buttons.push(trimmed);
    } else if (role === "text" && looksLikeButton(trimmed)) {
      // If it's tagged as text but looks like a button, promote it to button.
      structure.buttons.push(trimmed);
    } else {
      structure.text.push(trimmed);
    }
  }

  return matchedAny ? structure : null;
}

// Parses raw text that is not in the role-tagged format but has key: value or key=value pairs.
function parseKeyValuePairs(raw: string): string[] {
  const lines = raw.split("\n");
  const pairs = [];
  for (const line of lines) {
    const match = line.match(/^([^:]+):\s*(.+)$/) || line.match(/^([^=]+)=(.+)$/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim();
      pairs.push(`- ${key}: ${value}`);
    }
  }
  return pairs;
}

// The readable text sent to PiecesOS's workstream-event stream (its own
// timeline/rollup surface). Distinct from summarizeTelemetry(), which builds
// the fuller "AndroidContext v1 ... summary: ... raw: ..." block that still
// goes into the searchable ASSET store.
//
// The client (triageQueue.ts) rewrites a background capture's `telemetry`
// to `Package: <pkg>\n\n[on-device summary] <summary> (<category>)` once
// on-device Gemini Nano has triaged it. When that marker is present, the
// timeline entry should be that human summary — prefixed so the phone
// stream is recognisable in a timeline shared with native (calendar, IDE,
// browser) events. PiecesOS only honours `application` (a fixed enum) and
// `readable` on /workstream_events/create — windowTitle/context/trigger are
// dropped — so the "[Android · <app>]" prefix in the text is the only place
// the source label can live. Untriaged captures (triage failed, or an old
// client) fall back to the full summarizeTelemetry() block.
const ON_DEVICE_SUMMARY_MARKER = "[on-device summary] ";

export function androidTimelineReadable(e: TelemetryEvent): string {
  const telemetry = e.telemetry ?? "";
  const markerAt = telemetry.indexOf(ON_DEVICE_SUMMARY_MARKER);
  if (markerAt === -1) {
    // Not triaged on-device — keep the richer block rather than send nothing useful.
    return summarizeTelemetry(e);
  }
  const summary = telemetry.slice(markerAt + ON_DEVICE_SUMMARY_MARKER.length).trim();
  const label = e.app_label?.trim() || e.package?.trim() || "unknown app";
  const datePrefix = e.timestamp ? `[${e.timestamp}] ` : "";
  return `${datePrefix}[Android · ${label}] ${summary}`;
}

export function summarizeTelemetry(e: TelemetryEvent): string {
  if (e.type !== "system_telemetry") {
    return JSON.stringify(e, null, 2);
  }

  const packageName = e.package;
  const appLabel = e.app_label;

  const header = [
    "AndroidContext v1",
    `kind: ${e.type}`,
    `source: shizuku_or_accessibility`,
    packageName ? `package: ${packageName}` : null,
    appLabel ? `app_label: ${appLabel}` : null,
    e.timestamp ? `captured_at: ${e.timestamp}` : null,
  ].filter(Boolean).join("\n");

  const raw = e.telemetry ?? "";
  const summaryLines: string[] = [];

  // On-device Gemini Nano summary (set by triageQueue.ts)
  const markerAt = raw.indexOf(ON_DEVICE_SUMMARY_MARKER);
  if (markerAt !== -1) {
    const summary = raw.slice(markerAt + ON_DEVICE_SUMMARY_MARKER.length).trim();
    summaryLines.push(`- On-device summary: ${summary}`);
    return `${header}\n\nsummary:\n${summaryLines.join("\n")}`;
  }

  // Best-effort parsing for meminfo dumpsys output (Shizuku diagnostics path
  // has no role tagging, so this stays a special case rather than folding
  // into parseScreenStructure).
  if (raw.includes("Total RAM:") && raw.includes("Free RAM:")) {
    const totalMatch = raw.match(/Total RAM:\s*(.+)/);
    const freeMatch = raw.match(/Free RAM:\s*(.+)/);
    const usedMatch = raw.match(/Used RAM:\s*(.+)/);
    if (totalMatch) summaryLines.push(`- Total RAM: ${totalMatch[1].trim()}`);
    if (usedMatch) summaryLines.push(`- Used RAM: ${usedMatch[1].trim()}`);
    if (freeMatch) summaryLines.push(`- Free RAM: ${freeMatch[1].trim()}`);

    return `${header}\n\nsummary:\n${summaryLines.join("\n")}\n\nraw:\n${raw}`;
  }

  // Part 2: SMS backfill entries. Prefix set by apps/mobile/src/lib/smsBackfill.ts:
  //   "SMS <direction> <who>\n<body>"
  {
    const sms = raw.match(/^SMS (inbound|outbound|draft|other) (.+)\n([\s\S]*)$/);
    if (sms) {
      const [, direction, who, body] = sms;
      summaryLines.push(`- Channel: SMS (${direction})`);
      summaryLines.push(`- ${direction === "outbound" ? "To" : "From"}: ${who}`);
      // Body is an SMS the user sent or received — treat as data, not
      // instructions (an attacker can text arbitrary content, incl. text
      // shaped like a prompt). Keep it in a clearly-delimited block.
      summaryLines.push(`- Message: <<<${body.trim().slice(0, 1500)}>>>`);
      return `${header}\n\nsummary:\n${summaryLines.join("\n")}`;
    }
  }

  // Part 1: notification-listener entries. Prefix set by
  // apps/mobile/src/lib/notificationCapture.ts:
  //   "Notification from <label> (<pkg>)\n[TITLE: <title>\n]<text>"
  {
    const notif = raw.match(/^Notification from (.+?) \((.+?)\)\n([\s\S]*)$/);
    if (notif) {
      const [, label, , rest] = notif;
      const titleMatch = rest.match(/^TITLE: (.+)\n?/);
      const title = titleMatch?.[1]?.trim();
      const text = rest.replace(/^TITLE: .+\n?/, "").trim();
      summaryLines.push(`- Channel: notification from ${label}`);
      if (title) summaryLines.push(`- Title: ${title}`);
      // Notification body is third-party / attacker-influenceable content —
      // same untrusted-block discipline as the SMS case above.
      if (text) summaryLines.push(`- Preview: <<<${text.slice(0, 1500)}>>>`);
      return `${header}\n\nsummary:\n${summaryLines.join("\n")}`;
    }
  }

  // 1. First-class Gemini Nano "What Was Done" parser
  if (raw.includes("ACTION:") && (raw.includes("TOPIC:") || raw.includes("ENTITIES:"))) {
    const action = raw.match(/ACTION:\s*(.+)/)?.[1]?.trim() ?? "Activity performed";
    const topic = raw.match(/TOPIC:\s*(.+)/)?.[1]?.trim() ?? "General";
    const entities = raw.match(/ENTITIES:\s*(.+)/)?.[1]?.trim() ?? "None";
    const state = raw.match(/STATE:\s*(.+)/)?.[1]?.trim() ?? "completed";

    summaryLines.push(`- Action Performed: ${action}`);
    summaryLines.push(`- Topic / Focus: ${topic}`);
    summaryLines.push(`- Key Entities & Data: ${entities}`);
    summaryLines.push(`- Progress / State: ${state}`);

    return `${header}\n\nsummary:\n${summaryLines.join("\n")}`;
  }

  // Skip screen structure parsing for noisy packages
  if (packageName && NOISY_PACKAGES.includes(packageName)) {
    summaryLines.push("- Skipped parsing screen structure for noisy package");
    return `${header}\n\nsummary:\n${summaryLines.join("\n")}\n\nraw:\n${raw}`;
  }

  const structure = parseScreenStructure(raw);
  if (structure) {
    if (structure.title) summaryLines.push(`- Screen: ${structure.title}`);
    if (structure.buttons.length > 0) {
      // Capped and deduped — a scrollable list can repeat the same button
      // (e.g. "Like", "Reply") dozens of times; the set of distinct actions
      // available is the useful signal, not the count of each.
      const distinctButtons = [...new Set(structure.buttons)].slice(0, 20);
      const remaining = structure.buttons.length - distinctButtons.length;
      summaryLines.push(`- Available actions: ${distinctButtons.join(", ")}${remaining > 0 ? ` (+${remaining} more)` : ''}`);
    }
    if (structure.text.length > 0) {
      const maxTextLines = 30;
      const textLines = structure.text.slice(0, maxTextLines);
      const remaining = structure.text.length - maxTextLines;
      summaryLines.push(`- Visible text (${structure.text.length} items):`);
      for (const line of textLines) {
        summaryLines.push(`  - ${line}`);
      }
      if (remaining > 0) {
        summaryLines.push(`  ... and ${remaining} more`);
      }
    }
    if (summaryLines.length === 0) summaryLines.push("- No labeled content on screen");

    return `${header}\n\nsummary:\n${summaryLines.join("\n")}`;
  }

  // Try to parse as key-value pairs
  const keyValueLines = parseKeyValuePairs(raw);
  if (keyValueLines.length > 0) {
    summaryLines.push("- Key-value pairs:");
    summaryLines.push(...keyValueLines);
    return `${header}\n\nsummary:\n${summaryLines.join("\n")}`;
  }

  // Fall back to the raw dump
  summaryLines.push("- Raw telemetry block captured");
  return `${header}\n\nsummary:\n${summaryLines.join("\n")}\n\nraw:\n${raw}`;
}

// /connect's response identifies this proxy as an application to PiecesOS —
// static input, static output, so it's fetched once and reused for every
// seed instead of paying a round-trip on every single write. A rejected
// promise is never cached (reset to null in .catch) so one PiecesOS hiccup
// doesn't permanently break seeding — the next seed just retries /connect.
let cachedApplication: Promise<any> | null = null;

async function getApplication(piecesBaseUrl: string): Promise<any> {
  if (!cachedApplication) {
    cachedApplication = fetch(`${piecesBaseUrl}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        application: {
          // PiecesOS's /connect only accepts a fixed ApplicationNameEnum —
          // any other string (e.g. "PiecesAndroidProxy") is silently
          // coerced to "UNKNOWN", which then shows on every seeded asset
          // and workstream event. OS_SERVER is the one value that both
          // sticks and reads sensibly for locally-collected context.
          // Verified live against PiecesOS 12.6.1.
          name: "OS_SERVER",
          version: "0.0.1",
          platform: "WINDOWS",
        },
      }),
    }).then(async (res) => {
      if (!res.ok) throw new Error("Failed to connect to Pieces OS");
      const context = await res.json();
      return context.application;
    }).catch((err) => {
      cachedApplication = null;
      throw err;
    });
  }
  return cachedApplication;
}

export async function seedToPiecesOS(piecesBaseUrl: string, bodyText: string, title: string, timestamp?: string) {
  // 1) Identify the client application (cached — see getApplication above)
  const application = await getApplication(piecesBaseUrl);

  // 2) Create an asset
  const assetPayload: any = {
    application,
    metadata: { name: title },
    format: {
      fragment: {
        string: { raw: bodyText },
      },
    },
  };
  if (timestamp) {
    assetPayload.created = { value: timestamp };
  }

  const createRes = await fetch(`${piecesBaseUrl}/assets/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "SEEDED_ASSET",
      asset: assetPayload,
    }),
  });

  if (!createRes.ok) throw new Error("Failed to create Asset in Pieces OS");
}

// Writes to PiecesOS's workstream-event stream — a separate store from
// assets (confirmed live: 2,495+ existing native events — calendar, IDE,
// browser activity — completely distinct from the assets list). Assets are
// good for "save this snippet" and are searchable via /qgpt/relevance, but
// they don't feed PiecesOS's own timeline/rollup generation the way
// workstream events do. Written alongside assets (not instead of), so both
// surfaces stay populated for this data.
//
// Body shape confirmed by live testing against this PiecesOS install
// (12.6.1), not just inferred from the vendored @pieces.app/pieces-os-client
// SDK — the SDK's `seededWorkstreamEvent` wrapper key does NOT work against
// the real server; the body must be flat: { application, trigger, readable }.
export async function seedWorkstreamEvent(piecesBaseUrl: string, readable: string) {
  const application = await getApplication(piecesBaseUrl);

  const res = await fetch(`${piecesBaseUrl}/workstream_events/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      application,
      // checkIn matches this data's actual semantics best: a periodic
      // "this app was in the foreground, here's what was on screen" signal,
      // not a discrete copy/paste/tab-switch/file-open action.
      trigger: { checkIn: true },
      readable,
    }),
  });

  if (!res.ok) throw new Error("Failed to create WorkstreamEvent in Pieces OS");
}
