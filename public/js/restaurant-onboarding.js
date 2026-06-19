import { db } from "./firebase.js";
import {
  doc,
  getDoc,
  collection,
  getDocs,
  query,
  orderBy,
  updateDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { qs, escapeHtml } from "./common.js";

const restaurantIdEl = qs("#restaurantId");
const loadBtn = qs("#loadBtn");
const sheetRoot = qs("#sheetRoot");

loadBtn?.addEventListener("click", async () => {
  try {
    const restaurantId = restaurantIdEl?.value.trim();
    if (!restaurantId) return alert("Enter restaurant ID");

    // 🔹 Fetch data
    const restSnap = await getDoc(doc(db, "restaurants", restaurantId));
    if (!restSnap.exists()) {
      sheetRoot.innerHTML = `<p class="notice">Restaurant not found.</p>`;
      return;
    }

    const settingsSnap = await getDoc(
      doc(db, "restaurants", restaurantId, "settings", "general")
    );

    const tablesSnap = await getDocs(
      query(
        collection(db, "restaurants", restaurantId, "tables"),
        orderBy("tableNo", "asc")
      )
    );

    const rest = restSnap.data();
    const settings = settingsSnap.exists() ? settingsSnap.data() : {};
    const tables = tablesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const currentPlan = String(rest.plan || settings.plan || "basic").toLowerCase();

    // 🔹 UI Render
    sheetRoot.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap">
        
        <div>
          <h2 style="margin:0">${escapeHtml(rest.name || restaurantId)}</h2>

          <div class="muted" style="margin-top:6px">${escapeHtml(rest.address || "-")}</div>
          <div class="muted">Owner: ${escapeHtml(rest.ownerName || "-")}</div>
          <div class="muted">Phone: ${escapeHtml(rest.phone || "-")}</div>
          <div class="muted">Email: ${escapeHtml(rest.email || "-")}</div>

          <div class="muted">
            Plan:
            <span id="currentPlanText" style="
              padding:4px 10px;
              border-radius:999px;
              font-weight:700;
              background:${currentPlan === "advance" ? "#d3f9d8" : "#fff3bf"};
              color:${currentPlan === "advance" ? "#2b8a3e" : "#e67700"};
            ">
              ${escapeHtml(currentPlan)}
            </span>
          </div>

          <div class="muted">Status: ${escapeHtml(rest.status || "active")}</div>
          <div class="muted">Expiry: ${escapeHtml(rest.expiryDate || "-")}</div>

          <!-- 🔥 PLAN CONTROL -->
          <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
            <select id="planSelect" class="field" style="max-width:180px;margin:0">
              <option value="basic" ${currentPlan === "basic" ? "selected" : ""}>Basic</option>
              <option value="advance" ${currentPlan === "advance" ? "selected" : ""}>Advance</option>
            </select>

            <button id="savePlanBtn" class="btn btn-dark">Save Plan</button>
          </div>
        </div>

        <div>
          <div><strong>Restaurant ID:</strong> ${escapeHtml(restaurantId)}</div>
          <div><strong>UPI ID:</strong> ${escapeHtml(settings.upiId || "-")}</div>
          <div><strong>Tax %:</strong> ${escapeHtml(String(settings.taxPercent ?? 5))}</div>
          <div><strong>Kitchen WhatsApp:</strong> ${escapeHtml(settings.kitchenWhatsApp || "-")}</div>
        </div>
      </div>

      <hr style="margin:20px 0">

      <h3>Table QR Summary</h3>
      <div id="tableQrGrid" class="menu-grid"></div>
    `;

    // 🔹 Plan update logic
    const saveBtn = document.getElementById("savePlanBtn");
    const planSelect = document.getElementById("planSelect");
    const planText = document.getElementById("currentPlanText");

    saveBtn?.addEventListener("click", async () => {
      try {
        const nextPlan = String(planSelect.value || "basic").toLowerCase();

        saveBtn.disabled = true;
        saveBtn.style.opacity = "0.6";
        saveBtn.textContent = "Saving...";

        await updateDoc(doc(db, "restaurants", restaurantId), {
          plan: nextPlan,
          updatedAt: serverTimestamp()
        });

        // 🔥 Update UI instantly
        planText.textContent = nextPlan;

        if (nextPlan === "advance") {
          planText.style.background = "#d3f9d8";
          planText.style.color = "#2b8a3e";
        } else {
          planText.style.background = "#fff3bf";
          planText.style.color = "#e67700";
        }

        saveBtn.textContent = "Saved ✅";

        setTimeout(() => {
          saveBtn.textContent = "Save Plan";
        }, 2000);

      } catch (err) {
        console.error("plan update error", err);
        alert("Failed to update plan: " + err.message);
      } finally {
        saveBtn.disabled = false;
        saveBtn.style.opacity = "1";
      }
    });

    // 🔹 QR Table render
    const tableQrGrid = document.getElementById("tableQrGrid");

    if (!tables.length) {
      tableQrGrid.innerHTML = `<p class="muted">No table QR records found.</p>`;
      return;
    }

    tables.forEach(t => {
      const safeId = String(t.tableNo || t.id).replace(/[^a-zA-Z0-9_-]/g, "_");

      const box = document.createElement("div");
      box.className = "card";
      box.style.padding = "16px";

      box.innerHTML = `
        <div style="text-align:center">
          <div style="font-weight:700">${escapeHtml(rest.name || restaurantId)}</div>
          <div class="muted">Table ${escapeHtml(t.tableNo || t.id)}</div>

          <div id="qr-${safeId}" style="margin:16px auto;width:150px;height:150px"></div>

          <div class="small muted" style="word-break:break-all">
            ${escapeHtml(t.qrUrl || "")}
          </div>
        </div>
      `;

      tableQrGrid.appendChild(box);

      if (t.qrUrl) {
        new QRCode(box.querySelector(`#qr-${safeId}`), {
          text: t.qrUrl,
          width: 150,
          height: 150
        });
      }
    });

  } catch (err) {
    console.error(err);
    sheetRoot.innerHTML = `<p class="notice">Failed to load onboarding sheet.</p>`;
  }
});