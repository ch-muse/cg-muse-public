import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { isNavGroupActive, navGroups } from "./navConfig.js";

const STORAGE_KEY = "cg-muse.nav.openGroups";

const readStoredOpenGroups = () => {
  if (typeof window === "undefined") return new Set<string>();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set<string>(parsed.filter((value) => typeof value === "string"));
  } catch {
    return new Set<string>();
  }
};

const buildOpenMap = (openGroups: Set<string>) => {
  const map: Record<string, boolean> = {};
  navGroups.forEach((group) => {
    map[group.id] = openGroups.has(group.id);
  });
  return map;
};

export const useNavGroupState = () => {
  const { pathname } = useLocation();
  const [openMap, setOpenMap] = useState<Record<string, boolean>>(() =>
    buildOpenMap(readStoredOpenGroups())
  );

  useEffect(() => {
    setOpenMap((prev) => {
      let changed = false;
      const next = { ...prev };
      navGroups.forEach((group) => {
        if (isNavGroupActive(pathname, group) && !prev[group.id]) {
          next[group.id] = true;
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [pathname]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const openIds = navGroups.filter((group) => openMap[group.id]).map((group) => group.id);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(openIds));
    } catch {
      // ignore storage errors
    }
  }, [openMap]);

  const toggleGroup = (id: string) => {
    setOpenMap((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return { openMap, toggleGroup };
};
