import type { ViewStyle } from "react-native";
import { withAlpha } from "../theme";

// react-native-web passes these straight through to CSS (with vendor
// prefixing) but React Native's own types don't know about them since
// they don't exist on native. Widening locally avoids `as any` sprinkled
// through every component that wants a glass panel or a glow.
export interface WebViewStyle extends ViewStyle {
  backdropFilter?: string;
  filter?: string;
}

export function glassPanel(backgroundHex: string, alpha = 0.7, blurPx = 24): WebViewStyle {
  return {
    backgroundColor: withAlpha(backgroundHex, alpha),
    backdropFilter: `blur(${blurPx}px)`,
  };
}
