import { useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { isTauri } from "@tauri-apps/api/core";
import { addAccount, addOauthAccount, addPop3Account, oauthProviderInfo } from "../lib/account";
import { addCalDavSource, discoverCalDav, type CalDavDiscoveredCalendar } from "../lib/caldav";
import { addCardDavSource, discoverCardDav, type CardDavDiscoveredBook } from "../lib/carddav";
import { emitCalendarBus } from "../lib/calendarBus";
import { discoverServerConfig } from "../lib/discovery";
import { glassPanel } from "../lib/webStyle";
import { colors, fontFamily, fontSize, radii, spacing, withAlpha } from "../theme";
import { Switch } from "./Switch";

type Step = "form" | "services";

type ProbeStatus = "pending" | "ok" | "failed";

interface CalendarProbe {
  status: ProbeStatus;
  detail: string;
  calendars: CalDavDiscoveredCalendar[];
}

interface ContactsProbe {
  status: ProbeStatus;
  detail: string;
  books: CardDavDiscoveredBook[];
}

interface AddAccountViewProps {
  accentColor: string;
  onCancel: () => void;
  // The account (and any services the user chose) is fully added -- open
  // the inbox and let everything start syncing.
  onDone: (accountId: string) => void;
}

// Full-page account onboarding -- what used to be a blocking modal buried
// behind Settings. Step 1 is the mail form (same Thunderbird-wizard shape
// as before: name/email/password, advanced server settings on demand).
// Step 2, after the mail credentials verify, probes CalDAV (calendar) and
// CardDAV (address book) with the same credentials and shows a checkmark
// per service; Continue adds whatever worked and opens the inbox. Mail is
// the gate: if it fails, nothing is added and the user stays on the form.
export function AddAccountView({ accentColor, onCancel, onDone }: AddAccountViewProps) {
  const [step, setStep] = useState<Step>("form");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [protocol, setProtocol] = useState<"imap" | "pop3">("imap");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [imapUseStarttls, setImapUseStarttls] = useState(false);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("465");
  const [smtpUseStarttls, setSmtpUseStarttls] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  // OAuth sign-in (Gmail / Microsoft 365): which provider's browser flow is
  // running, and -- for builds shipped without a registered client ID --
  // the user-supplied one. See docs/technical/oauth.md.
  const [oauthSubmitting, setOauthSubmitting] = useState<"gmail" | "microsoft" | null>(null);
  const [oauthNeedsClient, setOauthNeedsClient] = useState<"gmail" | "microsoft" | null>(null);
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");

  const [calendarProbe, setCalendarProbe] = useState<CalendarProbe>({ status: "pending", detail: "", calendars: [] });
  const [contactsProbe, setContactsProbe] = useState<ContactsProbe>({ status: "pending", detail: "", books: [] });
  const [finishing, setFinishing] = useState(false);
  // Failures from adding discovered DAV sources on Continue, and the ones
  // that succeeded (so retrying after a partial failure can't duplicate).
  const [addErrors, setAddErrors] = useState<string[]>([]);
  const addedSources = useRef<Set<string>>(new Set());

  const advancedOpen = showAdvanced || protocol === "pop3";
  const canSubmit =
    email.trim().length > 0 &&
    password.length > 0 &&
    (!advancedOpen || (imapHost.trim().length > 0 && smtpHost.trim().length > 0)) &&
    !submitting;

  // Hosts worth asking for CalDAV/CardDAV: the mail domain itself first
  // (RFC 6764 .well-known discovery), then the mail server, which small
  // hosts often reuse for DAV services.
  function davHostCandidates(): string[] {
    const domain = email.trim().split("@")[1] ?? "";
    return [...new Set([domain, imapHost.trim()].filter((h) => h.length > 0))];
  }

  async function probeCalendar() {
    for (const host of davHostCandidates()) {
      try {
        const calendars = await discoverCalDav({ host, username: email.trim(), password });
        if (calendars.length > 0) {
          setCalendarProbe({
            status: "ok",
            detail: calendars.length === 1 ? "1 calendar found" : `${calendars.length} calendars found`,
            calendars,
          });
          return;
        }
      } catch {
        // try the next candidate
      }
    }
    setCalendarProbe({ status: "failed", detail: "No CalDAV service answered with these credentials", calendars: [] });
  }

  async function probeContacts() {
    for (const host of davHostCandidates()) {
      try {
        const books = await discoverCardDav(host, email.trim(), password);
        if (books.length > 0) {
          setContactsProbe({
            status: "ok",
            detail: books.length === 1 ? "1 address book found" : `${books.length} address books found`,
            books,
          });
          return;
        }
      } catch {
        // try the next candidate
      }
    }
    setContactsProbe({ status: "failed", detail: "No CardDAV service answered with these credentials", books: [] });
  }

  async function handleConnect() {
    if (!isTauri()) {
      setErrorMessage("Account connections only work inside the desktop app. Run 'npm run tauri dev' to use real accounts.");
      return;
    }
    setSubmitting(true);
    setErrorMessage("");
    try {
      if (protocol === "pop3") {
        await addPop3Account({
          accountId: email.trim(),
          password,
          displayName: name.trim() === "" ? null : name.trim(),
          pop3Host: imapHost.trim(),
          pop3Port: Number(imapPort),
          smtpHost: smtpHost.trim(),
          smtpPort: Number(smtpPort),
          smtpUseStarttls,
        });
      } else {
        let imap = { host: imapHost.trim(), port: Number(imapPort) };
        let smtp = { host: smtpHost.trim(), port: Number(smtpPort) };
        let useStarttls = smtpUseStarttls;
        let imapStarttls = imapUseStarttls;

        // Advanced settings, once expanded, are the user's explicit choice
        // and always win -- auto-discovery only runs otherwise.
        if (!showAdvanced) {
          const discovered = await discoverServerConfig(email.trim());
          imap = discovered.imap;
          smtp = discovered.smtp;
          useStarttls = discovered.smtpUseStarttls;
          imapStarttls = false;
        }

        await addAccount({
          accountId: email.trim(),
          password,
          displayName: name.trim() === "" ? null : name.trim(),
          imapHost: imap.host,
          imapPort: imap.port,
          imapUseStarttls: imapStarttls,
          smtpHost: smtp.host,
          smtpPort: smtp.port,
          smtpUseStarttls: useStarttls,
          archiveFolder: null,
          trashFolder: null,
          draftsFolder: null,
          spamFolder: null,
          sentFolder: null,
        });
      }

      // Mail verified and stored -- probe the sibling services with the
      // same credentials while the user watches the checklist fill in.
      setStep("services");
      probeCalendar();
      probeContacts();
    } catch (err) {
      const msg = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
      if (msg.includes("invoke") || msg.includes("TAURI")) {
        setErrorMessage("This feature only works inside the desktop app. Run 'npm run tauri dev'.");
      } else {
        setErrorMessage(msg);
      }
    } finally {
      setSubmitting(false);
    }
  }

  // OAuth path: the whole browser consent flow, verification, and account
  // persistence run in one backend call. Gmail/Microsoft don't offer
  // password-authenticated CalDAV/CardDAV, so the probe step is skipped --
  // a checklist that always fails would just look broken.
  async function handleOauth(provider: "gmail" | "microsoft") {
    if (!isTauri()) {
      setErrorMessage("Account connections only work inside the desktop app. Run 'npm run tauri dev' to use real accounts.");
      return;
    }
    setErrorMessage("");
    try {
      const info = await oauthProviderInfo(provider);
      if (!info.has_builtin_client_id && oauthClientId.trim() === "") {
        setOauthNeedsClient(provider);
        return;
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      return;
    }
    setOauthSubmitting(provider);
    try {
      await addOauthAccount({
        accountId: email.trim(),
        provider,
        displayName: name.trim() === "" ? null : name.trim(),
        clientId: oauthClientId.trim() === "" ? null : oauthClientId.trim(),
        clientSecret: oauthClientSecret.trim() === "" ? null : oauthClientSecret.trim(),
      });
      onDone(email.trim());
    } catch (err) {
      const msg = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
    } finally {
      setOauthSubmitting(null);
    }
  }

  const canOauth = email.trim().length > 0 && !submitting && oauthSubmitting === null;

  const probing = calendarProbe.status === "pending" || contactsProbe.status === "pending";
  const anyFailed = calendarProbe.status === "failed" || contactsProbe.status === "failed";

  // Adds whatever the probes found. A service that discovered fine but
  // fails to add shouldn't block reaching the inbox, but it must not fail
  // silently either -- the user just watched "1 calendar found" tick green,
  // so a swallowed rollback here reads later as "my calendar got deleted".
  // First failure shows the errors and turns the button into "Continue
  // anyway"; sources that did land are remembered so a retry can't add
  // them twice.
  async function handleContinue() {
    setFinishing(true);
    const accountId = email.trim();
    const failures: string[] = [];
    for (const calendar of calendarProbe.calendars) {
      const doneKey = `caldav:${calendar.url}`;
      if (addedSources.current.has(doneKey)) continue;
      try {
        await addCalDavSource({
          accountId,
          url: calendar.url,
          username: accountId,
          password,
          displayName: calendar.display_name ?? undefined,
        });
        addedSources.current.add(doneKey);
      } catch (e) {
        console.warn("add_caldav_source failed:", e);
        failures.push(`Calendar "${calendar.display_name ?? calendar.url}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (calendarProbe.calendars.length > 0) emitCalendarBus("sources-changed");
    for (const book of contactsProbe.books) {
      const doneKey = `carddav:${book.url}`;
      if (addedSources.current.has(doneKey)) continue;
      try {
        await addCardDavSource(accountId, book.url, accountId, password, book.display_name);
        addedSources.current.add(doneKey);
      } catch (e) {
        console.warn("add_carddav_source failed:", e);
        failures.push(`Address book "${book.display_name ?? book.url}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setFinishing(false);
    if (failures.length > 0 && addErrors.length === 0) {
      setAddErrors(failures);
      return;
    }
    onDone(accountId);
  }

  function probeRow(label: string, probe: { status: ProbeStatus; detail: string }) {
    return (
      <View style={styles.serviceRow}>
        <View
          style={[
            styles.serviceMark,
            probe.status === "ok" && { backgroundColor: withAlpha(colors.accent.green, 0.18) },
            probe.status === "failed" && { backgroundColor: withAlpha(colors.accent.amber, 0.16) },
          ]}
        >
          {probe.status === "pending" && <Text style={styles.serviceMarkPending}>&#8943;</Text>}
          {probe.status === "ok" && (
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.accent.green} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
          {probe.status === "failed" && (
            <svg width={13} height={13} viewBox="0 0 24 24" stroke={colors.accent.amber} strokeWidth={2.2} strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          )}
        </View>
        <View style={styles.serviceText}>
          <Text style={styles.serviceLabel}>{label}</Text>
          <Text style={styles.serviceDetail}>
            {probe.status === "pending" ? "Checking..." : probe.detail}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={styles.pane} contentContainerStyle={styles.paneContent}>
      <View style={styles.card}>
        {step === "form" && (
          <>
            <Text style={styles.title}>Connect an account</Text>
            <Text style={styles.subtitle}>
              Your password goes straight to your OS keychain and the connection is verified before anything is
              saved.
            </Text>

            <Text style={styles.label}>Display name</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="Work"
              placeholderTextColor={colors.text.muted}
            />

            <Text style={styles.label}>Email address</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={colors.text.muted}
              autoCapitalize="none"
              keyboardType="email-address"
            />

            <Text style={styles.label}>Password</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="App password or account password"
              placeholderTextColor={colors.text.muted}
              secureTextEntry
            />

            <View style={styles.oauthBlock}>
              <Text style={styles.oauthLead}>
                Gmail or Microsoft 365? Sign in through your browser instead -- no app password needed.
              </Text>
              <View style={styles.oauthRow}>
                {(["gmail", "microsoft"] as const).map((provider) => (
                  <Pressable
                    key={provider}
                    onPress={() => handleOauth(provider)}
                    disabled={!canOauth}
                    style={[styles.oauthButton, !canOauth && styles.primaryButtonDisabled]}
                  >
                    <Text style={styles.oauthButtonText}>
                      {oauthSubmitting === provider
                        ? "Waiting for browser..."
                        : provider === "gmail"
                          ? "Sign in with Google"
                          : "Sign in with Microsoft"}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {oauthSubmitting !== null && (
                <Text style={styles.hint}>
                  Finish signing in to {oauthSubmitting === "gmail" ? "Google" : "Microsoft"} in the browser window
                  that just opened. Helix picks up automatically when you're done.
                </Text>
              )}
              {oauthNeedsClient !== null && (
                <View>
                  <Text style={styles.hint}>
                    This build ships without a registered {oauthNeedsClient === "gmail" ? "Google" : "Microsoft"} OAuth
                    client. Paste your own client ID (docs/technical/oauth.md explains how to register one), then try
                    again.
                  </Text>
                  <Text style={styles.label}>OAuth client ID</Text>
                  <TextInput
                    style={[styles.input, styles.mono]}
                    value={oauthClientId}
                    onChangeText={setOauthClientId}
                    autoCapitalize="none"
                    placeholder="xxxxxxxx.apps.googleusercontent.com"
                    placeholderTextColor={colors.text.muted}
                  />
                  {oauthNeedsClient === "gmail" && (
                    <>
                      <Text style={styles.label}>OAuth client secret</Text>
                      <TextInput
                        style={[styles.input, styles.mono]}
                        value={oauthClientSecret}
                        onChangeText={setOauthClientSecret}
                        autoCapitalize="none"
                        secureTextEntry
                        placeholder="Desktop-app clients get one from Google"
                        placeholderTextColor={colors.text.muted}
                      />
                    </>
                  )}
                </View>
              )}
            </View>

            <Text style={styles.label}>Incoming protocol</Text>
            <View style={styles.protocolRow}>
              {(["imap", "pop3"] as const).map((option) => {
                const active = protocol === option;
                return (
                  <Pressable
                    key={option}
                    onPress={() => {
                      setProtocol(option);
                      if (option === "pop3" && imapPort === "993") setImapPort("995");
                      if (option === "imap" && imapPort === "995") setImapPort("993");
                    }}
                    style={[styles.protocolPill, active && { backgroundColor: accentColor, borderColor: accentColor }]}
                  >
                    <Text style={[styles.protocolPillText, active && { color: colors.background.base }]}>
                      {option === "imap" ? "IMAP" : "POP3"}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {protocol === "imap" && (
              <Pressable onPress={() => setShowAdvanced((value) => !value)} style={styles.advancedToggle}>
                <Text style={[styles.advancedToggleText, { color: accentColor }]}>
                  {showAdvanced ? "Hide" : "Show"} advanced server settings
                </Text>
              </Pressable>
            )}
            {protocol === "pop3" && (
              <Text style={styles.hint}>POP3 has no auto-discovery -- enter your server settings below.</Text>
            )}

            {advancedOpen && (
              <View style={styles.advanced}>
                <View style={styles.row}>
                  <View style={styles.col}>
                    <Text style={styles.label}>{protocol === "pop3" ? "POP3 host" : "IMAP host"}</Text>
                    <TextInput
                      style={[styles.input, styles.mono]}
                      value={imapHost}
                      onChangeText={setImapHost}
                      placeholder={protocol === "pop3" ? "pop.example.com" : "imap.example.com"}
                      placeholderTextColor={colors.text.muted}
                      autoCapitalize="none"
                    />
                  </View>
                  <View style={styles.colNarrow}>
                    <Text style={styles.label}>Port</Text>
                    <TextInput
                      style={[styles.input, styles.mono]}
                      value={imapPort}
                      onChangeText={setImapPort}
                      keyboardType="number-pad"
                    />
                  </View>
                </View>
                {protocol === "imap" && (
                  <View style={styles.starttlsRow}>
                    <Switch value={imapUseStarttls} onChange={() => setImapUseStarttls((value) => !value)} color={accentColor} />
                    <Text style={styles.starttlsLabel}>IMAP uses STARTTLS, not implicit TLS</Text>
                  </View>
                )}
                <View style={styles.row}>
                  <View style={styles.col}>
                    <Text style={styles.label}>SMTP host</Text>
                    <TextInput
                      style={[styles.input, styles.mono]}
                      value={smtpHost}
                      onChangeText={setSmtpHost}
                      placeholder="smtp.example.com"
                      placeholderTextColor={colors.text.muted}
                      autoCapitalize="none"
                    />
                  </View>
                  <View style={styles.colNarrow}>
                    <Text style={styles.label}>Port</Text>
                    <TextInput
                      style={[styles.input, styles.mono]}
                      value={smtpPort}
                      onChangeText={setSmtpPort}
                      keyboardType="number-pad"
                    />
                  </View>
                </View>
                <View style={styles.starttlsRow}>
                  <Switch value={smtpUseStarttls} onChange={() => setSmtpUseStarttls((value) => !value)} color={accentColor} />
                  <Text style={styles.starttlsLabel}>SMTP uses STARTTLS, not implicit TLS</Text>
                </View>
              </View>
            )}

            {errorMessage !== "" && <Text style={styles.error}>{errorMessage}</Text>}

            <View style={styles.actions}>
              <Pressable onPress={onCancel} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleConnect}
                disabled={!canSubmit}
                style={[styles.primaryButton, { backgroundColor: accentColor }, !canSubmit && styles.primaryButtonDisabled]}
              >
                <Text style={styles.primaryButtonText}>{submitting ? "Connecting..." : "Connect"}</Text>
              </Pressable>
            </View>
          </>
        )}

        {step === "services" && (
          <>
            <Text style={styles.title}>Sync your calendar and address book</Text>
            <Text style={styles.subtitle}>
              Mail is connected. Helix is checking whether {email.trim().split("@")[1] ?? "your provider"} also
              offers a calendar (CalDAV) and an address book (CardDAV) with the same credentials.
            </Text>

            <View style={styles.serviceList}>
              {probeRow("Mail", { status: "ok", detail: "Connected and verified" })}
              {probeRow("Calendar", calendarProbe)}
              {probeRow("Address book", contactsProbe)}
            </View>

            {addErrors.length > 0 && (
              <View>
                {addErrors.map((err) => (
                  <Text key={err} style={styles.error}>{err}</Text>
                ))}
                <Text style={styles.hint}>
                  These couldn't be added right now -- you can connect them later from Settings.
                  Continue to your inbox with everything that worked?
                </Text>
              </View>
            )}

            {!probing && anyFailed && (
              <Text style={styles.hint}>
                {[
                  calendarProbe.status === "failed" ? "calendar" : null,
                  contactsProbe.status === "failed" ? "address book" : null,
                ]
                  .filter(Boolean)
                  .join(" and ")}{" "}
                sync didn't work -- your provider may not offer it. Do you want to continue with what worked?
                Everything that connected will be added; you can add the rest later from Settings.
              </Text>
            )}

            <View style={styles.actions}>
              <Pressable onPress={() => onDone(email.trim())} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>Skip, just mail</Text>
              </Pressable>
              <Pressable
                onPress={handleContinue}
                disabled={probing || finishing}
                style={[
                  styles.primaryButton,
                  { backgroundColor: accentColor },
                  (probing || finishing) && styles.primaryButtonDisabled,
                ]}
              >
                <Text style={styles.primaryButtonText}>
                  {probing ? "Checking..." : finishing ? "Adding..." : addErrors.length > 0 ? "Continue anyway" : anyFailed ? "Yes, continue" : "Continue"}
                </Text>
              </Pressable>
            </View>
          </>
        )}
      </View>
    </ScrollView>
  );
}

const cardGlass = glassPanel(colors.background.panel, 0.5, 24);

const styles = StyleSheet.create({
  pane: {
    flex: 1,
    height: "100%",
  },
  paneContent: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
  },
  card: {
    width: "100%",
    maxWidth: 520,
    padding: spacing.xl,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border.strong,
    ...cardGlass,
  },
  title: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.xl,
    fontWeight: "600",
    color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  subtitle: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    lineHeight: 20,
    marginBottom: spacing.lg,
  },
  label: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    marginBottom: spacing.xs,
  },
  input: {
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text.primary,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    marginBottom: spacing.md,
  },
  mono: {
    fontFamily: fontFamily.mono,
  },
  advancedToggle: {
    marginBottom: spacing.md,
  },
  advancedToggleText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
  protocolRow: {
    flexDirection: "row",
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  protocolPill: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border.subtle,
  },
  protocolPillText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.text.secondary,
  },
  hint: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    marginBottom: spacing.md,
    lineHeight: 18,
  },
  advanced: {
    marginBottom: spacing.sm,
  },
  oauthBlock: {
    marginTop: spacing.xs,
    marginBottom: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border.subtle,
  },
  oauthLead: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    marginBottom: spacing.sm,
    lineHeight: 18,
  },
  oauthRow: {
    flexDirection: "row",
    marginBottom: spacing.sm,
  },
  oauthButton: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: withAlpha(colors.background.panel, 0.6),
    alignItems: "center",
    marginRight: spacing.sm,
  },
  oauthButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.text.primary,
  },
  row: {
    flexDirection: "row",
  },
  col: {
    flex: 1,
    marginRight: spacing.sm,
  },
  colNarrow: {
    width: 88,
  },
  starttlsRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.xs,
    marginBottom: spacing.md,
  },
  starttlsLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    marginLeft: spacing.sm,
  },
  error: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.accent.amber,
    marginBottom: spacing.md,
  },
  serviceList: {
    marginBottom: spacing.lg,
  },
  serviceRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  serviceMark: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background.surface,
    marginRight: spacing.md,
  },
  serviceMarkPending: {
    color: colors.text.muted,
    fontSize: fontSize.sm,
  },
  serviceText: {
    flex: 1,
  },
  serviceLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.primary,
  },
  serviceDetail: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: spacing.sm,
  },
  secondaryButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.sm,
    marginRight: spacing.sm,
  },
  secondaryButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.secondary,
  },
  primaryButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.sm,
  },
  primaryButtonDisabled: {
    opacity: 0.4,
  },
  primaryButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.background.base,
  },
});
