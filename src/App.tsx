import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AddAccountModal } from "./components/AddAccountModal";
import { ComposeModal, type ComposePrefill } from "./components/ComposeModal";
import { MessageList } from "./components/MessageList";
import { ReaderPane } from "./components/ReaderPane";
import { Sidebar } from "./components/Sidebar";
import { SettingsModal } from "./components/SettingsModal";
import { Splitter } from "./components/Splitter";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { formatMessageTime, getBody, type SampleMessage } from "./data/messages";
import { useBreakpoint } from "./hooks/useBreakpoint";
import { useMessageStore } from "./hooks/useMessageStore";
import { usePersistedState } from "./hooks/usePersistedState";
import type { WebViewStyle } from "./lib/webStyle";
import type { Accent } from "./theme";
import { colors, withAlpha } from "./theme";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 360;
const LIST_MIN = 280;
const LIST_MAX = 520;

export default function App() {
  const [accent, setAccent] = useState<Accent>("cyan");
  const [selectedFolder, setSelectedFolder] = useState<Record<Accent, string>>({
    cyan: "inbox",
    purple: "inbox",
  });
  // -1 = nothing selected. Cold start shouldn't reopen "the last message" --
  // there is no last message yet, so ReaderPane shows an empty state until
  // the user actually picks one.
  const [selectedId, setSelectedId] = useState(-1);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composePrefill, setComposePrefill] = useState<ComposePrefill | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [compactList, setCompactList] = useState(false);
  const [signature, setSignature] = useState("");
  // Session-only -- there's no persistence layer yet, so this isn't a real
  // first-run flag, just what gates the welcome screen vs. the shell for
  // this run of the app.
  const [onboarded, setOnboarded] = useState(false);

  const [sidebarWidth, setSidebarWidth] = usePersistedState("helix:sidebarWidth", 240);
  const [listWidth, setListWidth] = usePersistedState("helix:listWidth", 360);
  const breakpoint = useBreakpoint();
  const [sidebarOverlayOpen, setSidebarOverlayOpen] = useState(false);
  const [mobileView, setMobileView] = useState<"list" | "reader">("list");

  // A resize that crosses back out of mobile/tablet shouldn't leave the UI
  // stranded mid-reader-view or with a stale drawer flag next time it's
  // narrow again.
  useEffect(() => {
    if (breakpoint !== "mobile") setMobileView("list");
    if (breakpoint === "desktop") setSidebarOverlayOpen(false);
  }, [breakpoint]);

  const accentColor = colors.accent[accent];
  const sidebarDragStart = useRef(sidebarWidth);
  const listDragStart = useRef(listWidth);
  const store = useMessageStore();

  function selectFirstMessage(forAccent: Accent, folder: string) {
    const messages = store.getMessages(forAccent, folder);
    setSelectedId(messages[0]?.id ?? -1);
  }

  function handleAccentChange(nextAccent: Accent) {
    setAccent(nextAccent);
    selectFirstMessage(nextAccent, selectedFolder[nextAccent]);
  }

  function handleFolderChange(forAccent: Accent, folder: string) {
    setAccent(forAccent);
    setSelectedFolder((prev) => ({ ...prev, [forAccent]: folder }));
    selectFirstMessage(forAccent, folder);
  }

  function handleSelectMessage(id: number) {
    setSelectedId(id);
    if (breakpoint === "mobile") setMobileView("reader");
  }

  // Opening a message -- whether by click or by landing on the folder's
  // first message -- is what marks it read, same as any real mail client.
  useEffect(() => {
    if (selectedId === -1) return;
    store.markRead(accent, selectedFolder[accent], selectedId);
  }, [selectedId, accent, selectedFolder]);

  function handleToggleStar(id: number) {
    store.toggleStar(accent, selectedFolder[accent], id);
  }

  function handleMoveMessage(id: number, toFolder: string) {
    store.moveMessage(accent, selectedFolder[accent], id, toFolder);
    if (id === selectedId) setSelectedId(-1);
  }

  function handleMarkUnread(id: number) {
    store.markUnread(accent, selectedFolder[accent], id);
  }

  function handleReply(message: SampleMessage) {
    const quotedBody = (getBody(message.id) ?? "")
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    setComposePrefill({
      to: message.senderEmail,
      subject: message.subject.toLowerCase().startsWith("re:") ? message.subject : `Re: ${message.subject}`,
      quote: `On ${formatMessageTime(message.date)}, ${message.sender} wrote:\n${quotedBody}`,
    });
    setComposeOpen(true);
  }

  function handleComposeClose() {
    setComposeOpen(false);
    setComposePrefill(null);
  }

  function handleSidebarDrag(deltaX: number) {
    setSidebarWidth(clamp(sidebarDragStart.current + deltaX, SIDEBAR_MIN, SIDEBAR_MAX));
  }

  function handleListDrag(deltaX: number) {
    setListWidth(clamp(listDragStart.current + deltaX, LIST_MIN, LIST_MAX));
  }

  const sidebarProps = {
    accent,
    onAccentChange: handleAccentChange,
    selectedFolder,
    onFolderChange: handleFolderChange,
    onAddAccount: () => setAddAccountOpen(true),
    onCompose: () => setComposeOpen(true),
    onOpenSettings: () => setSettingsOpen(true),
  };

  const messages = store.getMessages(accent, selectedFolder[accent]);
  const messageListProps = {
    accent,
    folder: selectedFolder[accent],
    messages,
    selectedId,
    onSelect: handleSelectMessage,
    onToggleStar: handleToggleStar,
    compact: compactList,
  };
  const readerPaneProps = {
    accent,
    message: store.findMessage(accent, selectedFolder[accent], selectedId),
    avatarIndex: store.findMessageIndex(accent, selectedFolder[accent], selectedId),
    onToggleStar: handleToggleStar,
    onArchive: (id: number) => handleMoveMessage(id, "archive"),
    onMoveToSpam: (id: number) => handleMoveMessage(id, "spam"),
    onDelete: (id: number) => handleMoveMessage(id, "trash"),
    onMarkUnread: handleMarkUnread,
    onReply: handleReply,
  };

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
        {!onboarded ? (
          <WelcomeScreen accent={accent} onAddAccount={() => setAddAccountOpen(true)} onSkip={() => setOnboarded(true)} />
        ) : (
        <View style={styles.panels}>
          {breakpoint === "desktop" && (
            <>
              <Sidebar {...sidebarProps} width={sidebarWidth} />
              <Splitter
                accentColor={accentColor}
                onDragStart={() => (sidebarDragStart.current = sidebarWidth)}
                onDrag={handleSidebarDrag}
              />
              <MessageList {...messageListProps} width={listWidth} />
              <Splitter
                accentColor={accentColor}
                onDragStart={() => (listDragStart.current = listWidth)}
                onDrag={handleListDrag}
              />
              <ReaderPane {...readerPaneProps} />
            </>
          )}

          {breakpoint === "tablet" && (
            <>
              <MessageList {...messageListProps} width={listWidth} />
              <Splitter
                accentColor={accentColor}
                onDragStart={() => (listDragStart.current = listWidth)}
                onDrag={handleListDrag}
              />
              <ReaderPane {...readerPaneProps} />
            </>
          )}

          {breakpoint === "mobile" &&
            (mobileView === "list" ? (
              <MessageList {...messageListProps} width="100%" />
            ) : (
              <ReaderPane
                {...readerPaneProps}
                onBack={() => setMobileView("list")}
              />
            ))}

          {breakpoint !== "desktop" && (
            <Pressable
              onPress={() => setSidebarOverlayOpen(true)}
              style={[styles.menuButton, { borderColor: accentColor }]}
            >
              <Text style={[styles.menuButtonText, { color: accentColor }]}>&#9776;</Text>
            </Pressable>
          )}

          {breakpoint !== "desktop" && sidebarOverlayOpen && (
            <Sidebar
              {...sidebarProps}
              width={sidebarWidth}
              overlay
              onDismissOverlay={() => setSidebarOverlayOpen(false)}
            />
          )}
        </View>
        )}
      </View>
      <AddAccountModal
        visible={addAccountOpen}
        accent={accent}
        onClose={() => setAddAccountOpen(false)}
        onAdded={() => setOnboarded(true)}
      />
      <ComposeModal
        visible={composeOpen}
        accent={accent}
        signature={signature}
        prefill={composePrefill}
        onClose={handleComposeClose}
      />
      <SettingsModal
        visible={settingsOpen}
        accent={accent}
        compactList={compactList}
        onToggleCompactList={() => setCompactList((value) => !value)}
        signature={signature}
        onSignatureChange={setSignature}
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
  menuButton: {
    position: "absolute",
    top: 12,
    left: 12,
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    borderWidth: 1,
    backgroundColor: colors.background.surface,
    zIndex: 5,
  },
  menuButtonText: {
    fontSize: 14,
  },
});
