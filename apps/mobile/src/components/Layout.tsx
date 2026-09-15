import { Outlet } from "react-router";
import TabBar from "./TabBar";

interface LayoutProps {
  shizukuOffline?: boolean;
  onDismissShizuku?: () => void;
}

export default function Layout({ shizukuOffline, onDismissShizuku }: LayoutProps) {
  return (
    <div className="app-shell">
      {shizukuOffline && (
        <div className="banner">
          <span>⚠️ Shizuku is offline. Restart it via Wireless Debugging (your device may have rebooted).</span>
          <button onClick={onDismissShizuku}>Dismiss</button>
        </div>
      )}
      <div className="page-viewport">
        <Outlet />
      </div>
      <TabBar />
    </div>
  );
}
