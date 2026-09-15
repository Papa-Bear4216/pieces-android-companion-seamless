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
 * Resets the SMS backfill cursor to a recent window (default: last 30 days)
 * relative to the newest message on the device. This ensures recent, active
 * conversations populate first before older multi-year archives.
 */
export async function resetSmsBackfillToRecent(days = 30): Promise<number> {
  const latestRes = (await SmsReader.latestMessageDate().catch(() => null)) as { date?: number } | null;
  const latestDate = Number(latestRes?.date ?? 0);
  const baseTime = latestDate > 0 ? latestDate : Date.now();
  const target = Math.max(0, baseTime - days * 86400 * 1000);
  await setSmsBackfillHighWater(target);
  return target;
}

/**
 * Pull SMS history newer than the stored high-water mark into the usage queue,
 * up to MAX_PER_RUN messages per call. Flushed in the background by flushUsageEvents.
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
  if (since === 0) {
    // Initial run: start at the recent window (last 30 days) so recent messages
    // populate immediately into PiecesOS and Mem0 instead of walking years of history first.
    since = await resetSmsBackfillToRecent(30);
  }

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
