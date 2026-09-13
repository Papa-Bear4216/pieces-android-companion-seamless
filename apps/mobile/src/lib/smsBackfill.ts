import { registerPlugin } from "@capacitor/core";
import { recordEvent } from "./usage";
import { getSmsBackfillHighWater, setSmsBackfillHighWater } from "./config";

const SmsReader = registerPlugin<any>("SmsReader");

const PAGE_SIZE = 200;
// Hard cap per run so a first backfill against a huge history doesn't hold the
// queue lock for minutes — the high-water mark advances page by page, so the
// next run resumes where this one stopped.
const MAX_PER_RUN = 5000;

export interface SmsBackfillProgress {
  ingested: number;
  done: boolean;
}

export interface SmsContact {
  name: string;
  numbers: string[];
}

interface SmsRow {
  id: string;
  address: string;
  contactName: string;
  body: string;
  date: number;
  direction: "inbound" | "outbound" | "draft" | "other";
}

interface BackfillPage {
  messages: SmsRow[];
  hasMore: boolean;
  scanned: number;
  lastScannedDate: number;
}

export async function smsPermissions(): Promise<{ sms: boolean; contacts: boolean }> {
  try {
    const r = await SmsReader.hasPermission();
    return { sms: !!r.granted, contacts: !!r.contactsGranted };
  } catch {
    return { sms: false, contacts: false };
  }
}

export async function smsPermissionGranted(): Promise<boolean> {
  return (await smsPermissions()).sms;
}

/** Grant READ_SMS + READ_CONTACTS via Shizuku. Throws the native reject message on failure. */
export async function grantSmsViaShizuku(): Promise<{ sms: boolean; contacts: boolean }> {
  const r = await SmsReader.grantViaShizuku();
  return { sms: !!r.granted, contacts: !!r.contactsGranted };
}

// --- Contact allowlist --------------------------------------------------

export async function listSmsContacts(): Promise<SmsContact[]> {
  const { contacts } = (await SmsReader.listContacts()) as { contacts: SmsContact[] };
  return contacts ?? [];
}

export async function getSmsAllowlist(): Promise<string[]> {
  const { numbers } = (await SmsReader.getAllowlist()) as { numbers: string[] };
  return numbers ?? [];
}

export async function setSmsAllowlist(numbers: string[]): Promise<number> {
  const { count } = (await SmsReader.setAllowlist({ numbers })) as { count: number };
  return count;
}

// --- Backfill ---------------------------------------------------------

/**
 * Pull SMS history newer than the stored high-water mark into the usage queue,
 * filtered to the contact allowlist, one page at a time. Bounded by MAX_PER_RUN.
 * Safe to call repeatedly — a no-op once caught up or when the allowlist is empty.
 */
export async function runSmsBackfill(
  onProgress?: (p: SmsBackfillProgress) => void
): Promise<SmsBackfillProgress> {
  if (!(await smsPermissionGranted())) {
    return { ingested: 0, done: false };
  }
  // Nothing to do until the user has ticked at least one contact.
  if ((await getSmsAllowlist()).length === 0) {
    return { ingested: 0, done: true };
  }

  let since = await getSmsBackfillHighWater();
  let ingested = 0;

  while (ingested < MAX_PER_RUN) {
    const page = (await SmsReader.backfill({
      sinceMillis: since,
      limit: PAGE_SIZE,
    })) as BackfillPage;

    const { messages, hasMore, scanned, lastScannedDate } = page;

    for (const m of messages ?? []) {
      const who = m.contactName || m.address || "unknown";
      await recordEvent({
        type: "system_telemetry",
        screen: "background",
        // Prefix parsed by apps/proxy/src/seeder.ts summarizeTelemetry.
        telemetry: `SMS ${m.direction} ${who}\n${m.body}`,
        package: "com.android.messaging",
        app_label: "Messages",
        timestamp: new Date(m.date).toISOString(),
        triaged: false,
      });
      ingested++;
      since = Math.max(since, m.date);
    }

    // Advance past everything scanned (incl. allowlist-filtered rows) so the
    // next run doesn't re-scan them; never move backwards.
    if (lastScannedDate && lastScannedDate > since) since = lastScannedDate;
    await setSmsBackfillHighWater(since);
    onProgress?.({ ingested, done: !hasMore });

    if (!hasMore || (scanned ?? 0) === 0) return { ingested, done: true };
  }

  // Hit the per-run cap; more remains for the next call.
  return { ingested, done: false };
}
