import { useWindowDimensions } from "react-native";

export type Breakpoint = "desktop" | "tablet" | "mobile";

// Desktop keeps all 3 panes plus their splitters -- 1080 leaves enough room
// for sidebar-min(180) + list-min(280) + a usable reader pane. Tablet drops
// the sidebar to an overlay (folder pane is the one users miss least).
// Below 720 there isn't room for list and reader side by side either, so
// it's a single pane with view-stack navigation between them.
export function useBreakpoint(): Breakpoint {
  const { width } = useWindowDimensions();
  if (width < 720) return "mobile";
  if (width < 1080) return "tablet";
  return "desktop";
}
