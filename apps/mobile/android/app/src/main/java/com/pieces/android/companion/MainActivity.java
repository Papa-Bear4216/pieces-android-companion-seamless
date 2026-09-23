package com.pieces.android.companion;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AccessibilityPlugin.class);
        registerPlugin(OnDeviceTriagePlugin.class);
        registerPlugin(TextEmbedderPlugin.class);
        registerPlugin(NotificationPlugin.class);
        registerPlugin(SmsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
