// Lightweight browser-compatible Mem0 client for mobile runtime.
// Telemetry queues locally and sends to the proxy without bundling or
// exposing direct external cloud Mem0 API keys in client APKs.

import { recordEvent } from "./usage";

export interface AddMemoryOptions {
  user_id?: string;
  agent_id?: string;
  run_id?: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

export class Memory {
  readonly userId: string;

  constructor(options?: { apiKey?: string; userId?: string }) {
    this.userId = options?.userId || 'pieces-android-mobile-user';
  }

  async add(
    content: string | Record<string, unknown>,
    options?: AddMemoryOptions
  ): Promise<void> {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const meta = options?.metadata;
    const pkg = typeof meta?.package === 'string' ? meta.package : undefined;
    const appLabel =
      typeof meta?.app_label === 'string'
        ? meta.app_label
        : typeof meta?.appLabel === 'string'
        ? meta.appLabel
        : undefined;
    try {
      await recordEvent({
        type: 'system_telemetry',
        screen: 'background',
        telemetry: text,
        package: pkg,
        app_label: appLabel,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.warn('Failed to queue telemetry event to proxy queue:', err);
    }
  }
}
