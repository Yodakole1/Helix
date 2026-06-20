import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { AddAccountModal } from "./components/AddAccountModal";
import { ComposeModal } from "./components/ComposeModal";
import { MessageList } from "./components/MessageList";
import { ReaderPane } from "./components/ReaderPane";
import { Sidebar } from "./components/Sidebar";
import { SettingsModal } from "./components/SettingsModal";
import type { WebViewStyle } from "./lib/webStyle";
import type { Accent } from "./theme";
import { colors, withAlpha } from "./theme";

export default function App() {
  const [accent, setAccent] = useState<Accent>("cyan");
  const [selectedId, setSelectedId] = useState(1);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [compactList, setCompactList] = useState(false);

  return (
    <>
      <View style={styles.shell}>
        {/* Ambient color behind the glass panels -- this is what makes the
            translucency in Sidebar/MessageList/ReaderPane actually visible
            instead of just tinting flat black. */}
        <View style={styles.glows} pointerEvents="none">
          <View style={[styles.glow, styles.glowCyan]} />
          <View style={[styles.glow, styles.glowPurple]} />
          <View style={[styles.glow, styles.glowGreen]} />
        </View>
        <View style={styles.panels}>
          <Sidebar
            accent={accent}
            onAccentChange={setAccent}
            onAddAccount={() => setAddAccountOpen(true)}
            onCompose={() => setComposeOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
          />
          <MessageList accent={accent} selectedId={selectedId} onSelect={setSelectedId} compact={compactList} />
          <ReaderPane accent={accent} selectedId={selectedId} />
        </View>
      </View>
      <AddAccountModal visible={addAccountOpen} accent={accent} onClose={() => setAddAccountOpen(false)} />
      <ComposeModal visible={composeOpen} accent={accent} onClose={() => setComposeOpen(false)} />
      <SettingsModal
        visible={settingsOpen}
        accent={accent}
        compactList={compactList}
        onToggleCompactList={() => setCompactList((value) => !value)}
        onClose={() => setSettingsOpen(false)}
      />
    </>
  );
}

const glow: WebViewStyle = {
  position: "absolute",
  width: 680,
  height: 680,
  borderRadius: 340,
  filter: "blur(120px)",
};

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    height: "100%",
    position: "relative",
    overflow: "hidden",
    backgroundColor: colors.background.base,
  },
  glows: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  glow,
  glowCyan: {
    top: -180,
    left: -160,
    backgroundColor: withAlpha(colors.accent.cyan, 0.75),
  },
  glowPurple: {
    top: -140,
    left: 440,
    backgroundColor: withAlpha(colors.accent.purple, 0.65),
  },
  glowGreen: {
    bottom: -300,
    left: 680,
    backgroundColor: withAlpha(colors.accent.green, 0.55),
  },
  panels: {
    flex: 1,
    height: "100%",
    flexDirection: "row",
    position: "relative",
  },
});
