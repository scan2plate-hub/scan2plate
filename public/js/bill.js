import { db } from './firebase.js';
import {
  collection,
  doc,
  getDoc,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  qs,
  getParam,
  fmtCurrency,
  nowStr,
  escapeHtml,
  calculateOrderTotals
} from './common.js';

const billRoot = qs('#billRoot');
const orderId = getParam('orderId');
const docId = getParam('docId');

function itemDisplayName(item = {}) {
  const baseName = String(item.name || 'Item').trim() || 'Item';
  const variantName = String(item.variantName || '').trim();
  return variantName && !baseName.toLowerCase().endsWith(` ${variantName.toLowerCase()}`)
    ? `${baseName} ${variantName}`
    : baseName;
}

if (!billRoot) {
  console.error('billRoot element not found');
} else if (!orderId && !docId) {
  billRoot.innerHTML = '<p class="notice">Missing order ID.</p>';
} else {
  load();
}

function buildUpiLink(order, settings) {
  const upi = settings.upiId || '';
  const name = encodeURIComponent(settings.restaurantName || 'Restaurant');
  const note = encodeURIComponent(`Bill ${order.orderId || ''}`);
  const amount = Number(order.grandTotal || 0).toFixed(2);
  return `upi://pay?pa=${upi}&pn=${name}&am=${amount}&cu=INR&tn=${note}`;
}

function billLogoCacheKey(restaurantId = '') {
  return `scan2plate_bill_logo_${restaurantId || 'restaurant'}`;
}

function configuredLogoUrl(settings = {}) {
  return String(settings.uploadedLogoUrl || settings.restaurantLogoUrl || settings.logoUrl || '').trim();
}

function readCachedLogo(restaurantId, sourceUrl) {
  if (!sourceUrl) return '';
  try {
    const cached = JSON.parse(localStorage.getItem(billLogoCacheKey(restaurantId)) || '{}');
    return cached.sourceUrl === sourceUrl && cached.dataUrl ? cached.dataUrl : '';
  } catch {
    return '';
  }
}

function writeCachedLogo(restaurantId, sourceUrl, dataUrl) {
  if (!sourceUrl || !String(dataUrl || '').startsWith('data:image/')) return;
  try {
    localStorage.setItem(billLogoCacheKey(restaurantId), JSON.stringify({ sourceUrl, dataUrl, cachedAt: Date.now() }));
  } catch (error) {
    console.warn('Bill logo cache skipped', error);
  }
}

async function imageUrlToDataUrl(url, timeoutMs = 3000) {
  if (!url) return '';
  if (String(url).startsWith('data:image/')) return url;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { mode: 'cors', cache: 'force-cache', signal: controller.signal });
    if (!response.ok) throw new Error('Logo download failed');
    const blob = await response.blob();
    if (!String(blob.type || '').startsWith('image/')) throw new Error('Logo response is not an image');
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Logo conversion failed'));
      reader.readAsDataURL(blob);
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveBillLogo(settings = {}, restaurantId = '') {
  const sourceUrl = configuredLogoUrl(settings);
  const cachedLogo = readCachedLogo(restaurantId, sourceUrl);
  if (!sourceUrl) return '';
  try {
    const dataUrl = await imageUrlToDataUrl(sourceUrl, 3000);
    if (dataUrl) {
      writeCachedLogo(restaurantId, sourceUrl, dataUrl);
      return dataUrl;
    }
  } catch (error) {
    console.warn('Bill logo not ready; using cached/text fallback', error);
  }
  return cachedLogo || '';
}

function waitForImageLoad(image, timeoutMs = 3000) {
  if (!image || !image.src) return Promise.resolve();
  if (image.complete && image.naturalWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Image load timed out')), timeoutMs);
    image.addEventListener('load', () => { clearTimeout(timeout); resolve(); }, { once: true });
    image.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Image failed to load')); }, { once: true });
  });
}

async function printLoadedBill() {
  const logo = document.querySelector('.bill-logo');
  try {
    await waitForImageLoad(logo, 3000);
  } catch {
    logo?.remove();
  }
  window.print();
}

async function load() {
  try {
    billRoot.innerHTML = '<p class="notice">Loading bill...</p>';

    let orderDoc = null;

    // 1. First try direct Firestore doc id
    if (docId) {
      const snap = await getDoc(doc(db, 'orders', docId));
      if (snap.exists()) {
        orderDoc = snap;
      }
    }

    // 2. Fallback: search by public orderId
    if (!orderDoc && orderId) {
      const orderSnap = await getDocs(collection(db, 'orders'));
      orderDoc = orderSnap.docs.find(
        d => String(d.data().orderId || '') === String(orderId)
      ) || null;
    }

    if (!orderDoc) {
      billRoot.innerHTML = '<p class="notice">Order not found.</p>';
      return;
    }

    const order = orderDoc.data();

    const scoped = order.restaurantId
      ? await getDoc(doc(db, 'restaurants', order.restaurantId, 'settings', 'general'))
      : null;

    const root = await getDoc(doc(db, 'settings', 'general'));

    const settings = {
      restaurantName: 'Restaurant',
      taxPercent: 0,
      upiId: '',
      phone: '',
      address: '',
      logoUrl: '',
      ...(root.exists() ? root.data() : {}),
      ...(scoped && scoped.exists() ? scoped.data() : {})
    };
    const totals = calculateOrderTotals(order.items || [], settings, order);
    const billOrder = { ...order, ...totals, taxPercentSnapshot: order.taxPercentSnapshot ?? totals.taxPercent };
    const logoDataUrl = await resolveBillLogo(settings, order.restaurantId || '');

    const upiLink = buildUpiLink(billOrder, settings);

    billRoot.innerHTML = `
      <div class="bill-header">
        <div class="bill-brand">
          ${
            logoDataUrl
              ? `<img src="${escapeHtml(logoDataUrl)}" alt="logo" class="bill-logo" />`
              : ''
          }
          <div>
            <h1 style="margin:0">${escapeHtml(settings.restaurantName || 'Restaurant')}</h1>
            <div class="muted">${escapeHtml(settings.address || 'Add address in settings')}</div>
            <div class="muted">Phone: ${escapeHtml(settings.phone || '-')}</div>
            <div class="muted">Order No: ${escapeHtml(billOrder.displayOrderNo || billOrder.dailyOrderNo || '-')}</div>
            <div class="muted">Order ID: ${escapeHtml(billOrder.orderId || '-')}</div>
            <div class="muted">Date: ${nowStr(billOrder.createdAt)}</div>
          </div>
        </div>

        <div class="center">
          <div class="status status-${billOrder.paymentStatus === 'paid' ? 'served' : 'pending'}">
            ${escapeHtml(billOrder.paymentStatus || 'unpaid')}
          </div>
          <div style="margin-top:10px">
            <button class="btn btn-dark" id="printLoadedBillBtn" type="button">Print Bill</button>
          </div>
        </div>
      </div>

      <div class="grid-2" style="margin-top:16px">
        <div>
          <strong>Customer</strong>
          <div class="muted">${escapeHtml(billOrder.customerName || '-')}</div>
          <div class="muted">${escapeHtml(billOrder.customerPhone || '-')}</div>
          <div class="muted">Table ${escapeHtml(billOrder.tableNo || '-')}</div>
        </div>

        <div>
          <strong>Status</strong>
          <div class="muted">Order: ${escapeHtml(billOrder.status || 'pending')}</div>
          <div class="muted">Payment: ${escapeHtml(billOrder.paymentStatus || 'unpaid')}</div>
          <div class="muted">Source: ${escapeHtml(billOrder.source || (billOrder.isManualBill ? 'manual' : 'direct'))}</div>
        </div>
      </div>

      <table class="bill-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Qty</th>
            <th>Rate</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          ${(billOrder.items || []).map(i => `
            <tr>
              <td>${escapeHtml(itemDisplayName(i))}</td>
              <td>${Number(i.qty || 0)}</td>
              <td>${fmtCurrency(i.price || 0)}</td>
              <td>${fmtCurrency((Number(i.price || 0)) * (Number(i.qty || 0)))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <div class="grid-2" style="margin-top:18px;align-items:start">
        <div>
          <div class="notice">Scan the QR to pay with any UPI app.</div>
          <div id="qrcode" style="margin-top:16px"></div>
          <div class="small muted" style="margin-top:10px;word-break:break-all">
            ${escapeHtml(settings.upiId || 'Add UPI ID in admin settings')}
          </div>
        </div>

        <div class="card" style="background:#fafafa">
          <div class="row"><span>Items Total</span><strong>${fmtCurrency(billOrder.itemsTotal || 0)}</strong></div>
          <div class="row"><span>Tax</span><strong>${fmtCurrency(billOrder.tax || 0)}</strong></div>
          <div class="row"><span>Grand Total</span><strong>${fmtCurrency(billOrder.grandTotal || 0)}</strong></div>
        </div>
      </div>
    `;

    document.getElementById('printLoadedBillBtn')?.addEventListener('click', printLoadedBill);

    const qrWrap = document.getElementById('qrcode');
    if (qrWrap) {
      qrWrap.innerHTML = '';
      if (settings.upiId && typeof QRCode !== 'undefined') {
        new QRCode(qrWrap, {
          text: upiLink,
          width: 180,
          height: 180
        });
      } else {
        qrWrap.innerHTML = '<p class="muted">Add UPI ID in admin settings.</p>';
      }
    }
  } catch (err) {
    console.error(err);
    billRoot.innerHTML = `<p class="notice">Failed to load bill.</p>`;
  }
}
