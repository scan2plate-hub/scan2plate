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

## What has not been done

- **No APK or AAB has been built.** This sandbox has no JRE and no Android
  SDK (`java`, `adb`, and `$ANDROID_HOME` are all absent) — `./gradlew
  assembleRelease` cannot run here. Building one needs Android Studio (or
  the command-line SDK + a JDK) on a machine that has them, or CI.
- **No offline billing implementation for Android yet.** The desktop app's
  offline engine (SQLite via better-sqlite3, offlineId generation, the
  idempotent sync planner) is real, tested Node code — none of it runs in a
  WebView. Porting it means: a Capacitor-compatible SQLite plugin (the
  community `@capacitor-community/sqlite` plugin is the standard choice),
  and reusing the *same* offlineId format (`OFF-<restaurantId>-<YYYYMMDD>-
  <uuid>`, via `crypto.randomUUID()` which is available natively in a
  WebView) and the *same* idempotency strategy already proven in
  `desktop/src/syncPlan.js` (check existing `offlineId`s before uploading,
  never re-upload one that's already there). That planning logic is pure
  JS with no Node-specific APIs — it can be copied into this project
  largely as-is when that work happens. Not done in this pass.
- External links have not been specially intercepted to open in the
  system browser (the desktop shell does this via `shell.openExternal`).
  `allowNavigation` already stops the in-app WebView from navigating to
  anything outside scan2plate.com, but a nicer experience routes those
  taps to the system browser instead of just blocking them — needs the
  `@capacitor/browser` plugin, not added here.

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
