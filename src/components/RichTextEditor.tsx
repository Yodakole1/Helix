import { useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";

interface RichTextEditorProps {
  initialHtml?: string;
  placeholder?: string;
  onChange: (html: string) => void;
  // Fires on any interaction that can move the cursor or change the
  // selection (typing, clicking, arrow keys) so a toolbar can re-read
  // document.queryCommandState and highlight the formats active at the
  // new caret position.
  onSelectionChange?: () => void;
  // Native browser spell checking on the editable body. Defaults on.
  spellCheck?: boolean;
  // Bump to re-seed the editor's content from initialHtml -- the only way
  // the owner can programmatically replace the content (prefill arriving
  // after mount, template insertion) without a remount, since normal
  // typing deliberately never routes through React state.
  seedVersion?: number;
  style?: object;
}

// contentEditable-based rich text editor for the HTML compose mode.
// Uses document.execCommand (broadly supported across all browsers despite
// the spec deprecation notice) for the formatting operations -- the Commands
// Level 1 spec behavior is frozen and won't be removed from browsers. All
// produced HTML is sanitized via DOMPurify before sending in smtp.rs.
//
// The ref-controlled pattern avoids a React-controlled re-render cycle that
// would reset the cursor position on every keystroke -- the `contentEditable`
// div manages its own DOM mutations; React only sets the initial HTML on
// mount and reads the final HTML via `exportHtml()`.
export function RichTextEditor({ initialHtml = "", placeholder = "", onChange, onSelectionChange, seedVersion = 0, spellCheck = true, style }: RichTextEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const hasContentRef = useRef(false);

  // Runs on mount and again whenever the owner bumps seedVersion.
  useEffect(() => {
    const div = ref.current;
    if (!div) return;
    div.innerHTML = initialHtml;
    hasContentRef.current = initialHtml.trim() !== "";
    div.classList.toggle("rte-empty", !hasContentRef.current);
  }, [seedVersion]);

  function handleInput() {
    const div = ref.current;
    if (!div) return;
    const html = div.innerHTML;
    // Treat an empty-ish editor (just a <br> or whitespace) as empty.
    const empty = html === "" || html === "<br>" || html === "<div><br></div>";
    hasContentRef.current = !empty;
    onChange(empty ? "" : html);
  }

  function handleFocus() {
    // Remove placeholder styling on focus.
    ref.current?.classList.remove("rte-empty");
  }

  function handleBlur() {
    if (!hasContentRef.current) {
      ref.current?.classList.add("rte-empty");
    }
  }

  return (
    <View style={[styles.wrapper, style as object]}>
      <div
        ref={ref}
        contentEditable
        // Native webview spell checking -- WebKitGTK/WebKit/WebView2 all
        // underline via the OS dictionaries, so this costs nothing and
        // works offline. Toggleable from Settings > General.
        spellCheck={spellCheck}
        suppressContentEditableWarning
        onInput={handleInput}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyUp={onSelectionChange}
        onMouseUp={onSelectionChange}
        data-placeholder={placeholder}
        className="rte-body rte-empty"
        style={{
          flex: 1,
          minHeight: 120,
          outline: "none",
          fontFamily: fontFamily.ui,
          fontSize: fontSize.sm,
          lineHeight: "22px",
          color: colors.text.primary,
          padding: spacing.md,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflowY: "auto",
        }}
      />
    </View>
  );
}

// Applies a formatting command to the current selection inside a
// contentEditable. Call from toolbar button handlers.
export function applyFormat(command: string, value?: string) {
  document.execCommand(command, false, value);
}

// Escapes plain text for safe embedding as HTML. Callers building
// `initialHtml` from plain-text sources (quoted reply/forward bodies,
// signatures) -- as opposed to already-sanitized HTML -- must run the text
// through this first: `RichTextEditor` assigns `initialHtml` straight to
// `innerHTML`, and a quoted body is attacker-controlled (the original
// sender's message text).
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Extracts plain text from an HTML string for the text/plain fallback part.
export function htmlToPlainText(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  // Replace <br> and block endings with newlines before extracting text.
  div.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  div.querySelectorAll("p, div, li, h1, h2, h3, h4, h5, h6").forEach((el) => {
    el.insertAdjacentText("afterend", "\n");
  });
  return div.textContent ?? "";
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    marginBottom: spacing.md,
    overflow: "hidden",
  },
});
