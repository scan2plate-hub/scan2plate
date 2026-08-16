"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, screen } = require("electron");

const STATE_FILE = () => path.join(app.getPath("userData"), "window-state.json");

const DEFAULTS = { width: 1360, height: 860, x: undefined, y: undefined, isFullScreen: false };

function loadWindowState() {
  try {
    const raw = fs.readFileSync(STATE_FILE(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULTS };
    const state = { ...DEFAULTS, ...parsed };

    // Guard against a saved position that no longer exists (external monitor
    // unplugged, resolution changed) — fall back to defaults rather than
    // opening the window off-screen and unreachable.
    if (Number.isFinite(state.x) && Number.isFinite(state.y)) {
      const visible = screen.getAllDisplays().some(display => {
        const bounds = display.bounds;
        return state.x >= bounds.x && state.x < bounds.x + bounds.width && state.y >= bounds.y && state.y < bounds.y + bounds.height;
      });
      if (!visible) { state.x = undefined; state.y = undefined; }
    }
    return state;
  } catch {
    return { ...DEFAULTS };
  }
}

function saveWindowState(win) {
  try {
    if (!win || win.isDestroyed()) return;
    const isFullScreen = win.isFullScreen();
    const bounds = win.isMaximized() || isFullScreen ? win.getNormalBounds() : win.getBounds();
    const state = { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y, isFullScreen };
    fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
    fs.writeFileSync(STATE_FILE(), JSON.stringify(state), "utf8");
  } catch {
    // Non-fatal — window position/size just won't be remembered next launch.
  }
}

module.exports = { loadWindowState, saveWindowState };
