// react-native-web's Pressable passes `hovered` to the style callback for
// desktop pointer support; React Native's own types only know about
// `pressed`, so we widen the shape here instead of casting at every call
// site.
export interface HoverState {
  pressed: boolean;
  hovered?: boolean;
}
