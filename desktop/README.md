# Scan2Plate Restaurant POS — Desktop Shell

A native Windows/macOS/Linux wrapper around the existing scan2plate.com web
app. This is **not** a rewrite and does **not** bundle a copy of the site —
it opens `https://scan2plate.com/admin-login.html` inside a hardened Electron
window. The web app's own code (login, dashboard, KOT, billing, everything)
runs completely unmodified; the desktop shell only adds native window/printer/
connectivity behavior around it.

## Why Electron, not Tauri

Tauri was the smaller-footprint option, but two requirements pointed at
Electron instead:

1. **Thermal printer support is an explicit near-term goal** (58mm/80mm
   direct/silent printing). Electron has a mature, well-documented path for
   this (`webContents.print({silent, deviceName})`, `getPrintersAsync()`,
   and a large ecosystem of Node ESC/POS libraries for the ThermalPrinter
   Mode this scaffold prepares for). Tauri's Rust-side printing story is
   far less mature, and this project has zero existing Rust — the backend
   is Node/Express, the frontend is vanilla JS. Building printer support in
   Rust would mean a second unfamiliar toolchain for a POS-critical feature.
2. **Zero-friction site loading.** Electron's `BrowserWindow` is a full
   Chromium instance, so `window.print()`, Firebase Auth, and every existing
   browser API the site already relies on work with no changes at all.

Cost paid for this: a larger install size than Tauri would give. Given the
audience (restaurant back-office PCs, not resource-constrained devices),
that trade was worth it.

## What this does and does not do

- Loads the real site. No copy of `public/` is bundled or shipped.
- Same Firebase project, same data, same login, whether opened from the
  desktop app or a browser — there is exactly one backend.
- Restricts top-level navigation to `scan2plate.com` — everything else opens
  in the system browser instead of inside the app window.
- Shows an offline banner / fallback screen and retries automatically; never
  reloads the whole app to "fix" a network blip.
- Remembers window size/position, prevents duplicate app instances (focuses
  the existing window instead).
- Provides a Full Screen POS Mode toggle (menu item, and `Cmd/Ctrl+Shift+F` /
  `F11`), with `Esc` always exiting it.
- Ships a small native "Printer Settings" / "About Scan2Plate" window,
  separate from the web app's own Settings page, for desktop-only
  preferences (printer choice, paper width, auto-print toggles).
- **Does not** implement actual silent/direct thermal printing yet. Browser
  Print Mode (the existing `window.print()` dialog, which already works
  unmodified) is the only wired-up print path today. The Printer Settings
  screen persists a restaurant's chosen Bill/KOT printers and paper width so
  that a future pass can wire real silent printing into it without asking
  restaurants to reconfigure anything — see "Extending to real thermal
  printing" below.
- **Does not** implement auto-update. `Settings → About Scan2Plate` shows
  version/build info now; wiring `electron-updater` to a real signed release
  feed is future work (see below) — shipping unsigned auto-update is
  explicitly unsafe and wasn't done.

## Source layout

```
desktop/
  main.js                 Electron main process: window, menu, IPC, security
  preload.js               Minimal bridge exposed to the loaded site (nothing sensitive)
  src/
    constants.js            App URL, allowed navigation hosts
    windowState.js          Remember window size/position across launches
    connectivity.js          Offline banner injection + offline fallback/retry
    settingsStore.js         Local JSON store for desktop-only preferences
  windows/
    settings.html/.js/-preload.js   Native Printer Settings + About window
    offline.html                     Shown when the app can't reach the internet
  assets/
    icon.png / icon.icns / icon.ico  Generated from public/assets/logo.PNG
  package.json              electron-builder packaging config
```

Nothing in `public/` or `backend/` was touched to build this.

## Running in development

```bash
cd desktop
npm install
npm run dev
```

`npm run dev` sets `SCAN2PLATE_DESKTOP_DEV=1`, which enables DevTools (menu
→ Developer → Toggle DevTools) — disabled in production builds.

To point the dev build at a different environment (e.g. a local backend or
Firebase emulator), set `SCAN2PLATE_DESKTOP_URL`:

```bash
SCAN2PLATE_DESKTOP_URL="http://localhost:5000/admin-login.html" npm run dev
```

## Building installers

```bash
cd desktop
npm install
npm run build:win     # Scan2Plate-Setup.exe (NSIS) + Scan2Plate.msi
npm run build:mac     # Scan2Plate.dmg
npm run build:linux   # Scan2Plate.AppImage + Scan2Plate.deb
npm run build:all     # all of the above in one pass, where the host OS allows it
```

Output lands in `desktop/dist/`.

**Cross-platform building reality check:** `electron-builder` can build a
macOS DMG only on macOS, and a Windows `.msi` reliably only on Windows (it
needs the WiX toolset). The NSIS `.exe` and Linux targets can often be
cross-built from macOS/Linux, but the safe, standard way to get all three
real installers is a CI matrix build — see
`.github/workflows/desktop-build.yml`, which builds on `windows-latest`,
`macos-latest`, and `ubuntu-latest` and uploads each installer as a workflow
artifact. It only runs when manually triggered (`workflow_dispatch`) — it
never runs on every push, and it does not touch the GitHub Pages deploy
workflow.

## Extending to real thermal (silent) printing

The scaffolding is in place but not wired to a live print call:

1. `desktop/src/settingsStore.js` already persists `billPrinter`,
   `kotPrinter`, `paperWidthMm`, and `printMode`.
2. To actually print silently, the main process would call
   `win.webContents.print({ silent: true, deviceName, ... })` in response to
   the page's print action — but that requires either (a) hooking the site's
   existing "Print Bill"/"Print KOT" buttons via a targeted preload
   injection that calls back into the main process instead of
   `window.print()`, or (b) intercepting `window.print()` itself via
   `contextBridge`. Either approach changes how printing behaves for
   restaurants who haven't configured a Bill/KOT printer, so it needs real
   hardware testing (58mm and 80mm) before it ships — that hasn't happened
   here.
3. `printMode` only ever becomes `"silent"` once both printers are selected
   (enforced both in the settings UI and again in `settingsStore.writeSettings`),
   matching the requirement that silent printing is opt-in only.

## Auto-update (future)

Not implemented. When ready: add `electron-updater`, publish signed
releases (code-signing certificates for both Windows and macOS are
required — unsigned auto-update is not something to ship), and point
`build.publish` in `package.json` at the release feed. `Settings → About
Scan2Plate` already shows the version info an update flow would compare
against.
