interface LogoProps {
  size?: number;
  color: string;
}

// Double-helix mark: two mirrored sine strands with rungs at the crossing
// points, doubling as a stylized "H" for Helix.
//
// Plain DOM SVG rather than react-native-svg: the latter's web build pulls
// in Fabric/TurboModule-only files that don't bundle under Vite. Fine for
// now since this only runs on the web/Tauri target -- revisit with
// react-native-svg (or a Metro-based setup) when porting to native RN.
export function Logo({ size = 20, color }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M5,2 C5,4.5 19,4.5 19,7 C19,9.5 5,9.5 5,12 C5,14.5 19,14.5 19,17 C19,19.5 5,19.5 5,22"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
      />
      <path
        d="M19,2 C19,4.5 5,4.5 5,7 C5,9.5 19,9.5 19,12 C19,14.5 5,14.5 5,17 C5,19.5 19,19.5 19,22"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeOpacity={0.5}
      />
      <line x1={10} y1={4.5} x2={14} y2={4.5} stroke={color} strokeWidth={1.5} strokeLinecap="round" />
      <line x1={10} y1={9.5} x2={14} y2={9.5} stroke={color} strokeWidth={1.5} strokeLinecap="round" />
      <line x1={10} y1={14.5} x2={14} y2={14.5} stroke={color} strokeWidth={1.5} strokeLinecap="round" />
      <line x1={10} y1={19.5} x2={14} y2={19.5} stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    </svg>
  );
}
