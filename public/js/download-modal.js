(function () {
  "use strict";

  function detectPlatform() {
    var ua = String(navigator.userAgent || "");
    var platform = String(navigator.platform || "");
    if (/Android/i.test(ua)) return "android";
    if (/iPhone|iPad|iPod/i.test(ua)) return null; // no iOS build exists yet - don't recommend one
    if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) return "macos";
    if (/Win/i.test(platform) || /Windows/i.test(ua)) return "windows";
    if (/Linux/i.test(platform) && !/Android/i.test(ua)) return "linux";
    return null;
  }

  function buildPlatformCard(key, info, isRecommended) {
    var card = document.createElement("div");
    card.className = "download-card" + (isRecommended ? " download-card-recommended" : "");
    card.innerHTML =
      (isRecommended ? '<span class="download-card-badge">Recommended for your device</span>' : "") +
      '<div class="download-card-emoji" aria-hidden="true">' + info.emoji + "</div>" +
      "<h3>" + info.tagline + "</h3>" +
      "<p>" + info.description + "</p>" +
      '<a class="btn btn-primary" href="' + info.url + '" download="' + info.fileName + '">' + info.buttonLabel + "</a>" +
      '<p class="download-card-meta">' + info.requirements + "</p>";
    return card;
  }

  function buildComingSoonNotice(info) {
    var el = document.createElement("div");
    el.className = "download-coming-soon";
    el.innerHTML =
      '<div class="download-card-emoji" aria-hidden="true">' + info.emoji + "</div>" +
      "<h3>" + info.tagline + " — coming soon</h3>" +
      "<p>We detected you're on " + info.label + ". This build isn't published yet, but it's on the way. Check back soon, or use one of the platforms available below in the meantime.</p>";
    return el;
  }

  function renderInto(container) {
    var config = window.SCAN2PLATE_DOWNLOADS;
    if (!container || !config) return;
    var detected = detectPlatform();
    var order = ["windows", "macos", "android", "linux"];
    var detectedInfo = detected && config[detected] ? config[detected] : null;
    // Only platforms with a real, uploaded build get a working download
    // card - a platform without one (available !== true) never links to a
    // release asset that doesn't exist yet. If the visitor's own detected
    // platform isn't ready, they still get a clear "coming soon" notice
    // naming their platform, rather than silently seeing only other
    // platforms with no explanation of why theirs is missing.
    var recommended = detectedInfo && detectedInfo.available === true ? detected : null;
    container.innerHTML = "";

    if (recommended) {
      var recSection = document.createElement("div");
      recSection.className = "download-recommended-section";
      recSection.appendChild(buildPlatformCard(recommended, config[recommended], true));
      container.appendChild(recSection);
    } else if (detectedInfo) {
      container.appendChild(buildComingSoonNotice(detectedInfo));
    }

    var otherLabel = document.createElement("p");
    otherLabel.className = "download-other-label";
    otherLabel.textContent = recommended ? "Available for other platforms" : "Available now";
    container.appendChild(otherLabel);

    var grid = document.createElement("div");
    grid.className = "download-card-grid";
    order.forEach(function (key) {
      if (key === recommended) return;
      if (!config[key] || config[key].available !== true) return;
      grid.appendChild(buildPlatformCard(key, config[key], false));
    });
    container.appendChild(grid);

    if (!grid.children.length) {
      otherLabel.textContent = "";
      var empty = document.createElement("p");
      empty.className = "download-other-label";
      empty.textContent = "Downloads are being prepared — check back soon.";
      container.appendChild(empty);
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    var modal = document.getElementById("downloadModal");
    var cardsHost = document.getElementById("downloadModalCards");
    if (modal && cardsHost) {
      renderInto(cardsHost);

      function openModal() {
        modal.classList.add("open");
        document.body.classList.add("download-modal-open");
      }
      function closeModal() {
        modal.classList.remove("open");
        document.body.classList.remove("download-modal-open");
      }

      document.querySelectorAll("[data-open-download-modal]").forEach(function (btn) {
        btn.addEventListener("click", function (event) {
          event.preventDefault();
          openModal();
        });
      });
      modal.querySelectorAll("[data-close-download]").forEach(function (btn) {
        btn.addEventListener("click", function (event) {
          event.preventDefault();
          closeModal();
        });
      });
      modal.addEventListener("click", function (event) {
        if (event.target === modal) closeModal();
      });
      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && modal.classList.contains("open")) closeModal();
      });
    }

    // /download page renders directly into a page section rather than a modal.
    var pageHost = document.getElementById("downloadPageCards");
    if (pageHost) renderInto(pageHost);
  });

  window.Scan2PlateDownloads = { detectPlatform: detectPlatform };
})();
