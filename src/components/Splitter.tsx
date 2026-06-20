import { useState } from "react";
import { withAlpha } from "../theme";

interface SplitterProps {
  accentColor: string;
  onDragStart: () => void;
  onDrag: (deltaX: number) => void;
}

// Plain DOM div rather than an RN View -- same reasoning as Logo.tsx: this
// only runs on the web/Tauri target, and a drag handle needs raw pointer
// events tracked on `window` (so the drag survives the cursor outrunning a
// 4px-wide hit target), which isn't something RN's gesture model gives us
// for free here. Revisit with a real RN gesture/pan-responder when porting
// to native.
export function Splitter({ accentColor, onDragStart, onDrag }: SplitterProps) {
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(true);
    onDragStart();
    const startX = event.clientX;

    function handlePointerMove(moveEvent: PointerEvent) {
      onDrag(moveEvent.clientX - startX);
    }
    function handlePointerUp() {
      setDragging(false);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  return (
    <div
      onPointerDown={handlePointerDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 4,
        height: "100%",
        flexShrink: 0,
        cursor: "col-resize",
        backgroundColor: hovered || dragging ? withAlpha(accentColor, 0.5) : "transparent",
        touchAction: "none",
      }}
    />
  );
}
