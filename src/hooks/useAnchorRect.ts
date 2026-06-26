import { useLayoutEffect, useRef, useState } from "react";
import type { View } from "react-native";

// react-native-web forwards View/Pressable refs straight through to the
// underlying DOM node, but RN's own types describe the ref as a `View`
// instance (so the same component code lines up with the native API) --
// this is the one place that gap gets bridged, rather than casting at
// every call site that needs to measure a trigger element.
function asElement(ref: View | null): HTMLElement | null {
  return ref as unknown as HTMLElement | null;
}

// Measures a trigger element's screen position while `open` is true, for
// positioning a portaled floating menu (see FloatingPortal) that needs
// fixed-position coordinates rather than CSS-relative ones. Re-measures on
// resize/scroll so the menu doesn't drift out from under its trigger.
export function useAnchorRect(open: boolean) {
  const anchorRef = useRef<View>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setRect(null);
      return;
    }
    function measure() {
      const element = asElement(anchorRef.current);
      if (element) setRect(element.getBoundingClientRect());
    }
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  return [anchorRef, rect] as const;
}
