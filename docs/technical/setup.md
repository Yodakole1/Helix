# Development setup (Linux)

## Prerequisites

- Node.js (v22+) and npm
- Rust toolchain, installed via rustup:
  ```
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  ```
- Tauri's native build dependencies (Ubuntu/Debian):
  ```
  sudo apt update
  sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```
  Other distros need different package names — check Tauri's official
  Linux prerequisites documentation for the equivalents.

## Install and run

```
npm install
npm run tauri dev
```

This compiles the Rust shell and opens a desktop window with hot reload
from the Vite dev server.

## Windows / macOS

Not set up yet. Tauri supports cross-compiling, but building and testing
on the actual target OS is the more reliable path — that work is still
ahead of us.
