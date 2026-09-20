import { Outlet } from "react-router";
import TabBar from "./TabBar";

export default function Layout() {
  return (
    <div className="app-shell">
      <div className="page-viewport">
        <Outlet />
      </div>
      <div className="bottom-dock-scrim" />
      <TabBar />
    </div>
  );
}
