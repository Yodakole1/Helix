import { useEffect, useState } from "react";
import { colors } from "../theme";

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

// A hand-rolled hex-code field standing in for `<input type="color">`.
// WebKitGTK -- the engine Tauri's Linux builds embed -- doesn't reliably
// implement that control's native color-chooser popover: clicking it does
// nothing in a packaged .deb even though the same input works fine in a
// browser during `npm run dev`. Typing/pasting a hex code sidesteps the
// native dialog entirely, so custom colors stay editable in every build.
function readableTextColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#000000" : "#FFFFFF";
}

interface HexColorInputProps {
  value: string;
  onChange: (color: string) => void;
  width?: number;
  height?: number;
}

export function HexColorInput({ value, onChange, width = 84, height = 30 }: HexColorInputProps) {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const normalized = draft.trim();
    if (HEX_RE.test(normalized)) {
      onChange(normalized);
    } else {
      setDraft(value);
    }
  };

  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft((e.target as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      placeholder="#RRGGBB"
      maxLength={7}
      spellCheck={false}
      style={{
        width,
        height,
        padding: "0 8px",
        border: `1px solid ${colors.border.subtle}`,
        borderRadius: 6,
        background: HEX_RE.test(draft) ? draft : value,
        color: readableTextColor(HEX_RE.test(draft) ? draft : value),
        fontFamily: "monospace",
        fontSize: 12,
        textAlign: "center",
        outline: "none",
      }}
    />
  );
}
