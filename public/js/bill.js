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
  escapeHtml
} from './common.js';

const billRoot = qs('#billRoot');
const orderId = getParam('orderId');
const docId = getParam('docId');

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
      upiId: '',
      phone: '',
      address: '',
      logoUrl: '',
      ...(root.exists() ? root.data() : {}),
      ...(scoped && scoped.exists() ? scoped.data() : {})
    };

    const upiLink = buildUpiLink(order, settings);

    billRoot.innerHTML = `
      <div class="bill-header">
        <div class="bill-brand">
          ${
            settings.logoUrl
              ? `<img src="${escapeHtml(settings.logoUrl)}" alt="logo" class="bill-logo" />`
              : ''
          }
          <div>
            <h1 style="margin:0">${escapeHtml(settings.restaurantName || 'Restaurant')}</h1>
            <div class="muted">${escapeHtml(settings.address || 'Add address in settings')}</div>
            <div class="muted">Phone: ${escapeHtml(settings.phone || '-')}</div>
            <div class="muted">Order No: ${escapeHtml(order.displayOrderNo || order.dailyOrderNo || '-')}</div>
            <div class="muted">Order ID: ${escapeHtml(order.orderId || '-')}</div>
            <div class="muted">Date: ${nowStr(order.createdAt)}</div>
          </div>
        </div>

        <div class="center">
          <div class="status status-${order.paymentStatus === 'paid' ? 'served' : 'pending'}">
            ${escapeHtml(order.paymentStatus || 'unpaid')}
          </div>
          <div style="margin-top:10px">
            <button class="btn btn-dark" onclick="window.print()">Print Bill</button>
          </div>
        </div>
      </div>

      <div class="grid-2" style="margin-top:16px">
        <div>
          <strong>Customer</strong>
          <div class="muted">${escapeHtml(order.customerName || '-')}</div>
          <div class="muted">${escapeHtml(order.customerPhone || '-')}</div>
          <div class="muted">Table ${escapeHtml(order.tableNo || '-')}</div>
        </div>

        <div>
          <strong>Status</strong>
          <div class="muted">Order: ${escapeHtml(order.status || 'pending')}</div>
          <div class="muted">Payment: ${escapeHtml(order.paymentStatus || 'unpaid')}</div>
          <div class="muted">Source: ${escapeHtml(order.source || (order.isManualBill ? 'manual' : 'direct'))}</div>
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
          ${(order.items || []).map(i => `
            <tr>
              <td>${escapeHtml(i.name || '')}</td>
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
          <div class="row"><span>Items Total</span><strong>${fmtCurrency(order.itemsTotal || 0)}</strong></div>
          <div class="row"><span>Tax</span><strong>${fmtCurrency(order.tax || 0)}</strong></div>
          <div class="row"><span>Grand Total</span><strong>${fmtCurrency(order.grandTotal || 0)}</strong></div>
        </div>
      </div>
    `;

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
