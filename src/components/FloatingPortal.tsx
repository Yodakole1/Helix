import type { ReactNode } from "react";
import { createPortal } from "react-dom";

interface FloatingPortalProps {
  top: number;
  left?: number;
  right?: number;
  // Renders a full-viewport invisible backdrop behind the content, before
  // it in paint order, so an outside click dismisses without the caller
  // needing to wire up its own backdrop (and fight the same RN ViewStyle
  // "position" typing not knowing about "fixed" that this component
  // sidesteps by being a plain DOM node).
  onDismiss?: () => void;
  children: ReactNode;
}

// Escapes the component tree to mount at <body> instead of in place.
// Needed because every react-native-web View is position:relative with an
// implicit zIndex:0, which makes each View its own CSS stacking context --
// a deeply nested zIndex can only ever out-rank its immediate siblings, it
// can never beat an unrelated element several stacking contexts further
// up the tree no matter how high the value is set. Mounting at the
// document root sidesteps that entirely rather than fighting it level by
// level with manual zIndex bookkeeping. Web/Tauri-only, same reasoning as
// Splitter.tsx -- there is no portal or stacking-context concept to port
// when this ships on native.
export function FloatingPortal({ top, left, right, onDismiss, children }: FloatingPortalProps) {
  return createPortal(
    <>
      {onDismiss && (
        <div
          onClick={onDismiss}
          style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 999 }}
        />
      )}
      <div style={{ position: "fixed", top, left, right, zIndex: 1000 }}>{children}</div>
    </>,
    document.body,
  );
}
