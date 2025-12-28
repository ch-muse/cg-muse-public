import { NavLink, useLocation } from "react-router-dom";
import { isNavGroupActive, navGroups } from "../nav/navConfig.js";
import { useNavGroupState } from "../nav/useNavGroupState.js";

export default function HeaderNavGroups() {
  const { pathname } = useLocation();
  const { openMap, toggleGroup } = useNavGroupState();

  return (
    <div className="flex items-center gap-2 text-sm">
      {navGroups.map((group) => {
        const open = Boolean(openMap[group.id]);
        const active = isNavGroupActive(pathname, group);

        return (
          <div key={group.id} className="relative">
            <button
              type="button"
              onClick={() => toggleGroup(group.id)}
              className={`flex items-center gap-2 rounded-md border px-3 py-2 transition ${
                active
                  ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-100"
                  : "border-transparent text-slate-300 hover:text-white hover:border-slate-700"
              }`}
              aria-expanded={open}
            >
              <span>{group.label}</span>
              <span className={`text-xs transition ${open ? "rotate-180" : ""}`}>▾</span>
            </button>
            {open && (
              <div className="absolute left-0 z-10 mt-2 w-44 rounded-md border border-slate-800 bg-slate-950/95 p-2 shadow-lg">
                <div className="flex flex-col gap-1">
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
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
