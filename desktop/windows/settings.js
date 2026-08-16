"use strict";
/* global window, document */

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll("section").forEach(s => s.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
  });
});

async function populatePrinters(selectEl, printers, selectedName) {
  selectEl.innerHTML = '<option value="">Not selected</option>' + printers.map(printer =>
    `<option value="${printer.name}">${printer.displayName || printer.name}</option>`
  ).join("");
  selectEl.value = selectedName || "";
}

function updateSilentAvailability(settings) {
  const silentOption = document.getElementById("silentOption");
  const hint = document.getElementById("silentHint");
  const ready = Boolean(settings.billPrinter && settings.kotPrinter);
  silentOption.disabled = !ready;
  hint.style.display = ready ? "none" : "block";
}

async function init() {
  const [settings, printers, info] = await Promise.all([
    window.settingsBridge.getSettings(),
    window.settingsBridge.listPrinters(),
    window.settingsBridge.getAppInfo()
  ]);

  await populatePrinters(document.getElementById("billPrinter"), printers, settings.billPrinter);
  await populatePrinters(document.getElementById("kotPrinter"), printers, settings.kotPrinter);
  document.getElementById("paperWidth").value = String(settings.paperWidthMm || 80);
  document.getElementById("autoPrintKot").checked = Boolean(settings.autoPrintKot);
  document.getElementById("autoPrintBill").checked = Boolean(settings.autoPrintBill);
  document.getElementById("printMode").value = settings.printMode === "silent" ? "silent" : "browser";
  updateSilentAvailability(settings);

  document.getElementById("aboutName").textContent = info.name;
  document.getElementById("aboutVersion").textContent = info.version;
  document.getElementById("aboutBuild").textContent = info.buildVersion;
  document.getElementById("aboutElectron").textContent = info.electron;
  document.getElementById("aboutWebsite").addEventListener("click", event => {
    event.preventDefault();
    window.settingsBridge.openWebsite();
  });

  document.getElementById("savePrinterBtn").addEventListener("click", async () => {
    const billPrinter = document.getElementById("billPrinter").value;
    const kotPrinter = document.getElementById("kotPrinter").value;
    let printMode = document.getElementById("printMode").value;
    if (printMode === "silent" && !(billPrinter && kotPrinter)) printMode = "browser";
    const next = {
      billPrinter,
      kotPrinter,
      paperWidthMm: Number(document.getElementById("paperWidth").value) || 80,
      autoPrintKot: document.getElementById("autoPrintKot").checked,
      autoPrintBill: document.getElementById("autoPrintBill").checked,
      printMode,
      silentPrintConfirmed: printMode === "silent"
    };
    const saved = await window.settingsBridge.saveSettings(next);
    updateSilentAvailability(saved);
    const savedLabel = document.getElementById("printerSaved");
    savedLabel.style.display = "inline";
    setTimeout(() => { savedLabel.style.display = "none"; }, 2000);
  });
}

init();
