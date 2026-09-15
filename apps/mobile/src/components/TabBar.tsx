import { useLocation, useNavigate } from "react-router";
import { StatusIcon, SparklesIcon, RecentIcon, SearchIcon, SetupIcon } from "./Icons";

interface TabItem {
  path: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

const TABS: TabItem[] = [
  { path: "/status", label: "Status", icon: StatusIcon },
  { path: "/ask", label: "Ask", icon: SparklesIcon },
  { path: "/recent", label: "Recent", icon: RecentIcon },
  { path: "/search", label: "Search", icon: SearchIcon },
  { path: "/setup", label: "Setup", icon: SetupIcon },
];

export default function TabBar() {
  let pathname = "";
  try {
    const location = useLocation();
    pathname = location?.pathname || "";
  } catch {
    pathname = "";
  }
  const navigate = useNavigate();

  return (
    <nav className="modern-tabbar" aria-label="Main Navigation">
      <div className="modern-tabbar-inner">
        {TABS.map((tab) => {
          const isActive = pathname === tab.path;
          const Icon = tab.icon;

          return (
            <button
              key={tab.path}
              type="button"
              className={`modern-tab-item ${isActive ? "active" : ""}`}
              onClick={() => navigate(tab.path)}
              aria-current={isActive ? "page" : undefined}
            >
              <div className="tab-icon-wrapper">
                <Icon size={20} className="tab-icon" />
                {isActive && <div className="tab-active-glow" />}
              </div>
              <span className="tab-label">{tab.label}</span>
              {isActive && <div className="tab-active-indicator" />}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
