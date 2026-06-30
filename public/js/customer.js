import { db } from './firebase.js';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  updateDoc,
  serverTimestamp,
  query,
  where,
  orderBy,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  qs,
  fmtCurrency,
  getParam,
  saveLocal,
  readLocal,
  uid,
  toast,
  escapeHtml,
  notifyBackend,
  getRestaurantIdFromUrlOrStorage,
  normalizeCustomerPhone,
  isActiveUnpaidOrder
} from './common.js';

const landingHero = qs('#landingHero');
const customerApp = qs('#customerApp');
const menuGrid = qs('#menuGrid');
const categoryChips = qs('#categoryChips');
const cartList = qs('#cartList');
const searchBox = qs('#searchBox');
let foodTypeFilter = qs('#foodTypeFilter');
let priceFilter = qs('#priceFilter');
let minPriceFilter = qs('#minPriceFilter');
let maxPriceFilter = qs('#maxPriceFilter');
let menuSortFilter = qs('#menuSortFilter');
const customerName = qs('#customerName');
const customerPhone = qs('#customerPhone');
const customerNote = qs('#customerNote');
const itemsTotalEl = qs('#itemsTotal');
const taxTotalEl = qs('#taxTotal');
const grandTotalEl = qs('#grandTotal');
const placeOrderBtn = qs('#placeOrderBtn');
const clearCartBtn = qs('#clearCartBtn');
const orderSuccess = qs('#orderSuccess');
const restaurantNameEl = qs('#restaurantName');
const tableBadge = qs('#tableBadge');
const whatsappConsent = qs('#whatsappConsent');
const brandNameTop = qs('#brandNameTop');

const restaurantId = getRestaurantIdFromUrlOrStorage();
const tableParam = getParam('table');
const tableNo = tableParam || '01';
const addonOrderIdParam = getParam('addToOrder');

let settings = {
  restaurantName: 'Restaurant',
  taxPercent: 5,
  kitchenWhatsApp: '',
  phone: '',
  backendUrl: '',
  logoUrl: '',
  address: '',
  plan: 'advance',
  restaurantLat: null,
  restaurantLng: null,
  allowedOrderRadiusMeters: 150,
  locationProtectionEnabled: false,
  dailyOrderResetTime: '04:00'
};

// Missing businessMode intentionally remains Restaurant Mode for existing tenants.
const isVendorMode = () => settings.orderMode === 'token' || settings.businessMode === 'vendor' || (settings.orderMode === 'hybrid' && !tableParam);
const currentOrderMode = () => isVendorMode() ? 'token' : (settings.orderMode === 'hybrid' ? 'hybrid' : 'table');

let menu = [];
let activeCategory = 'All';
let cart = readLocal(`scan2plate_cart_${restaurantId}_${tableNo}`, []);
let customerLoadDone = false;
let customerLoadTimer = null;

function ensureMenuFilters() {
  if (!categoryChips || foodTypeFilter) return;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin:10px 0;';
  wrap.innerHTML = `<select id="foodTypeFilter" class="select"><option value="all">All</option><option value="veg">Veg</option><option value="nonveg">Non Veg</option><option value="egg">Egg</option></select><select id="priceFilter" class="select"><option value="all">All Prices</option><option value="under50">Under ₹50</option><option value="50-100">₹50 to ₹100</option><option value="100-200">₹100 to ₹200</option><option value="200-500">₹200 to ₹500</option><option value="above500">Above ₹500</option></select><input id="minPriceFilter" class="input" type="number" min="0" placeholder="Min Price" /><input id="maxPriceFilter" class="input" type="number" min="0" placeholder="Max Price" /><select id="menuSortFilter" class="select"><option value="default">Default</option><option value="price-asc">Price Low to High</option><option value="price-desc">Price High to Low</option><option value="name-asc">Name A to Z</option><option value="category">Category</option></select>`;
  categoryChips.insertAdjacentElement('afterend', wrap);
  foodTypeFilter = qs('#foodTypeFilter');
  priceFilter = qs('#priceFilter');
  minPriceFilter = qs('#minPriceFilter');
  maxPriceFilter = qs('#maxPriceFilter');
  menuSortFilter = qs('#menuSortFilter');
  [foodTypeFilter, priceFilter, menuSortFilter].forEach(el => el?.addEventListener('change', renderMenu));
  [minPriceFilter, maxPriceFilter].forEach(el => el?.addEventListener('input', renderMenu));
}

function showCustomerLoadNotice(message = 'Taking longer than expected. Please check internet and retry.', error = null) {
  const target = menuGrid || customerApp || document.body;
  const debug = error ? `<details style="margin-top:8px"><summary>Debug</summary><pre style="white-space:pre-wrap;font-size:11px">${escapeHtml(error?.message || error)}</pre></details>` : '';
  const html = `<div class="card" style="padding:18px;text-align:center"><h3 style="margin-top:0">${escapeHtml(message)}</h3><button class="btn btn-primary" type="button" onclick="location.reload()">Retry</button>${debug}</div>`;
  if (target === menuGrid) target.innerHTML = html;
  else target.insertAdjacentHTML('afterbegin', html);
}

function startCustomerLoadTimeout() {
  clearTimeout(customerLoadTimer);
  customerLoadTimer = setTimeout(() => {
    if (!customerLoadDone) showCustomerLoadNotice();
  }, 8000);
}

function finishCustomerLoad() {
  customerLoadDone = true;
  clearTimeout(customerLoadTimer);
}

if (brandNameTop) brandNameTop.textContent = 'Scan2Plate';

if (restaurantId) {
  localStorage.setItem('scan2plate_last_restaurant_id', restaurantId);
  landingHero?.classList.add('hidden');
  customerApp?.classList.remove('hidden');
} else {
  customerApp?.classList.add('hidden');
}

if (customerName) customerName.value = readLocal('scan2plate_customer_name', '');
if (customerPhone) customerPhone.value = readLocal('scan2plate_customer_phone', '');
if (customerNote) customerNote.value = readLocal('scan2plate_customer_note', '');
if (whatsappConsent) whatsappConsent.checked = readLocal('scan2plate_whatsapp_consent', true);
if (tableBadge) tableBadge.textContent = `Table: ${tableNo}`;
if (addonOrderIdParam && placeOrderBtn) placeOrderBtn.textContent = 'Add to Existing Bill';

customerName?.addEventListener('input', () => saveLocal('scan2plate_customer_name', customerName.value));
customerPhone?.addEventListener('input', () => {
  customerPhone.value = customerPhone.value.replace(/\D/g, '').slice(0, 10);
  saveLocal('scan2plate_customer_phone', customerPhone.value);
});
customerNote?.addEventListener('input', () => saveLocal('scan2plate_customer_note', customerNote.value));
whatsappConsent?.addEventListener('change', () => saveLocal('scan2plate_whatsapp_consent', whatsappConsent.checked));
searchBox?.addEventListener('input', renderMenu);
ensureMenuFilters();
clearCartBtn?.addEventListener('click', () => {
  cart = [];
  syncCart();
});
placeOrderBtn?.addEventListener('click', placeOrder);

if (restaurantId) {
  startCustomerLoadTimeout();
  try {
    await loadSettings();
    if (await validateTableAvailability()) {
      await loadMenu();
      renderCart();
    }
    finishCustomerLoad();
  } catch (error) {
    console.error('Customer page startup failed:', error);
    showCustomerLoadNotice('Unable to load data. Please retry.', error);
  }
} else {
  showCustomerLoadNotice('Restaurant ID missing. Please login again.');
}

async function validateTableAvailability() {
  if (isVendorMode()) return true;
  try {
    const tableSnap = await getDoc(doc(db, "restaurants", restaurantId, "tables", tableNo));
    if (tableSnap.exists() && (tableSnap.data().disabled === true || tableSnap.data().active === false)) {
      customerApp?.classList.add("hidden");
      landingHero?.classList.remove("hidden");
      if (landingHero) landingHero.innerHTML = `<div class="container"><div class="card" style="text-align:center;padding:32px"><h2>Table unavailable</h2><p class="muted">This table is currently disabled. Please contact restaurant staff.</p></div></div>`;
      return false;
    }
  } catch (error) {
    console.warn("Table availability check skipped:", error);
  }
  return true;
}

function activeTableOrdersSnapshot() {
  return getDocs(query(collection(db, 'orders'), where('restaurantId', '==', restaurantId)));
}

async function auditLog(action, details = {}) {
  try {
    await addDoc(collection(db, 'auditLogs'), {
      restaurantId,
      action,
      performedBy: normalizeCustomerPhone(customerPhone?.value || '') || 'customer',
      role: 'customer',
      details,
      createdAt: serverTimestamp()
    });
  } catch (error) {
    console.warn('audit log failed:', action, error);
  }
}

async function findActiveTableOrderForPhone(phone = '') {
  if (isVendorMode()) return { orderDoc: null, blocked: false };
  const submittedPhone = normalizeCustomerPhone(phone);
  const snap = await activeTableOrdersSnapshot();
  const tableOrders = snap.docs
    .filter(d => String(d.data().tableNo || d.data().tableNumber || '').padStart(2, '0') === String(tableNo).padStart(2, '0'))
    .filter(d => isActiveUnpaidOrder(d.data()))
    .sort((a, b) => (b.data().updatedAt?.seconds || b.data().createdAt?.seconds || 0) - (a.data().updatedAt?.seconds || a.data().createdAt?.seconds || 0));

  const active = tableOrders[0] || null;
  if (!active) return { orderDoc: null, blocked: false };

  const existingPhone = normalizeCustomerPhone(active.data().customerPhone || '');
  if (!existingPhone) {
    await auditLog('table_blocked_open_bill_no_phone', { tableNo });
    return { orderDoc: active, blocked: true, message: 'This table has an open bill. Please contact staff.' };
  }
  if (submittedPhone && existingPhone === submittedPhone) return { orderDoc: active, blocked: false };
  await auditLog('table_blocked_different_phone', { tableNo, existingPhoneMasked: existingPhone ? `******${existingPhone.slice(-4)}` : '', submittedPhoneMasked: submittedPhone ? `******${submittedPhone.slice(-4)}` : '' });
  return { orderDoc: active, blocked: true, message: 'This table is already booked by another customer. Please choose another table or ask staff to close the bill.' };
}

function getOrderSectionCard() {
  return placeOrderBtn?.closest('.card') || qs('#orderCard') || null;
}

function applyPlanMode() {
  const plan = String(settings.plan || 'advance').toLowerCase();
  const isBasic = plan === 'basic';
  const orderCard = getOrderSectionCard();

  if (!orderCard) return;

  if (isBasic) {
    orderCard.innerHTML = `
      <div style="text-align:center;padding:10px 4px">
        <div style="font-size:40px;margin-bottom:12px">📋</div>
        <h3 style="margin:0 0 10px">Digital Menu Only</h3>
        <p class="muted" style="margin:0;line-height:1.6">
          This restaurant is currently using the Basic plan.<br>
          Please call waiter to place your order.
        </p>
      </div>
    `;
  }
}

async function loadSettings() {
  try {
    const restaurantSnap = await getDoc(doc(db, 'restaurants', restaurantId));
    const scoped = await getDoc(doc(db, 'restaurants', restaurantId, 'settings', 'general'));
    const root = await getDoc(doc(db, 'settings', 'general'));

    const restaurantData = restaurantSnap.exists() ? restaurantSnap.data() : {};
    const rootData = root.exists() ? root.data() : {};
    const scopedData = scoped.exists() ? scoped.data() : {};

    settings = {
      ...settings,
      ...rootData,
      ...restaurantData,
      ...scopedData,
      // The main restaurant record is the source of truth for panel/order
      // identity. A stale settings/general value must not turn an old table
      // restaurant into a token vendor.
      businessType: restaurantData.businessType || scopedData.businessType || 'Restaurant',
      orderMode: restaurantData.orderMode || scopedData.orderMode || 'Table',
      panelType: restaurantData.panelType || scopedData.panelType || 'RestaurantAdmin',
      businessMode: restaurantData.businessType === 'Restaurant' || restaurantData.orderMode === 'Table' ? 'restaurant' : (restaurantData.businessMode || scopedData.businessMode || 'restaurant'),
      plan: String(restaurantData.plan || scopedData.plan || settings.plan || 'advance').toLowerCase()
    };
  } catch (e) {
    console.error('Settings load error:', e);
  }

  localStorage.setItem('scan2plate_settings', JSON.stringify(settings));
  localStorage.setItem('scan2plate_backend_url', settings.backendUrl || '');

  if (restaurantNameEl) {
    restaurantNameEl.textContent = settings.restaurantName || settings.name || 'Order from your table in seconds';
  }

  if (tableBadge) {
    tableBadge.textContent = isVendorMode() ? 'Pickup Token Order' : `Table: ${tableNo}`;
    tableBadge.classList.toggle('hidden', isVendorMode());
  }

  applyPlanMode();
}

async function loadMenu() {
  try {
    let snap = await getDocs(
      query(collection(db, 'restaurants', restaurantId, 'menu'), orderBy('sortOrder'))
    ).catch(() => null);

    if (!snap || snap.empty) {
      snap = await getDocs(collection(db, 'restaurants', restaurantId, 'menu'));
    }

    if (snap.empty) {
      snap = await getDocs(collection(db, 'menu'));
    }

    menu = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(item => item.available !== false)
      .sort(
        (a, b) =>
          Number(a.sortOrder || 9999) - Number(b.sortOrder || 9999) ||
          String(a.name || '').localeCompare(String(b.name || ''))
      );

    renderCategories();
    renderMenu();
  } catch (e) {
    console.error('Menu load error:', e);
    if (menuGrid) {
      menuGrid.innerHTML = `<div class="card"><p class="muted">Failed to load menu.</p></div>`;
    }
  }
}

function renderCategories() {
  if (!categoryChips) return;

  const cats = ['All', ...new Set(menu.map(item => item.category || 'Other'))];

  categoryChips.innerHTML = cats
    .map(
      cat => `<button class="chip ${cat === activeCategory ? 'active' : ''}" data-cat="${escapeHtml(cat)}">${escapeHtml(cat)}</button>`
    )
    .join('');

  categoryChips.querySelectorAll('.chip').forEach(btn => {
    btn.onclick = () => {
      activeCategory = btn.dataset.cat;
      renderCategories();
      renderMenu();
    };
  });
}

function filteredMenu() {
  const q = searchBox ? searchBox.value.trim().toLowerCase() : '';
  const foodFilter = foodTypeFilter?.value || 'all';
  const priceValue = priceFilter?.value || 'all';
  const minRaw = String(minPriceFilter?.value || '').trim();
  const maxRaw = String(maxPriceFilter?.value || '').trim();
  const min = minRaw === '' ? null : Number(minRaw);
  const max = maxRaw === '' ? null : Number(maxRaw);
  const sort = menuSortFilter?.value || 'default';

  return menu.filter(item => {
    const catOk = activeCategory === 'All' || (item.category || 'Other') === activeCategory;
    const foodOk = foodFilter === 'all' || normalizedFoodType(item) === foodFilter;
    const displayPrice = menuDisplayPrice(item);
    const priceOk = priceFilterMatches(displayPrice, priceValue) && (min === null || displayPrice >= min) && (max === null || displayPrice <= max);
    const qOk =
      !q ||
      String(item.name || '').toLowerCase().includes(q) ||
      String(item.category || '').toLowerCase().includes(q) ||
      String(item.description || '').toLowerCase().includes(q) ||
      (item.tags || []).join(' ').toLowerCase().includes(q);

    return catOk && foodOk && priceOk && qOk;
  }).sort((a, b) => {
    if (sort === 'price-asc') return menuDisplayPrice(a) - menuDisplayPrice(b);
    if (sort === 'price-desc') return menuDisplayPrice(b) - menuDisplayPrice(a);
    if (sort === 'name-asc') return String(a.name || '').localeCompare(String(b.name || ''));
    if (sort === 'category') return String(a.category || 'Other').localeCompare(String(b.category || 'Other')) || String(a.name || '').localeCompare(String(b.name || ''));
    return 0;
  });
}

function itemMedia(item) {
  const src = item.imageUrl || item.image || '';
  return src
    ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(item.name || 'Food')}" class="food-img" loading="lazy" />`
    : `<div class="menu-img">${escapeHtml((item.name || 'F').charAt(0))}</div>`;
}

function validMenuVariants(item = {}) {
  return item.hasVariants === true && Array.isArray(item.variants)
    ? item.variants
        .map(variant => ({ name: String(variant.name || '').trim(), price: Number(variant.price || 0) }))
        .filter(variant => variant.name && variant.price > 0)
    : [];
}

function hasMenuVariants(item = {}) {
  return validMenuVariants(item).length > 0;
}

function normalizedFoodType(item = {}) {
  const raw = String(item.foodType || (item.isNonVeg ? 'nonveg' : item.isEgg ? 'egg' : item.isVeg === false ? 'other' : 'veg')).toLowerCase().replace(/[\s_-]+/g, '');
  if (raw === 'nonveg' || raw === 'nonvegetarian') return 'nonveg';
  if (raw === 'egg') return 'egg';
  if (raw === 'other') return 'other';
  return 'veg';
}

function foodTypeBadge(item = {}) {
  const type = normalizedFoodType(item);
  const label = ({ veg: 'VEG', nonveg: 'NON VEG', egg: 'EGG', other: 'OTHER' })[type] || 'VEG';
  const color = type === 'nonveg' ? '#dc2626' : type === 'egg' ? '#d97706' : type === 'veg' ? '#16a34a' : '#64748b';
  return `<span class="food-type-badge ${type}" style="display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:800;color:${color};"><span class="food-type-icon ${type}" style="display:inline-grid;place-items:center;width:13px;height:13px;border:1.5px solid currentColor;border-radius:2px;"><span style="display:block;width:6px;height:6px;border-radius:50%;background:currentColor;"></span></span>${label}</span>`;
}

function menuDisplayPrice(item = {}) {
  const variants = validMenuVariants(item);
  return variants.length ? Math.min(...variants.map(variant => variant.price)) : Number(item.basePrice || item.price || 0);
}

function priceFilterMatches(price, filter) {
  if (filter === 'under50') return price < 50;
  if (filter === '50-100') return price >= 50 && price <= 100;
  if (filter === '100-200') return price >= 100 && price <= 200;
  if (filter === '200-500') return price >= 200 && price <= 500;
  if (filter === 'above500') return price > 500;
  return true;
}

function itemDisplayName(item = {}) {
  const baseName = String(item.name || 'Item').trim() || 'Item';
  const variantName = String(item.variantName || '').trim();
  return variantName && !baseName.toLowerCase().endsWith(` ${variantName.toLowerCase()}`)
    ? `${baseName} ${variantName}`
    : baseName;
}

function cartKeyForItem(item = {}) {
  return `${item.id || item.menuItemId || ''}::${String(item.variantName || '')}`;
}

function menuPriceLabel(item = {}) {
  const variants = validMenuVariants(item);
  return variants.length
    ? `Starting ${fmtCurrency(menuDisplayPrice(item))}<br><small>${variants.map(variant => `${escapeHtml(variant.name)} ${fmtCurrency(variant.price)}`).join(' · ')}</small>`
    : fmtCurrency(Number(item.price || 0));
}

function makeCartItem(item = {}, variant = null) {
  const variantName = variant?.name || '';
  const price = Number(variant ? variant.price : item.price || 0);
  return {
    id: item.id,
    menuItemId: item.id,
    itemId: item.id,
    name: item.name || '',
    itemName: item.itemName || item.name || '',
    price,
    unitPrice: price,
    qty: 1,
    variantName,
    variantPrice: variantName ? price : null,
    hasVariants: Boolean(variantName),
    category: item.category || '',
    imageUrl: item.imageUrl || item.image || ''
  };
}

function renderMenu() {
  if (!menuGrid) return;

  const items = filteredMenu();

  menuGrid.innerHTML = items.length
    ? items
        .map(
          item => `
      <div class="card menu-item">
        ${itemMedia(item)}
        <div>
          <h3>${escapeHtml(item.name || '')}</h3>
          <div style="margin-bottom:5px;">${foodTypeBadge(item)}</div>
          <div class="muted small">${escapeHtml(item.category || 'Other')}</div>
          <p class="muted small">${escapeHtml(item.description || 'Freshly prepared item')}</p>
        </div>
        <div class="price-row">
          <strong>${menuPriceLabel(item)}</strong>
          ${hasMenuVariants(item)
            ? `<div class="row" style="gap:8px;justify-content:flex-end"><span class="muted small">Choose portion</span>${validMenuVariants(item).map(variant => `<button class="btn btn-primary" data-id="${escapeHtml(item.id)}" data-variant="${escapeHtml(variant.name)}">${escapeHtml(variant.name)}</button>`).join('')}</div>`
            : `<button class="btn btn-primary" data-id="${escapeHtml(item.id)}">Add</button>`}
        </div>
      </div>
    `
        )
        .join('')
    : `<div class="card"><p class="muted">No menu items found.</p></div>`;

  menuGrid.querySelectorAll('button[data-id]').forEach(btn => {
    btn.onclick = () => addToCart(btn.dataset.id, btn.dataset.variant || '');
  });
}

function addToCart(id, variantName = '') {
  if (String(settings.plan || '').toLowerCase() === 'basic') return;

  const item = menu.find(x => x.id === id);
  if (!item) return;
  const variant = validMenuVariants(item).find(v => v.name === variantName) || null;
  if (hasMenuVariants(item) && !variant) return toast('Choose portion.');

  const nextItem = makeCartItem(item, variant);
  const key = cartKeyForItem(nextItem);
  const found = cart.find(x => cartKeyForItem(x) === key);

  if (found) {
    found.qty += 1;
  } else {
    cart.push(nextItem);
  }

  syncCart();
}

function updateQty(key, delta) {
  const item = cart.find(x => cartKeyForItem(x) === key);
  if (!item) return;

  item.qty += delta;

  if (item.qty <= 0) {
    cart = cart.filter(x => cartKeyForItem(x) !== key);
  }

  syncCart();
}

function syncCart() {
  saveLocal(`scan2plate_cart_${restaurantId}_${tableNo}`, cart);
  renderCart();
}

function renderCart() {
  if (!cartList) return;

  cartList.innerHTML = cart.length
    ? cart
        .map(
          item => `
      <div class="cart-item">
        <div class="cart-row">
          <div>
            <strong>${escapeHtml(itemDisplayName(item))}</strong>
            <div class="muted small">${fmtCurrency(item.price)} each</div>
          </div>
          <div class="qty-box">
            <button class="qty-btn" data-act="minus" data-key="${escapeHtml(cartKeyForItem(item))}">-</button>
            <strong>${item.qty}</strong>
            <button class="qty-btn" data-act="plus" data-key="${escapeHtml(cartKeyForItem(item))}">+</button>
          </div>
        </div>
        <div class="row" style="margin-top:8px">
          <span class="muted small">Subtotal</span>
          <strong>${fmtCurrency(item.price * item.qty)}</strong>
        </div>
      </div>
    `
        )
        .join('')
    : `<p class="muted">Your cart is empty.</p>`;

  cartList.querySelectorAll('.qty-btn').forEach(btn => {
    btn.onclick = () => updateQty(btn.dataset.key, btn.dataset.act === 'plus' ? 1 : -1);
  });

  const itemsTotal = cart.reduce((s, x) => s + x.price * x.qty, 0);
  const tax = itemsTotal * (Number(settings.taxPercent || 0) / 100);
  const grand = itemsTotal + tax;

  if (itemsTotalEl) itemsTotalEl.textContent = fmtCurrency(itemsTotal);
  if (taxTotalEl) taxTotalEl.textContent = fmtCurrency(tax);
  if (grandTotalEl) grandTotalEl.textContent = fmtCurrency(grand);
}

async function findOpenOrder() {
  // Each vendor checkout is a new counter token, never an update to a prior order.
  if (isVendorMode()) return null;
  if (!customerPhone?.value.trim()) return null;

  const { orderDoc, blocked, message } = await findActiveTableOrderForPhone(customerPhone.value);
  if (blocked) throw new Error(message || 'This table is already booked. Please change the table or contact staff.');
  return orderDoc || null;
}

function localTokenDate() {
  const now = new Date();
  const tzOffset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - tzOffset).toISOString().slice(0, 10);
}

function normalizedResetTime(value = '04:00') {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || '')) ? String(value) : '04:00';
}

function businessDateFor(date = new Date(), resetTime = '04:00') {
  const [hours, minutes] = normalizedResetTime(resetTime).split(':').map(Number);
  const businessDate = new Date(date);
  const resetToday = new Date(date);
  resetToday.setHours(hours, minutes, 0, 0);
  if (date < resetToday) businessDate.setDate(businessDate.getDate() - 1);
  const tzOffset = businessDate.getTimezoneOffset() * 60000;
  return new Date(businessDate.getTime() - tzOffset).toISOString().slice(0, 10);
}

async function nextVendorToken() {
  const tokenDate = localTokenDate();
  const counterRef = doc(db, 'restaurants', restaurantId, 'counters', `vendor-token-${tokenDate}`);
  const tokenNumber = await runTransaction(db, async transaction => {
    const counter = await transaction.get(counterRef);
    const next = Number(counter.exists() ? counter.data().lastTokenNumber : 100) + 1;
    transaction.set(counterRef, { tokenDate, lastTokenNumber: next, updatedAt: serverTimestamp() }, { merge: true });
    return next;
  });
  return { tokenDate, tokenNumber };
}

async function nextDailyOrderMeta() {
  const dailyResetTime = normalizedResetTime(settings.dailyOrderResetTime || '04:00');
  const businessDate = businessDateFor(new Date(), dailyResetTime);
  const counterRef = doc(db, 'restaurants', restaurantId, 'counters', businessDate);
  const dailyOrderNo = await runTransaction(db, async transaction => {
    const counter = await transaction.get(counterRef);
    const next = Number(counter.exists() ? counter.data().lastDailyOrderNo || 0 : 0) + 1;
    transaction.set(counterRef, { businessDate, dailyOrderDate: businessDate, dailyResetTime, lastDailyOrderNo: next, updatedAt: serverTimestamp() }, { merge: true });
    return next;
  });
  return { dailyOrderNo, businessDate, orderNumberLabel: `Order No ${dailyOrderNo}`, dailyResetTime, dailyOrderDate: businessDate, displayOrderNo: String(dailyOrderNo) };
}

function mergeItems(existing = [], incoming = []) {
  const map = new Map();

  [...existing, ...incoming].forEach(i => {
    const key = cartKeyForItem(i) || i.name;
    if (!map.has(key)) {
      map.set(key, { ...i, qty: Number(i.qty || 0) });
    } else {
      map.get(key).qty += Number(i.qty || 0);
    }
  });

  return [...map.values()];
}

function addonBatchId() {
  return `ADDON${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
}

function orderItemTotal(item = {}) {
  return Number(item.total ?? (Number(item.price || 0) * Number(item.qty || item.quantity || 0)));
}

function toAddonItems(items = [], addedFrom = 'customer_track_panel') {
  const batchId = addonBatchId();
  const addedAt = new Date().toISOString();
  return items.map(item => ({
    ...item,
    itemId: item.itemId || item.menuItemId || item.id || '',
    quantity: Number(item.quantity || item.qty || 0),
    qty: Number(item.qty || item.quantity || 0),
    total: orderItemTotal(item),
    isNewAddon: true,
    seenByKitchen: false,
    addonBatchId: batchId,
    addedAt,
    addedFrom,
    kotPrinted: false,
    kotPrintedAt: null
  }));
}

function recalculateTotals(items = [], discount = {}) {
  const itemsTotal = items.reduce((s, x) => s + Number(x.price || 0) * Number(x.qty || x.quantity || 0), 0);
  const rawType = String(discount.discountType || '').toLowerCase();
  const rawValue = Number(discount.discountValue || 0);
  let discountAmount = Number(discount.discountAmount || 0);
  if (rawType === 'flat') discountAmount = Math.min(itemsTotal, Math.max(0, rawValue));
  if (rawType === 'percent') discountAmount = itemsTotal * Math.min(100, Math.max(0, rawValue)) / 100;
  discountAmount = Math.min(itemsTotal, Math.max(0, discountAmount));
  const taxableAmount = Math.max(0, itemsTotal - discountAmount);
  const tax = taxableAmount * (Number(settings.taxPercent || 0) / 100);
  return { itemsTotal, subtotal: itemsTotal, discountAmount, taxableAmount, tax, grandTotal: taxableAmount + tax };
}

function toRadians(value) {
  return (Number(value) * Math.PI) / 180;
}

function getDistanceMeters(lat1, lng1, lat2, lng2) {
  const earthRadiusMeters = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMeters * c;
}

function getCustomerPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('unsupported'));
      return;
    }

    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 0
    });
  });
}

async function verifyCustomerLocation() {
  const locationProtectionEnabled = settings.locationProtectionEnabled === true || settings.enableLocationProtection === true;
  const locationDebug = (...args) => {
    if (['localhost', '127.0.0.1'].includes(location.hostname)) console.debug('[Scan2Plate location]', ...args);
  };
  locationDebug({ restaurantId, locationProtectionEnabled, locationCheckSkipped: !locationProtectionEnabled });
  if (!locationProtectionEnabled) {
    return { locationVerified: false, locationProtectionSkipped: true };
  }
  const restaurantLat = Number(settings.restaurantLat);
  const restaurantLng = Number(settings.restaurantLng);
  const allowedOrderRadiusMeters = Number(settings.allowedOrderRadiusMeters || 150);

  if (!Number.isFinite(restaurantLat) || !Number.isFinite(restaurantLng) || !Number.isFinite(allowedOrderRadiusMeters) || allowedOrderRadiusMeters <= 0) {
    console.warn('[Scan2Plate location] protection enabled but location data is incomplete', { restaurantId });
    return { locationVerified: false, locationProtectionSkipped: true, locationProtectionWarning: 'incomplete-location-settings' };
  }

  let position;
  try {
    position = await getCustomerPosition();
  } catch (error) {
    throw new Error('Location permission is required to place order and prevent fake orders.');
  }

  const customerLat = Number(position.coords.latitude);
  const customerLng = Number(position.coords.longitude);
  const customerDistanceMeters = Math.round(
    getDistanceMeters(customerLat, customerLng, restaurantLat, restaurantLng)
  );

  if (customerDistanceMeters > allowedOrderRadiusMeters) {
    locationDebug({ restaurantId, radiusCheckResult: 'outside', customerDistanceMeters, allowedOrderRadiusMeters });
    throw new Error('You are outside restaurant ordering range. Please place order only from inside the restaurant.');
  }

  locationDebug({ restaurantId, radiusCheckResult: 'inside', customerDistanceMeters, allowedOrderRadiusMeters });

  return {
    customerLat,
    customerLng,
    customerDistanceMeters,
    locationVerified: true
  };
}

async function placeOrder() {
  if (String(settings.plan || '').toLowerCase() === 'basic') {
    return toast('This restaurant is using digital menu only.');
  }

  if (!customerName?.value.trim() || !customerPhone?.value.trim()) {
    return toast('Please enter customer name and phone number.');
  }

  customerPhone.value = customerPhone.value.replace(/\D/g, '').slice(0, 10);

  if (customerPhone.value.length !== 10) {
    return toast('Please enter a valid 10 digit phone number.');
  }

  if (!cart.length) {
    return toast('Cart is empty. Please add items first.');
  }

  if (placeOrderBtn) placeOrderBtn.disabled = true;

  try {
    const locationProof = await verifyCustomerLocation();
    const openOrder = await findOpenOrder();
    let orderId;
    let createdTokenNumber = null;
    let createdDailyOrder = null;
    const noteVal = customerNote?.value.trim() || '';
    const etaMinutes = 10;
    const fullPhone = `+91${customerPhone.value.trim()}`;

    if (openOrder) {
      const current = openOrder.data();
      const addonItems = toAddonItems(cart, 'customer_track_panel');
      const items = [...(current.items || []), ...addonItems];
      const totals = recalculateTotals(items, current);
      const newlyAddedItemsText = addonItems.map(i => `${itemDisplayName(i)} x${Number(i.qty || i.quantity || 0)}`).join(', ');

      orderId = current.orderId;
      createdDailyOrder = { displayOrderNo: current.displayOrderNo || current.dailyOrderNo || '-' };

      await updateDoc(doc(db, 'orders', openOrder.id), {
        customerName: customerName.value.trim(),
        customerPhone: fullPhone,
        note: noteVal,
        whatsappConsent: whatsappConsent ? whatsappConsent.checked : true,
        items,
        itemsTotal: totals.itemsTotal,
        subtotal: totals.subtotal,
        discountAmount: totals.discountAmount,
        taxableAmount: totals.taxableAmount,
        tax: totals.tax,
        grandTotal: totals.grandTotal,
        status: current.status || 'pending',
        etaMinutes,
        hasNewItems: true,
        newlyAddedItems: addonItems,
        newlyAddedItemsText,
        newlyAddedNote: 'Add on order received',
        kitchenAlertAt: serverTimestamp(),
        ...locationProof,
        updatedAt: serverTimestamp(),
        lastAddedAt: serverTimestamp()
      });
      await auditLog('add_more_items', { orderId, tableNo, addonCount: addonItems.length, addedFrom: 'customer_track_panel' });

      await notifyBackend({
        restaurantId,
        restaurantName: settings.restaurantName || 'Restaurant',
        orderId,
        tableNo,
        customerName: customerName.value.trim(),
        customerPhone: whatsappConsent?.checked ? fullPhone : '',
        kitchenPhone: settings.kitchenWhatsApp || '',
        items: addonItems,
        grandTotal: totals.grandTotal,
        status: 'updated',
        etaMinutes,
        billUrl: `${location.origin}/bill.html?orderId=${encodeURIComponent(orderId)}`
      });
    } else {
      orderId = uid('ORD');

      const itemsTotal = cart.reduce((s, x) => s + x.price * x.qty, 0);
      const tax = itemsTotal * (Number(settings.taxPercent || 0) / 100);
      const grandTotal = itemsTotal + tax;

      const vendorToken = isVendorMode() ? await nextVendorToken() : { tokenDate: null, tokenNumber: null };
      createdTokenNumber = vendorToken.tokenNumber;
      const dailyOrder = await nextDailyOrderMeta();
      createdDailyOrder = dailyOrder;
      const payload = {
        orderId,
        ...dailyOrder,
        restaurantId,
        restaurantName: settings.restaurantName || 'Restaurant',
        businessMode: isVendorMode() ? 'vendor' : 'restaurant',
        orderMode: currentOrderMode(),
        tableNo: isVendorMode() ? null : tableNo,
        tableNumber: isVendorMode() ? null : tableNo,
        tokenNumber: vendorToken.tokenNumber,
        tokenNo: vendorToken.tokenNumber ? `T-${vendorToken.tokenNumber}` : null,
        tokenDate: vendorToken.tokenDate,
        customerName: customerName.value.trim(),
        customerPhone: fullPhone,
        note: noteVal,
        whatsappConsent: whatsappConsent ? whatsappConsent.checked : true,
        items: cart.map(item => ({ ...item, quantity: Number(item.quantity || item.qty || 0), total: orderItemTotal(item), isNewAddon: false, seenByKitchen: true })),
        itemsTotal,
        subtotal: itemsTotal,
        discountAmount: 0,
        taxableAmount: itemsTotal,
        tax,
        grandTotal,
        status: 'pending',
        paymentStatus: 'unpaid',
        source: 'qr-order',
        etaMinutes,
        etaStartedAt: null,
        ...locationProof,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };

      await addDoc(collection(db, 'orders'), payload);

      await notifyBackend({
        restaurantId,
        restaurantName: settings.restaurantName || 'Restaurant',
        orderId,
        tableNo: isVendorMode() ? null : tableNo,
        tokenNumber: vendorToken.tokenNumber,
        customerName: customerName.value.trim(),
        customerPhone: whatsappConsent?.checked ? fullPhone : '',
        kitchenPhone: settings.kitchenWhatsApp || '',
        items: cart,
        grandTotal,
        status: 'pending',
        etaMinutes,
        billUrl: `${location.origin}/bill.html?orderId=${encodeURIComponent(orderId)}`
      });
    }

    if (orderSuccess) {
      orderSuccess.classList.remove('hidden');
      orderSuccess.innerHTML = `
        Order saved successfully.<br>
        <b>Order No:</b> ${escapeHtml(createdDailyOrder?.displayOrderNo || '-')}<br>
        <b>${isVendorMode() ? 'Token' : 'Order ID'}:</b> ${escapeHtml(isVendorMode() ? `T-${createdTokenNumber}` : orderId)}<br>
        <a href="./track.html?orderId=${encodeURIComponent(orderId)}" style="color:#8f5500;text-decoration:underline">Track this order</a>
        |
        <a href="./bill.html?orderId=${encodeURIComponent(orderId)}" style="color:#8f5500;text-decoration:underline">Open bill</a>
      `;
    }

    cart = [];
    syncCart();

    setTimeout(() => {
      window.location.href = `./track.html?orderId=${encodeURIComponent(orderId)}`;
    }, 800);
  } catch (e) {
    console.error('Place order error:', e);
    toast(e?.message || 'Failed to place order. Check Firestore rules, restaurant ID, and backend URL.');
  }

  if (placeOrderBtn) placeOrderBtn.disabled = false;
}
