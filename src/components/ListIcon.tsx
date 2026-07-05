interface ListIconProps {
  name:
    | "search"
    | "filter"
    | "sort"
    | "chevron-down"
    | "chevron-up"
    | "close"
    | "star"
    | "attachment"
    | "refresh"
    | "image"
    | "template"
    | "print"
    | "check"
    | "schedule"
    | "reply"
    | "reply-all"
    | "forward"
    | "mail"
    | "ellipsis";
  color: string;
  size?: number;
  // Only meaningful for "star" -- filled (solid) vs. outline.
  filled?: boolean;
}

// Same plain-DOM-SVG reasoning as FolderIcon -- web/Tauri-only for now.
export function ListIcon({ name, color, size = 14, filled = false }: ListIconProps) {
  const props = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (name) {
    case "search":
      return (
        <svg {...props}>
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.4" y2="16.4" />
        </svg>
      );
    case "filter":
      return (
        <svg {...props}>
          <path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" />
        </svg>
      );
    case "sort":
      return (
        <svg {...props}>
          <path d="M8 4v13M5 7l3-3 3 3" />
          <path d="M16 20V7M13 17l3 3 3-3" />
        </svg>
      );
    case "chevron-down":
      return (
        <svg {...props}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      );
    case "chevron-up":
      return (
        <svg {...props}>
          <polyline points="6 15 12 9 18 15" />
        </svg>
      );
    case "close":
      return (
        <svg {...props}>
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      );
    case "star":
      return (
        <svg {...props} fill={filled ? color : "none"}>
          <path d="M12 3.5l2.6 5.5 5.9.8-4.3 4.2 1 6-5.2-2.9-5.2 2.9 1-6-4.3-4.2 5.9-.8z" />
        </svg>
      );
    case "attachment":
      return (
        <svg {...props}>
          <path d="M16.5 6.5L8.7 14.3a3.5 3.5 0 0 0 4.95 4.95l7.07-7.07a5.5 5.5 0 0 0-7.78-7.78L5.5 11.8a4 4 0 0 0 5.66 5.66" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...props}>
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <polyline points="21 3 21 9 15 9" />
        </svg>
      );
    case "image":
      return (
        <svg {...props}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="9" cy="10" r="1.7" />
          <path d="M3 17l5.5-5.5a2 2 0 0 1 2.8 0L17 17" />
        </svg>
      );
    case "template":
      return (
        <svg {...props}>
          <path d="M6 3h9l3 3v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
          <path d="M8 9h8M8 13h8M8 17h5" />
        </svg>
      );
    case "print":
      return (
        <svg {...props}>
          <polyline points="6 9 6 3 18 3 18 9" />
          <path d="M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" />
          <rect x="6" y="14" width="12" height="7" rx="1" />
        </svg>
      );
    case "check":
      // Double check ("mark all read"), distinct from a single tick.
      return (
        <svg {...props}>
          <polyline points="2 12 7 17 14 8" />
          <polyline points="11 14 13 16 22 6" />
        </svg>
      );
    case "schedule":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <polyline points="12 7 12 12 15 15" />
        </svg>
      );
    case "reply":
      return (
        <svg {...props}>
          <polyline points="9 17 4 12 9 7" />
          <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
        </svg>
      );
    case "reply-all":
      return (
        <svg {...props}>
          <polyline points="7 17 2 12 7 7" />
          <polyline points="12 17 7 12 12 7" />
          <path d="M22 18v-2a4 4 0 0 0-4-4H7" />
        </svg>
      );
    case "forward":
      return (
        <svg {...props}>
          <polyline points="15 17 20 12 15 7" />
          <path d="M4 18v-2a4 4 0 0 1 4-4h12" />
        </svg>
      );
    case "mail":
      return (
        <svg {...props}>
          <rect x="2" y="5" width="20" height="14" rx="2" />
          <polyline points="2 5 12 13 22 5" />
        </svg>
      );
    case "ellipsis":
      return (
        <svg {...props} fill={color} stroke="none">
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
      );
    default:
      return null;
  }
}
