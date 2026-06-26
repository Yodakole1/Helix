import DOMPurify from "dompurify";

// The one place in the frontend that injects raw HTML into the DOM
// (ReaderPane, via dangerouslySetInnerHTML) -- everything else renders
// through RN's Text/View tree, which can't carry markup at all. A real
// mail body is attacker-controlled content, so this allowlist (rather
// than a denylist) is deliberate: anything not explicitly permitted below
// is dropped, including script/style/iframe/object and any `on*` handler
// DOMPurify's own defaults already strip.
const ALLOWED_TAGS = [
  "a", "b", "i", "u", "em", "strong", "br", "p", "div", "span",
  "ul", "ol", "li", "blockquote", "pre", "code",
  "table", "thead", "tbody", "tr", "td", "th",
  "h1", "h2", "h3", "h4", "h5", "h6", "img", "hr",
];

const ALLOWED_ATTR = ["href", "src", "alt", "title", "width", "height", "style"];

export interface SanitizeOptions {
  // When true, strips the `src` off any non-data: <img> (moving the
  // original URL to data-blocked-src) instead of letting it load --
  // loading a remote image is itself the privacy leak (read receipt /
  // tracking pixel), not just a content-safety concern, so this is a
  // separate knob from the allowlist above rather than folded into it.
  blockRemoteImages: boolean;
}

export function sanitizeHtml(html: string, { blockRemoteImages }: SanitizeOptions): string {
  // addHook/removeAllHooks act on the shared DOMPurify singleton (this
  // module has no way to spin up an isolated instance), so the hook is
  // installed and torn down around a single sanitize() call rather than
  // left registered -- otherwise a later call with different options
  // would still be running this call's hook.
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
    if (blockRemoteImages && node.tagName === "IMG") {
      const src = node.getAttribute("src") ?? "";
      if (!src.startsWith("data:")) {
        node.removeAttribute("src");
        node.setAttribute("data-blocked-src", src);
      }
    }
  });

  const clean = DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR });
  DOMPurify.removeAllHooks();
  return clean;
}
