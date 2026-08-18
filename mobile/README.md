# Scan2Plate Restaurant POS — Android (Capacitor)

Same philosophy as `desktop/`: this does not bundle a copy of the web app.
`capacitor.config.json`'s `server.url` points the app's WebView directly at
`https://scan2plate.com/admin-login.html` — one codebase, one Firebase
project, whether a restaurant is on the website, the desktop app, or this
Android app.

## Why Capacitor

Capacitor wraps the existing frontend in a real native Android project with
a properly configured WebView (not a bare, unrestricted one) — navigation is
scoped via `server.allowNavigation` to `scan2plate.com` and its subdomains,
matching the same "restrict navigation, don't let the app open arbitrary
external sites" requirement enforced in the desktop shell. It's the standard,
actively maintained choice for wrapping an existing web app for Android
without adopting a second, separate frontend framework.

## What's actually been done here (and verified)

- `npx cap add android` was run for real — `android/` is a genuine, complete
  native Gradle project (package `com.scan2plate.restaurantpos`, app name
  "Scan2Plate Restaurant POS"), not a template placeholder.
- `android/variables.gradle` confirms the real, generated configuration:
  `minSdkVersion 24` (Android 7.0), `targetSdkVersion 36`. The public
  download page's "Android 7.0 or later" requirement text was corrected to
  match this exactly rather than a guessed number.
- Launcher icons and splash screens (light + dark, all densities) were
  generated for real via `@capacitor/assets` from the existing
  `public/assets/logo.PNG` — 92 files under `android/app/src/main/res/`.

## Offline billing (added, real, CI-verified — not device-verified)

The desktop app's offline engine (SQLite, offlineId generation, the
idempotent sync planner) has been ported here. What's real:

- **`mobile/www/offline-core.js`** — the same `OFF-<restaurantId>-
  <YYYYMMDD>-<uuid>` ID generator and idempotent `buildSyncPlan` as
  `desktop/src/offlineId.js`/`syncPlan.js`, ported to a plain UMD script (no
  build step) so it works via a raw `<script>` tag here and via `require`/
  `import` in Node tests. 12 unit tests in `mobile/www/__tests__/` (`npm
  test` in `mobile/`), mirroring desktop's test suite exactly.
- **`mobile/www/offline-db.js`** — the same schema as `desktop/src/
  offlineDb.js` (`restaurant_cache`, `menu_cache`, `tables_cache`,
  `offline_orders`), implemented against the `@capacitor-community/sqlite`
  plugin's raw native bridge (`Capacitor.Plugins.CapacitorSQLite`) rather
  than the npm-distributed `SQLiteConnection` JS wrapper, which needs a
  bundler this plain `www/` directory doesn't have.
- **`mobile/www/offline-billing.html`/`.js`** — a bundled, fully local
  billing page (table select, cached menu, cart, discount, tax, Cash/UPI/
  Card with the same "payment confirmation pending" policy as desktop for
  non-cash, `window.print()`), reachable with zero network.
- **`OfflineNavPlugin.java`** — a real native Capacitor plugin
  (`android/app/src/main/java/com/scan2plate/restaurantpos/`) that switches
  the app's single WebView between the live site and the bundled offline
  page via `WebView.loadUrl()`, since a page can't navigate itself across
  that origin boundary with plain JS. Registered in `MainActivity.java`.
  Loads the bundled page via Capacitor's own local-server origin
  (`https://localhost/offline-billing.html`), not a raw `file://` path,
  specifically so Capacitor's JS bridge is actually injected into it (see
  the plugin's own doc comment for the full reasoning).
- **`public/js/mobile-offline.js`** (on the live site, not in `mobile/`) —
  entirely inert outside the Capacitor app (`window.Capacitor?.
  isNativePlatform()` guard). While online, caches restaurant/menu/tables
  into the same on-device SQLite and uploads any bills recorded offline,
  using a duplicate of the core logic (`public/js/mobile-offline-core.js`/
  `-db.js` — real ES modules this time, matching the rest of `public/js/`,
  since that directory isn't a bundler-free zone). Parity between the two
  duplicate pairs is checked by `test/mobile-offline-core-parity.test.mjs`.

**What's not verified, and why:** this sandbox has no JRE, Android SDK, or
emulator/device (`java`, `adb`, `$ANDROID_HOME` all absent — same
limitation as the rest of this project). Every piece above was written
against the actual installed `@capacitor/android` source in
`node_modules/` (Plugin/PluginCall/Bridge APIs, the `DEFAULT_WEB_ASSET_DIR
= "public"` convention, the `localhost` default hostname) rather than
guessed, and the Gradle build is validated via the same CI workflow
(`.github/workflows/desktop-build.yml`'s `build-android` job) already used
to produce the real APK on the download page — but nobody has tapped
through this on an actual phone. In particular: whether `window.print()`
actually opens Android's native print dialog inside this WebView
configuration hasn't been confirmed on real hardware, and the `@capacitor-
community/sqlite` plugin's Android build occasionally needs an extra Gradle
repository (`jitpack.io`) depending on version — not pre-added here since
guessing wrong would be worse than letting a real CI failure name the exact
problem, matching how the desktop Linux `.deb` build issue was actually
diagnosed and fixed earlier in this project.

## What has not been done

- External links have not been specially intercepted to open in the
  system browser (the desktop shell does this via `shell.openExternal`).
  `allowNavigation` already stops the in-app WebView from navigating to
  anything outside scan2plate.com, but a nicer experience routes those
  taps to the system browser instead of just blocking them — needs the
  `@capacitor/browser` plugin, not added here.
- No release-signing keystore is configured (CI builds `assembleDebug`,
  a real installable debug-signed APK, not a Play Store release build).

## Build commands

```bash
cd mobile
npm install
npx cap sync android      # after any config/plugin change
npm run android:build         # ./gradlew assembleRelease — Scan2Plate.apk
npm run android:build:bundle  # ./gradlew bundleRelease — Scan2Plate.aab
```

Requires Android Studio or the Android command-line SDK + a JDK installed
and `ANDROID_HOME` set — none of which exist in the sandbox this was built
in.

## Data/security

Same tenant, same Firebase project, same Firestore data as the website and
desktop app — this is a distribution layer, not a second backend. No
Firebase Admin credentials, Razorpay secrets, or backend tokens are bundled
in this project.
