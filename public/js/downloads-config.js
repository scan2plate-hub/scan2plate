// Single source of truth for download links, consumed by both the landing
// page's device-selection modal and /download. Update this file (and the
// GitHub Release it points to) when a new build ships - nothing else in the
// HTML should ever hardcode a download URL.
window.SCAN2PLATE_DOWNLOADS = {
  version: "1.0.0",
  releaseUrl: "https://github.com/scan2plate-hub/scan2plate/releases/tag/v1.0.0",
  windows: {
    label: "Windows",
    tagline: "Scan2Plate for Windows",
    description: "For laptops and desktop PCs.",
    buttonLabel: "Download Windows App",
    fileName: "Scan2Plate-1.0.0-Windows.exe",
    url: "https://github.com/scan2plate-hub/scan2plate/releases/download/v1.0.0/Scan2Plate-1.0.0-Windows.exe",
    requirements: "Windows 10 or Windows 11 (64-bit)",
    emoji: "🪟",
    available: true
  },
  macos: {
    label: "macOS",
    tagline: "Scan2Plate for Mac",
    description: "For MacBook, iMac and Mac mini.",
    buttonLabel: "Download macOS App",
    fileName: "Scan2Plate-1.0.0-macOS.dmg",
    url: "https://github.com/scan2plate-hub/scan2plate/releases/download/v1.0.0/Scan2Plate-1.0.0-macOS.dmg",
    requirements: "macOS 11 or later. Universal build - works on Apple Silicon (M1/M2/M3/M4 and newer) and Intel Macs.",
    emoji: "🍎",
    available: true
  },
  android: {
    label: "Android",
    tagline: "Scan2Plate for Android",
    description: "For Android phones and tablets.",
    buttonLabel: "Download APK",
    fileName: "Scan2Plate-1.0.0-Android.apk",
    url: "https://github.com/scan2plate-hub/scan2plate/releases/download/v1.0.0/Scan2Plate-1.0.0-Android.apk",
    requirements: "Android 7.0 (API 24) or later",
    emoji: "🤖",
    available: true
  },
  linux: {
    label: "Linux",
    tagline: "Scan2Plate for Linux",
    description: "For Linux desktops and POS terminals.",
    buttonLabel: "Download Linux App",
    fileName: "Scan2Plate-1.0.0-Linux.AppImage",
    url: "https://github.com/scan2plate-hub/scan2plate/releases/download/v1.0.0/Scan2Plate-1.0.0-Linux.AppImage",
    requirements: "Most 64-bit distributions supporting AppImage (Ubuntu 20.04+, Fedora, Debian and derivatives)",
    emoji: "🐧",
    available: true
  }
};
