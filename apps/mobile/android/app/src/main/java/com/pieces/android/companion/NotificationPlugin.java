package com.pieces.android.companion;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.provider.Settings;
import android.text.TextUtils;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS bridge for the notification listener (Part 1). The capture master
 * switch (setCaptureEnabled) is a separate explicit opt-in from the listener
 * grant itself, which the user completes via the system settings screen
 * (openSettings).
 */
@CapacitorPlugin(name = "NotificationCapture")
public class NotificationPlugin extends Plugin {

    static final String CAPTURE_ENABLED_KEY = "notification_capture_enabled";
    static final String CAPTURE_ALL_APPS_KEY = "notification_capture_all_apps";

    @Override
    public void load() {
        super.load();
        NotificationCaptureService.listener = (pkg, appLabel, title, text, postedAt) -> {
            JSObject data = new JSObject();
            data.put("package", pkg);
            data.put("appLabel", appLabel);
            data.put("title", title);
            data.put("text", text);
            data.put("postedAt", postedAt);
            notifyListeners("notification", data);
        };
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(AccessibilityPlugin.PREFS_NAME, Context.MODE_PRIVATE);
    }

    /** Is our NotificationListenerService currently granted by the OS? */
    @PluginMethod
    public void isListenerEnabled(PluginCall call) {
        String flat = Settings.Secure.getString(
            getContext().getContentResolver(), "enabled_notification_listeners");
        boolean enabled = false;
        if (!TextUtils.isEmpty(flat)) {
            ComponentName me = new ComponentName(getContext(), NotificationCaptureService.class);
            for (String entry : flat.split(":")) {
                ComponentName cn = ComponentName.unflattenFromString(entry);
                if (cn != null && cn.equals(me)) { enabled = true; break; }
            }
        }
        JSObject ret = new JSObject();
        ret.put("enabled", enabled);
        call.resolve(ret);
    }

    /** Master capture switch + optional "all apps" widening. */
    @PluginMethod
    public void setCaptureEnabled(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) { call.reject("Must provide enabled boolean"); return; }
        SharedPreferences.Editor e = prefs().edit().putBoolean(CAPTURE_ENABLED_KEY, enabled);
        Boolean allApps = call.getBoolean("allApps");
        if (allApps != null) e.putBoolean(CAPTURE_ALL_APPS_KEY, allApps);
        e.apply();
        JSObject ret = new JSObject();
        ret.put("status", "saved");
        call.resolve(ret);
    }

    @PluginMethod
    public void getCaptureConfig(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("enabled", prefs().getBoolean(CAPTURE_ENABLED_KEY, false));
        ret.put("allApps", prefs().getBoolean(CAPTURE_ALL_APPS_KEY, false));
        call.resolve(ret);
    }

    /** Open the system settings screen for the user to grant the listener manually. */
    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}
