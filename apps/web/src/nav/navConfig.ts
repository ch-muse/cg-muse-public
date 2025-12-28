export type NavItem = {
  label: string;
  to: string;
};

export type NavGroup = {
  id: string;
  label: string;
  items: NavItem[];
};

export const navGroups: NavGroup[] = [
  {
    id: "play",
    label: "Play",
    items: [
      { to: "/play/muse", label: "Muse" },
      { to: "/play/whisper", label: "Whisper" },
      { to: "/play/comfy", label: "Comfy Runner" },
      { to: "/play/liked", label: "Liked" }
    ]
  },
  {
    id: "workshop",
    label: "Workshop",
    items: [
      { to: "/workshop/loras", label: "LoRA Library" },
      { to: "/workshop/recipes", label: "Recipes" }
    ]
  },
  {
    id: "library",
    label: "Library",
    items: [{ to: "/gallery", label: "Gallery" }]
  },
  {
    id: "internals",
    label: "Internals",
    items: [
      { to: "/internals/sessions", label: "Sessions" },
      { to: "/internals/dictionary", label: "Dictionary" },
      { to: "/internals/gallery-sources", label: "Gallery Sources" },
      { to: "/internals/comfy", label: "ComfyUI" }
    ]
  }
];

export const isNavItemActive = (pathname: string, item: NavItem) => {
  if (pathname === item.to) return true;
  return pathname.startsWith(`${item.to}/`);
};

export const isNavGroupActive = (pathname: string, group: NavGroup) =>
  group.items.some((item) => isNavItemActive(pathname, item));
