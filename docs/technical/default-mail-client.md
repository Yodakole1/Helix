# Default mail client (mailto: handling)

How Helix registers as the OS's mail client and what happens when a
mailto: link launches it.

## Registration (Linux)

The bundled `.desktop` file comes from a custom template
(`src-tauri/helix.desktop`, wired via `bundle.linux.deb.desktopTemplate`
and the rpm equivalent in `tauri.conf.json`) that adds two things the
default Tauri template lacks:

- `MimeType=x-scheme-handler/mailto;` -- announces Helix as a candidate
  mailto handler to the desktop environment.
- `Exec={{exec}} %u` -- passes the clicked URL as a command-line argument.

Settings > General has a "Set as default" control backed by two commands
in `src-tauri/src/mailto.rs`: `is_default_mail_client` (runs
`xdg-settings check default-url-scheme-handler mailto Helix.desktop`) and
`set_default_mail_client` (`xdg-settings set ...`). Both hop through
`run_blocking` like every other subprocess-spawning command.

macOS/Windows are not implemented: default-client registration there
goes through OS-level UIs (Launch Services / Windows default apps) and
installer metadata, so `set_default_mail_client` returns an honest error
telling the user to use the OS settings. The AppImage caveat applies on
Linux too: `xdg-settings` needs a desktop entry, which the deb/rpm
install and a bare AppImage does not.

## Launch handling

`get_launch_mailto` scans `std::env::args()` for an argument starting
with `mailto:`; App.tsx consumes it once per run (after accounts load)
and opens compose pre-filled through `parseMailto`
(`src/lib/mailto.ts`), which handles the practical RFC 6068 subset:
comma-separated addresses plus `subject`, `body`, `cc`, `bcc`, and `to`
query parameters, percent-decoded.

Known limitation: there is no single-instance forwarding. If Helix is
already running, a clicked mailto: link starts a second instance that
also opens compose -- the two processes don't conflict (every backend
command opens its own connections; the cache is one SQLite file with
normal locking) but it's not the ideal UX. Wiring
`tauri-plugin-single-instance` to forward the argument to the running
window is the known next step if this becomes annoying in practice.
