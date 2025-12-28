import { NavLink, useLocation } from "react-router-dom";
import { isNavGroupActive, navGroups } from "../nav/navConfig.js";
import { useNavGroupState } from "../nav/useNavGroupState.js";

export default function NavGroupList() {
  const { pathname } = useLocation();
  const { openMap, toggleGroup } = useNavGroupState();

  return (
    <nav className="space-y-4 text-sm">
      {navGroups.map((group) => {
        const open = Boolean(openMap[group.id]);
        const active = isNavGroupActive(pathname, group);

        return (
          <div key={group.id} className="space-y-2">
            <button
              type="button"
              onClick={() => toggleGroup(group.id)}
              className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-xs font-semibold uppercase tracking-wide transition ${
                active
                  ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-100"
                  : "border-slate-800 text-slate-300 hover:text-white hover:border-slate-600"
              }`}
              aria-expanded={open}
            >
              <span>{group.label}</span>
              <span className={`transition ${open ? "rotate-90" : ""}`}>›</span>
            </button>
            {open && (
              <div className="flex flex-col gap-1 pl-2">
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      `rounded-md px-3 py-2 transition ${
                        isActive
                          ? "bg-emerald-500/20 text-emerald-100 border border-emerald-400/40"
                          : "text-slate-300 hover:text-white hover:bg-slate-900/60"
                      }`
                    }
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
