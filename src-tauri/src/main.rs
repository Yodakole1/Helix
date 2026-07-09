// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // WEBKIT_DISABLE_DMABUF_RENDERER=1 was tried here to fix a black-cube
  // artifact behind the title bar, but it turned out to trade that bug for
  // a worse one: WebKitGTK's non-DMA-BUF fallback compositor doesn't
  // reliably invalidate painted regions on scroll/hover, so message-list
  // rows ghosted/blurred during scroll and the black cube reappeared on
  // hover -- see docs/technical/architecture.md and the project memory on
  // this bug for the full story. Left unset until a fix is found that
  // doesn't regress the message list; re-add only alongside a fix for
  // that regression, not on its own.
  app_lib::run();
}
