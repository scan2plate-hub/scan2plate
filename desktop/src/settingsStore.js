"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

// Deliberately not using an external settings library — this is a handful
// of desktop-only preferences (printer choice, paper width, fullscreen
// default). A plain JSON file in userData is enough and keeps the
// dependency surface small.
const FILE = () => path.join(app.getPath("userData"), "desktop-settings.json");

const DEFAULTS = {
  posFullScreenByDefault: false,
  billPrinter: "",
  kotPrinter: "",
  paperWidthMm: 80,
  autoPrintKot: false,
  autoPrintBill: false,
  printMode: "preview", // "preview" | "browser" | "silent" — see readme; only "preview"/"browser" are wired to real print calls today
  silentPrintConfirmed: false
};

function readSettings() {
  try {
    const raw = fs.readFileSync(FILE(), "utf8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeSettings(next) {
  const merged = { ...readSettings(), ...next };
  // Silent printing is opt-in only, and only once both printers are chosen —
  // never let a partial/accidental write flip it on.
  if (!merged.billPrinter || !merged.kotPrinter) {
    merged.printMode = merged.printMode === "silent" ? "browser" : merged.printMode;
    merged.silentPrintConfirmed = false;
  }
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

module.exports = { readSettings, writeSettings, DEFAULTS };
