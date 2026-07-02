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
const isDevHost = ['localhost', '127.0.0.1'].includes(location.hostname);
const devLog = (...args) => { if (isDevHost) console.log('[Scan2Plate Bill]', ...args); };

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
  return String(settings.uploadedLogoUrl || settings.restaurantLogoUrl || settings.logoUrl || settings.logo || '').trim();
}

function cleanSettingText(value = '') {
  const text = String(value ?? '').trim();
  return /^(undefined|null)$/i.test(text) ? '' : text;
}

function normalizeLogoDataUrl(value = '') {
  const raw = cleanSettingText(value);
  if (!raw) return '';
  if (raw.startsWith('data:image/')) return raw;
  if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.length > 80) return `data:image/png;base64,${raw.replace(/\s+/g, '')}`;
  return '';
}

function logoDebugFields(settings = {}, restaurantId = '') {
  return {
    logo: cleanSettingText(settings.logo),
    logoUrl: cleanSettingText(settings.logoUrl),
    uploadedLogoUrl: cleanSettingText(settings.uploadedLogoUrl || settings.restaurantLogoUrl),
    logoBase64: Boolean(normalizeLogoDataUrl(settings.logoBase64)),
    logoDataUrl: Boolean(normalizeLogoDataUrl(settings.logoDataUrl)),
    cachedLogo: Boolean(readCachedLogo(restaurantId, configuredLogoUrl(settings)))
  };
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

function writeRemoteLogoFallback(restaurantId, sourceUrl) {
  if (!sourceUrl) return;
  try {
    localStorage.setItem(billLogoCacheKey(restaurantId), JSON.stringify({ sourceUrl, remoteUrlFallback: true, cachedAt: Date.now() }));
  } catch {}
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
  const savedLogo = normalizeLogoDataUrl(settings.logoBase64) || normalizeLogoDataUrl(settings.logoDataUrl);
  const sourceUrl = configuredLogoUrl(settings);
  const cachedLogo = readCachedLogo(restaurantId, sourceUrl);
  let cachedRemoteFallback = false;
  try {
    const cached = JSON.parse(localStorage.getItem(billLogoCacheKey(restaurantId)) || '{}');
    cachedRemoteFallback = Boolean(sourceUrl && cached.sourceUrl === sourceUrl && cached.remoteUrlFallback);
  } catch {}
  devLog('Print bill logo fields', logoDebugFields(settings, restaurantId));
  if (savedLogo) {
    devLog('Bill logo source used', 'settings.logoBase64/logoDataUrl');
    return savedLogo;
  }
  if (!sourceUrl) return '';
  if (cachedLogo) {
    devLog('Bill logo source used', 'cachedLogo');
    return cachedLogo;
  }
  if (cachedRemoteFallback) {
    devLog('Bill logo source used', 'cachedRemoteUrlFallback');
    return sourceUrl;
  }
  try {
    const dataUrl = await imageUrlToDataUrl(sourceUrl, 3000);
    if (dataUrl) {
      writeCachedLogo(restaurantId, sourceUrl, dataUrl);
      devLog('Bill logo source used', sourceUrl === String(settings.uploadedLogoUrl || settings.restaurantLogoUrl || '').trim() ? 'settings.uploadedLogoUrl' : 'settings.logoUrl/settings.logo');
      return dataUrl;
    }
  } catch (error) {
    devLog('Bill logo not ready; using cached/text fallback', error);
  }
  if (sourceUrl) {
    writeRemoteLogoFallback(restaurantId, sourceUrl);
    devLog('Bill logo source used', 'remoteUrlFallback');
    return sourceUrl;
  }
  return '';
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
    if (logo?.src) {
      const image = new Image();
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Logo preload timed out')), 3000);
        image.onload = () => { clearTimeout(timeout); resolve(); };
        image.onerror = () => { clearTimeout(timeout); reject(new Error('Logo preload failed')); };
        image.src = logo.src;
      });
    }
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
    const restaurantSnap = order.restaurantId
      ? await getDoc(doc(db, 'restaurants', order.restaurantId))
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
      ...(restaurantSnap && restaurantSnap.exists() ? restaurantSnap.data() : {}),
      ...(scoped && scoped.exists() ? scoped.data() : {})
    };
    devLog('Restaurant settings logo fields', logoDebugFields(settings, order.restaurantId || ''));
    const totals = calculateOrderTotals(order.items || [], settings, order);
    const billOrder = { ...order, ...totals, taxPercentSnapshot: order.taxPercentSnapshot ?? totals.taxPercent };
    const logoDataUrl = await resolveBillLogo(settings, order.restaurantId || '');
    const gst = cleanSettingText(settings.gstNumber).toUpperCase();
    const signature = cleanSettingText(settings.restaurantSignatureMessage);
    const footer = cleanSettingText(settings.billFooterMessage);

    const upiLink = buildUpiLink(billOrder, settings);

    billRoot.innerHTML = `
      <div class="bill-header">
        <div class="bill-brand">
          ${
            logoDataUrl
              ? `<img class="restaurant-logo bill-logo logo" src="${escapeHtml(logoDataUrl)}" alt="Restaurant Logo" />`
              : ''
          }
          <div>
            <h1 style="margin:0">${escapeHtml(settings.restaurantName || 'Restaurant')}</h1>
            ${settings.address ? `<div class="muted">${escapeHtml(settings.address)}</div>` : ''}
            ${gst ? `<div class="muted"><strong>GSTIN:</strong> ${escapeHtml(gst)}</div>` : ''}
            ${settings.phone ? `<div class="muted">Phone: ${escapeHtml(settings.phone)}</div>` : ''}
            ${signature ? `<div class="muted"><strong>${escapeHtml(signature)}</strong></div>` : ''}
            <div class="muted"><strong>TAX INVOICE</strong></div>
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
      ${footer ? `<div class="notice" style="margin-top:16px;text-align:center">${escapeHtml(footer)}</div>` : ''}
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
