import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FloatingPortal } from "./FloatingPortal";
import { colors, fontFamily, radii } from "../theme";

interface TooltipProps {
  label: string;
  children: ReactNode;
}

// Hover-only label for icon-only controls. The trigger underneath is
// always a Pressable, and react-native-web's Pressable hardcodes
// `contain: true` on its hover gesture -- hovering a nested Pressable
// locks out any ancestor Pressable's own hover state, so wrapping with
// another Pressable here would simply never fire. A plain DOM wrapper
// with native mouse events sidesteps that (same reasoning as Splitter.tsx
// and the resize handle in ComposeModal -- web/Tauri-only).
//
// The label itself renders through FloatingPortal rather than an in-place
// `position: absolute` node -- every react-native-web View is its own CSS
// stacking context (see FloatingPortal's own comment), so a bare zIndex
// here could never out-rank unrelated elements like the tab bar sitting in
// a different branch of the tree. Without the portal, a tooltip anchored
// near the top of a pane (e.g. MessageList's refresh button, right under
// the tab strip) rendered as an ugly opaque rectangle clipped behind the
// tab bar instead of floating above it.
export function Tooltip({ label, children }: TooltipProps) {
  const [hovered, setHovered] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    if (!hovered) {
      setRect(null);
      return;
    }
    setRect(anchorRef.current?.getBoundingClientRect() ?? null);
  }, [hovered]);

  return (
    <div
      ref={anchorRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ position: "relative", display: "inline-flex" }}
    >
      {children}
      {rect && (
        <FloatingPortal top={rect.top - 6} left={rect.left + rect.width / 2}>
          <div
            style={{
              transform: "translate(-50%, -100%)",
              padding: "4px 8px",
              borderRadius: radii.sm,
              border: `1px solid ${colors.border.subtle}`,
              backgroundColor: colors.background.panel,
              whiteSpace: "nowrap",
              pointerEvents: "none",
              fontFamily: fontFamily.ui,
              fontSize: 11,
              color: colors.text.secondary,
            }}
          >
            {label}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}
