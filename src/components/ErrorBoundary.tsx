import { Component, type ErrorInfo, type ReactNode } from "react";
import { colors } from "../theme/colors";
import { fontFamily, fontSize } from "../theme/typography";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// Without this, an uncaught render error anywhere in the tree (a bad array
// index, an undefined field access, etc.) unmounts the whole app to a blank
// white screen instead of failing just the piece that broke -- this has
// happened twice now (see docs/technical/... crash write-ups), so it's worth
// a permanent backstop rather than chasing each individual null-check.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            height: "100vh",
            width: "100vw",
            backgroundColor: colors.background.base,
            color: colors.text.primary,
            fontFamily: fontFamily.ui,
            fontSize: fontSize.base,
            textAlign: "center",
            padding: 24,
          }}
        >
          <div style={{ fontFamily: fontFamily.display, fontSize: fontSize.lg }}>Something went wrong</div>
          <div style={{ color: colors.text.muted, fontSize: fontSize.sm, maxWidth: 480 }}>
            {this.state.error.message}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 8,
              padding: "8px 20px",
              borderRadius: 999,
              border: `1px solid ${colors.border.strong}`,
              background: "transparent",
              color: colors.text.primary,
              fontFamily: fontFamily.ui,
              fontSize: fontSize.sm,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
