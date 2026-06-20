interface FolderIconProps {
  id: string;
  color: string;
  size?: number;
}

// Plain DOM SVG, same reasoning as every other web-only visual in this
// codebase: this only runs on the web/Tauri target. Hand-drawn line-art
// rather than an icon library -- one extra dependency for six glyphs isn't
// worth it.
export function FolderIcon({ id, color, size = 14 }: FolderIconProps) {
  const props = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (id) {
    case "inbox":
      return (
        <svg {...props}>
          <path d="M3 6h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6z" />
          <path d="M3 6l4 6h10l4-6" />
        </svg>
      );
    case "drafts":
      return (
        <svg {...props}>
          <path d="M15.5 4.5l3 3L8 18l-4 1 1-4z" />
        </svg>
      );
    case "sent":
      return (
        <svg {...props}>
          <path d="M3 11l18-7-7 18-3-7-8-4z" />
        </svg>
      );
    case "spam":
      return (
        <svg {...props}>
          <path d="M12 4l9 16H3l9-16z" />
          <line x1="12" y1="10" x2="12" y2="14" />
          <circle cx="12" cy="17" r="0.75" fill={color} stroke="none" />
        </svg>
      );
    case "archive":
      return (
        <svg {...props}>
          <rect x="3" y="7" width="18" height="13" rx="1" />
          <path d="M3 7l2-3h14l2 3" />
          <line x1="9.5" y1="12" x2="14.5" y2="12" />
        </svg>
      );
    case "trash":
      return (
        <svg {...props}>
          <path d="M5 7h14" />
          <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          <path d="M7 7l1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13" />
          <line x1="10" y1="11" x2="10" y2="17" />
          <line x1="14" y1="11" x2="14" y2="17" />
        </svg>
      );
    default:
      return null;
  }
}
