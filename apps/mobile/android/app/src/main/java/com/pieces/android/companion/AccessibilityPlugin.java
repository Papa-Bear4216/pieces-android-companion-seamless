package com.pieces.android.companion;

import android.app.AppOpsManager;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Process;
import android.provider.Settings;
import android.text.TextUtils;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(name = "AccessibilityScanner")
public class AccessibilityPlugin extends Plugin {

    static final String PREFS_NAME = "pieces_accessibility_prefs";
    static final String ALLOWLIST_KEY = "captured_package_allowlist";
    static final String PASSIVE_MODE_KEY = "passive_mode_enabled";
    static final String SCREEN_CONTEXT_ENABLED_KEY = "screen_context_enabled";

    @Override
    public void load() {
        super.load();
        NativeTelemetrySync.warmUpDatabaseAsync(getContext());
        // Bridges the accessibility service's debounced captures to JS via a
        // Capacitor event. Registered once per plugin instance; the service
        // only calls this if passive mode is on (checked on its side too).
        PiecesAccessibilityService.passiveListener = (packageName, text) -> {
            String appLabel = "";
            if (!packageName.isEmpty()) {
                try {
                    android.content.pm.PackageManager pm = getContext().getPackageManager();
                    android.content.pm.ApplicationInfo ai = pm.getApplicationInfo(packageName, 0);
                    appLabel = pm.getApplicationLabel(ai).toString();
                } catch (android.content.pm.PackageManager.NameNotFoundException ignored) {}
            }
            JSObject data = new JSObject();
            data.put("package", packageName);
            data.put("appLabel", appLabel);
            data.put("textNodes", text);
            notifyListeners("passiveCapture", data);
        };
    }

    // Excluded from the app picker outright — never selectable, regardless of what the
    // user picks. Matched by package-name prefix, not exact string, since these vendors
    // ship many package ids (e.g. multiple Google Pay variants, regional banking apps).
    private static final List<String> EXCLUDED_PREFIXES = Arrays.asList(
        "com.android.vending",      // Play Store account/payment flows
        "com.google.android.apps.walletnfcrel", // Google Wallet
        "com.google.android.apps.nbu.paisa",    // Google Pay
        "com.paypal",
        "com.venmo",
        "com.squareup.cash",
        "com.lastpass",
        "com.agilebits.onepassword", // 1Password
        "com.bitwarden",
        "com.dashlane",
        "com.keepersecurity",
        "com.nordpass",
        // Verified against a real device's installed package list on 2026-08-30
        // (adb shell pm list packages) after "com.wellsfargo" was found to be a
        // guessed prefix that didn't match the real installed package
        // (com.wf.wellsfargomobile) and silently let Wells Fargo through. Every
        // prefix below is a real, currently-observed package id, not a guess —
        // but a hand-maintained list can never be complete, which is why
        // isExcludedByLabel() below is the primary defense and this list is
        // the fast-path/fallback, not the only layer.
        "com.chase",
        "com.bankofamerica",
        "com.wf.wellsfargomobile",   // Wells Fargo (was wrongly "com.wellsfargo")
        "com.citi",
        "com.konylabs.capitalone",   // Capital One (was wrongly "com.capitalone")
        "com.usaa.mobile.android.usaa", // USAA (was wrongly "com.usaa")
        "com.creditkarma.mobile",
        "com.sofi.mobile",
        "com.onefinance.one",        // One Finance
        "com.uphold.wallet",
        "piuk.blockchain.android",   // Blockchain.com wallet
        "com.monyx.wallet",
        "com.samsung.android.spay",  // Samsung Pay/Wallet
        "com.samsung.android.coldwalletservice",
        "com.samsung.android.scryptowallet",
        "com.intuit.turbotax.mobile",
        "com.syf",                   // Synchrony (mysynchrony, cc)
        "com.onedebit.chime",
        "com.equifax.myequifax",
        "com.transunion",
        "com.experian.android",
        "com.acorns.early",
        "com.affirm.central",
        "com.monarchmoney.mobile",
        "com.selflender.thor",
        "com.sezzle.sezzlemobile",
        "com.truebill",              // Rocket Money (formerly Truebill)
        "com.paypal.android.p2pmobile", // real PayPal id; broader "com.paypal" above already covers it too
        // Added 2026-08-30 to back 5 of the 9 EXCLUDED_LABEL_KEYWORDS entries
        // that had no prefix fast-path (scripts/audit-exclusions found this).
        // Each verified live via a direct HTTP 200 against its real Play
        // Store listing page — not guessed. Zelle's real package id could
        // NOT be verified (every candidate tried 404'd); it stays
        // label-keyword-only until a real one is confirmed, deliberately
        // not guessed here.
        "com.coinbase.android",
        "com.robinhood.android",
        "com.myklarnamobile",        // Klarna
        "com.onepassword.android",   // 1Password (current id; com.agilebits.onepassword above is the legacy one)
        "com.citi.citimobile",       // Citi Mobile
        // Messaging / SMS / calling
        "com.google.android.apps.messaging",
        "com.samsung.android.messaging",
        "com.whatsapp",
        "com.facebook.orca",       // Messenger
        "org.telegram.messenger",
        "org.thoughtcrime.securesms", // Signal
        "com.discord",
        "com.google.android.talk", // Hangouts/Chat
        "com.skype.raider",
        "com.google.android.apps.tachyon", // Google Meet/Duo
        "com.samsung.android.incallui",
        "com.android.mms",
        "com.android.phone",
        // Email
        "com.google.android.gm",   // Gmail
        "com.microsoft.office.outlook",
        "com.samsung.android.email.provider",
        "com.yahoo.mobile.client.android.mail",
        // Social
        "com.facebook.katana",
        "com.instagram.android",
        "com.twitter.android",
        "com.zhiliaoapp.musically", // TikTok
        "com.snapchat.android",
        "com.reddit.frontpage",
        "com.linkedin.android",
        "com.pinterest",
        "com.tumblr"
    );

    // Excluded from the app picker for a different reason than EXCLUDED_PREFIXES —
    // not privacy-sensitive, just useless signal. Keyboards emit one node per
    // keypress, system UI/launcher churn constantly with clock/battery/notification
    // text, and OEM/carrier services have no user-facing screen worth capturing.
    // Keeping this list separate from the privacy one lets each be audited for its
    // own reason independently.
    private static final List<String> EXCLUDED_NOISE_PREFIXES = Arrays.asList(
        // Keyboards / input methods
        "com.samsung.android.honeyboard",
        "com.google.android.inputmethod",
        "com.touchtype.swiftkey",
        "com.google.android.googlequicksearchbox", // includes Gboard voice/assistant surface
        // System UI / launcher / shell chrome
        "com.android.systemui",
        "com.sec.android.app.launcher",
        "com.google.android.apps.nexuslauncher",
        "com.android.settings",
        "com.samsung.android.app.settings",
        "com.android.launcher3",
        "com.google.android.permissioncontroller",
        "com.android.permissioncontroller",
        // OEM/carrier background services with no meaningful on-screen text
        "com.samsung.android.mdecservice",
        "com.samsung.android.dqagent",
        "com.samsung.android.game.gametools",
        "com.wssyncmldm",             // carrier device-management
        "com.sec.android.diagmonagent",
        "com.samsung.android.sm",     // Samsung Device Care
        "com.android.providers",      // content providers, no UI
        "com.google.android.gms",     // Play Services background surface
        "com.google.android.packageinstaller",
        "com.android.packageinstaller"
    );

    // Label-keyword fallback: catches finance/wallet/credit/password-manager
    // apps whose package id isn't in EXCLUDED_PREFIXES at all — the gap that
    // let com.wf.wellsfargomobile through (guessed as "com.wellsfargo").
    // Matched against the app's display name (case-insensitive substring),
    // not the package id, since the label is what the vendor actually wants
    // the user to recognize and is far less likely to be silently renamed
    // than an internal package id. This is deliberately broad/over-inclusive
    // — a false-positive here just means one extra app doesn't show up in
    // the picker, which is the safe direction for a capture exclusion list.
    private static final List<String> EXCLUDED_LABEL_KEYWORDS = Arrays.asList(
        "bank", "wallet", "credit", "credit score", "credit karma",
        "paypal", "venmo", "cash app", "zelle", "capital one", "chase",
        "wells fargo", "citibank", "usaa", "synchrony", "sofi",
        "turbotax", "equifax", "experian", "transunion", "lastpass",
        "bitwarden", "dashlane", "keeper", "nordpass", "1password",
        "acorns", "affirm", "klarna", "sezzle", "chime", "monarch money",
        "coinbase", "blockchain", "crypto", "robinhood", "uphold",
        "rocket money", "truebill"
    );

    // static + package-visible so PiecesAccessibilityService.isAllowed can
    // enforce this same denylist independently of the allowlist it reads
    // from SharedPreferences — that allowlist has no built-in cross-check
    // against these lists (it's user-editable, opt-in state, not a fixed
    // ruleset), so without this call, a sensitive/noise package that ever
    // ends up in the saved allowlist (a picker bug, a manually-edited prefs
    // file, an app id reused by a different vendor over time) would be
    // captured with nothing to stop it.
    //
    // appLabel is optional (callers that only have a package name, like
    // PiecesAccessibilityService.isAllowed on the capture-time hot path,
    // pass null) — prefix matching alone still runs in that case. The label
    // check only activates where a label is available (the picker, which
    // already looks it up via PackageManager for display anyway), so it
    // doesn't add a PackageManager lookup on the capture path.
    static boolean isExcluded(String packageName) {
        return isExcluded(packageName, null);
    }

    static boolean isExcluded(String packageName, String appLabel) {
        for (String prefix : EXCLUDED_PREFIXES) {
            if (packageName.startsWith(prefix)) return true;
        }
        for (String prefix : EXCLUDED_NOISE_PREFIXES) {
            if (packageName.startsWith(prefix)) return true;
        }
        if (appLabel != null) {
            String lower = appLabel.toLowerCase(java.util.Locale.ROOT);
            for (String keyword : EXCLUDED_LABEL_KEYWORDS) {
                if (lower.contains(keyword)) return true;
            }
        }
        return false;
    }

    // ApplicationInfo.CATEGORY_* constants (API 26+) — getCategoryTitle() needs
    // a Resources handle we don't have per-app here, so map to a fixed label
    // set ourselves. CATEGORY_UNDEFINED (-1) and anything unmapped falls into
    // "Uncategorized" in the JS-side grouping, not here — this method only
    // reports the raw label, grouping is a picker-UI concern.
    private static String categoryLabel(int category) {
        switch (category) {
            case ApplicationInfo.CATEGORY_GAME: return "Game";
            case ApplicationInfo.CATEGORY_AUDIO: return "Audio";
            case ApplicationInfo.CATEGORY_VIDEO: return "Video";
            case ApplicationInfo.CATEGORY_IMAGE: return "Image";
            case ApplicationInfo.CATEGORY_SOCIAL: return "Social";
            case ApplicationInfo.CATEGORY_NEWS: return "News";
            case ApplicationInfo.CATEGORY_MAPS: return "Maps";
            case ApplicationInfo.CATEGORY_PRODUCTIVITY: return "Productivity";
            case ApplicationInfo.CATEGORY_ACCESSIBILITY: return "Accessibility";
            default: return "Uncategorized";
        }
    }

    @PluginMethod
    public void listInstalledApps(PluginCall call) {
        PackageManager pm = getContext().getPackageManager();
        List<ApplicationInfo> apps = pm.getInstalledApplications(PackageManager.GET_META_DATA);

        JSArray result = new JSArray();
        for (ApplicationInfo app : apps) {
            // Label is needed for the exclusion check itself now (catches
            // apps like Wells Fargo whose package id doesn't match any
            // guessed prefix), so it's looked up before the isExcluded call,
            // not just for display afterward.
            String label = pm.getApplicationLabel(app).toString();
            if (isExcluded(app.packageName, label)) continue;
            boolean isSystem = (app.flags & ApplicationInfo.FLAG_SYSTEM) != 0
                || (app.flags & ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0;
            // getLaunchIntentForPackage() returns null for anything with no
            // launcher-visible entry point (pure background services, sync
            // adapters, some system daemons) - those can never be brought to
            // the foreground by the user, so they can never have on-screen
            // text worth capturing regardless of what EXCLUDED_NOISE_PREFIXES
            // happens to already cover by name. Reported as a field (not
            // filtered out here) so the JS-side picker's "hide background-
            // only apps" toggle stays reversible - same pattern as isSystemApp.
            boolean hasLauncherIcon = pm.getLaunchIntentForPackage(app.packageName) != null;
            JSObject entry = new JSObject();
            entry.put("packageName", app.packageName);
            entry.put("label", label);
            entry.put("isSystemApp", isSystem);
            entry.put("hasLauncherIcon", hasLauncherIcon);
            entry.put("category", categoryLabel(app.category));
            result.put(entry);
        }

        JSObject ret = new JSObject();
        ret.put("apps", result);
        call.resolve(ret);
    }

    // Usage Access is a special AppOps permission — no manifest runtime-permission
    // dialog exists for it. The user must grant it manually via the Settings
    // screen this opens, same UX shape as openAccessibilitySettings() above.
    @PluginMethod
    public void isUsageAccessGranted(PluginCall call) {
        AppOpsManager appOps = (AppOpsManager) getContext().getSystemService(android.content.Context.APP_OPS_SERVICE);
        int mode = appOps.unsafeCheckOpNoThrow(
            AppOpsManager.OPSTR_GET_USAGE_STATS,
            Process.myUid(),
            getContext().getPackageName()
        );
        JSObject ret = new JSObject();
        ret.put("granted", mode == AppOpsManager.MODE_ALLOWED);
        call.resolve(ret);
    }

    @PluginMethod
    public void openUsageAccessSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    // Suggestion source for the picker's "Recently used" section — never
    // capture-gating on its own. Results still only affect the allowlist via
    // the same setAllowlist() opt-in path the picker already uses; this just
    // pre-populates what gets checked by default, all user-editable before save.
    // Below this, a package is treated as incidentally foregrounded (a
    // settings screen passed through, a permission dialog, a notification-
    // shade tap) rather than actually used. On a real device with 500+
    // installed packages, even genuine foreground-only time (not background
    // service time — getTotalTimeInForeground() already excludes that)
    // accumulates across enough apps that an any-nonzero filter alone let
    // through 520 packages. This threshold is the fix, not a background-vs-
    // foreground distinction, which UsageStats already handles correctly.
    private static final long MIN_FOREGROUND_MS_FOR_RECENT = TimeUnit.SECONDS.toMillis(60);

    @PluginMethod
    public void getRecentlyUsedPackages(PluginCall call) {
        Integer days = call.getInt("days", 7);
        UsageStatsManager usm = (UsageStatsManager) getContext().getSystemService(android.content.Context.USAGE_STATS_SERVICE);
        if (usm == null) {
            call.reject("UsageStatsManager unavailable");
            return;
        }

        long end = System.currentTimeMillis();
        long start = end - TimeUnit.DAYS.toMillis(days);
        // INTERVAL_DAILY returns one entry per package PER DAY BUCKET, not one
        // total per package — sum across buckets before thresholding, or a
        // package with a few seconds each day over 7 days looks like several
        // separate sub-threshold blips instead of the ~minutes it actually adds to.
        // Deliberately NOT INTERVAL_BEST: tested empirically on-device
        // 2026-08-30 — INTERVAL_BEST silently resolves to a coarser bucket
        // than the requested window on this device (e.g. asking for 7 days
        // returned totals like 673144ms/~187hrs for a single package, which
        // exceeds the 168hrs physically possible in 7 days), meaning it
        // pulls in usage from outside the requested range. INTERVAL_DAILY
        // summed manually is the only mode confirmed to respect the actual
        // start/end bounds passed in.
        List<UsageStats> stats = usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, start, end);

        PackageManager pm = getContext().getPackageManager();
        java.util.Map<String, Long> totalForegroundMs = new java.util.HashMap<>();
        if (stats != null) {
            for (UsageStats stat : stats) {
                String pkg = stat.getPackageName();
                if (pkg == null) continue;
                // Label lookup so a package like com.wf.wellsfargomobile (no
                // matching prefix) still gets excluded from "recently used"
                // suggestions, same reasoning as listInstalledApps above.
                String label = null;
                try {
                    label = pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString();
                } catch (PackageManager.NameNotFoundException ignored) {}
                if (isExcluded(pkg, label)) continue;
                long existing = totalForegroundMs.containsKey(pkg) ? totalForegroundMs.get(pkg) : 0L;
                totalForegroundMs.put(pkg, existing + stat.getTotalTimeInForeground());
            }
        }

        JSArray result = new JSArray();
        // "usageMs" is a JS-side sort-by-active-time convenience — the total
        // foreground ms per package was already being computed above and
        // discarded (only the above-threshold package names were kept).
        // Same threshold/window as "packages" (both come from the one
        // queryUsageStats call above), so the two stay consistent with each
        // other rather than representing two different measurements.
        JSObject usageMs = new JSObject();
        for (java.util.Map.Entry<String, Long> entry : totalForegroundMs.entrySet()) {
            if (entry.getValue() >= MIN_FOREGROUND_MS_FOR_RECENT) {
                result.put(entry.getKey());
                usageMs.put(entry.getKey(), entry.getValue());
            }
        }

        JSObject ret = new JSObject();
        ret.put("packages", result);
        ret.put("usageMs", usageMs);
        call.resolve(ret);
    }

    @PluginMethod
    public void getAllowlist(PluginCall call) {
        Set<String> allowlist = getPrefs().getStringSet(ALLOWLIST_KEY, new HashSet<>());
        JSArray result = new JSArray();
        for (String pkg : allowlist) result.put(pkg);
        JSObject ret = new JSObject();
        ret.put("packages", result);
        call.resolve(ret);
    }

    @PluginMethod
    public void setAllowlist(PluginCall call) {
        JSArray packages = call.getArray("packages");
        if (packages == null) {
            call.reject("Must provide a packages array");
            return;
        }

        PackageManager pm = getContext().getPackageManager();
        Set<String> allowlist = new HashSet<>();
        try {
            List<Object> list = packages.toList();
            for (Object pkg : list) {
                String name = String.valueOf(pkg);
                // Defense in depth: even if the caller tries to slip an excluded
                // package into the allowlist directly, it's dropped here too.
                // Label lookup here (not just package prefix) is what actually
                // catches a package id EXCLUDED_PREFIXES doesn't know about —
                // this is the save path, so a per-entry PackageManager call is
                // fine (small list, one-time action, not a capture-time hot path).
                String label = null;
                try {
                    label = pm.getApplicationLabel(pm.getApplicationInfo(name, 0)).toString();
                } catch (PackageManager.NameNotFoundException ignored) {}
                if (!isExcluded(name, label)) allowlist.add(name);
            }
        } catch (Exception e) {
            call.reject("Invalid packages array", e);
            return;
        }

        getPrefs().edit().putStringSet(ALLOWLIST_KEY, allowlist).apply();

        JSObject ret = new JSObject();
        ret.put("status", "saved");
        ret.put("count", allowlist.size());
        call.resolve(ret);
    }

    // Mirrors the JS-side Capacitor Preferences flag (config.ts's
    // screenContextEnabled) into the native SharedPreferences store the
    // accessibility service actually reads (PiecesAccessibilityService.isAllowed
    // and the passive-mode gate both check this) — previously the native layer
    // never saw this flag at all, so toggling it off in Setup didn't stop capture.
    @PluginMethod
    public void setScreenContextEnabled(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) {
            call.reject("Must provide enabled boolean");
            return;
        }
        getPrefs().edit().putBoolean(SCREEN_CONTEXT_ENABLED_KEY, enabled).apply();
        JSObject ret = new JSObject();
        ret.put("status", "saved");
        call.resolve(ret);
    }

    @PluginMethod
    public void getPassiveModeEnabled(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("enabled", getPrefs().getBoolean(PASSIVE_MODE_KEY, false));
        call.resolve(ret);
    }

    // Passive mode has its own gate on top of the toolkit opt-in and the app
    // allowlist — enabling it means captured text is pushed automatically
    // (debounced/deduped in PiecesAccessibilityService) instead of only on a
    // button tap. The React layer requires a typed confirmation before
    // calling this, but this method itself has no additional precondition
    // beyond that call — the allowlist emptiness check is enforced in React
    // since an empty allowlist just means passive mode has nothing to send.
    @PluginMethod
    public void setPassiveModeEnabled(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) {
            call.reject("Must provide enabled boolean");
            return;
        }
        getPrefs().edit().putBoolean(PASSIVE_MODE_KEY, enabled).apply();
        JSObject ret = new JSObject();
        ret.put("status", "saved");
        call.resolve(ret);
    }

    // Opens Android's own Accessibility Settings screen; the user finds
    // "Pieces Android Companion" in the list and flips it on manually, same
    // as enabling a screen reader or password-manager autofill service.
    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void isAccessibilityServiceEnabled(PluginCall call) {
        String enabledServices = Settings.Secure.getString(
            getContext().getContentResolver(),
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        );
        String target = getContext().getPackageName() + "/" + PiecesAccessibilityService.class.getName();
        boolean enabled = !TextUtils.isEmpty(enabledServices) && enabledServices.contains(target);

        JSObject ret = new JSObject();
        ret.put("enabled", enabled);
        call.resolve(ret);
    }

    @PluginMethod
    public void getActiveScreenText(PluginCall call) {
        try {
            String packageName = PiecesAccessibilityService.lastCapturedPackage;
            String appLabel = "";
            if (!packageName.isEmpty()) {
                try {
                    PackageManager pm = getContext().getPackageManager();
                    ApplicationInfo ai = pm.getApplicationInfo(packageName, 0);
                    appLabel = pm.getApplicationLabel(ai).toString();
                } catch (PackageManager.NameNotFoundException ignored) {}
            }

            JSObject ret = new JSObject();
            ret.put("package", packageName);
            ret.put("appLabel", appLabel);
            ret.put("textNodes", String.join("\n", PiecesAccessibilityService.lastCapturedText));

            if (PiecesAccessibilityService.lastCapturedText.isEmpty()) {
                ret.put("status", "No text captured yet — service not enabled, or no allowlisted app has been in the foreground");
            } else {
                ret.put("status", "success");
            }

            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to retrieve accessibility buffer", e);
        }
    }

    @PluginMethod
    public void getOutboxStatus(PluginCall call) {
        NativeTelemetrySync.getOutboxStatusAsync(getContext(), (pending, isFlushing, dropped, isReady) -> {
            JSObject ret = new JSObject();
            ret.put("pending", pending);
            ret.put("isFlushing", isFlushing);
            ret.put("dropped", dropped);
            ret.put("isReady", isReady);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void flushOutbox(PluginCall call) {
        String status = NativeTelemetrySync.flushAsync(getContext(), true);
        NativeTelemetrySync.getOutboxStatusAsync(getContext(), (pending, isFlushing, dropped, isReady) -> {
            JSObject ret = new JSObject();
            ret.put("status", status);
            ret.put("pending", pending);
            ret.put("isFlushing", isFlushing);
            ret.put("dropped", dropped);
            ret.put("isReady", isReady);
            call.resolve(ret);
        });
    }

    private SharedPreferences getPrefs() {
        return getContext().getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE);
    }
}
