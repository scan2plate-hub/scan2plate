/* =========================================================
   OFFLINE POS — dashboard view mapping
   ---------------------------------------------------------
   The browser cannot import from backend/, so this mapping
   lives here and the backend imports THIS file. One
   implementation, used by both, so what the API stores and
   what the dashboard renders can never drift apart.
========================================================= */

function money(value){const n=Number(value);return Number.isFinite(n)?Math.round(n*100)/100:0;}
function integer(value,fallback=0){const n=Number(value);return Number.isFinite(n)?Math.trunc(n):fallback;}

/* ---------------- dashboard view ---------------- */

/**
 * Maps an offline-POS order into the shape the Scan2Plate dashboard's order
 * list and sales reports already read, so synced orders appear alongside
 * online ones without every report learning a second schema.
 *
 * The status mapping is what keeps the money right. The dashboard counts an
 * order as revenue when paymentStatus is "paid", so only a `billed` order
 * gets that. An `open` order is still running and a `cancelled` one was
 * voided: neither is revenue, and neither may be given a paid marker.
 */
export function toDashboardOrder(order = {}, { deviceName = "" } = {}) {
  const status = String(order.status || "").toLowerCase();
  const billed = status === "billed";
  const cancelled = status === "cancelled";

  return {
    id: order.uuid,
    orderId: order.uuid,
    restaurantId: order.restaurant_code || "",
    source: "offline_pos",
    sourceLabel: "Offline POS",
    deviceId: order.device_id || "",
    deviceName: deviceName || order.device_id || "",
    isOfflinePosOrder: true,

    status: billed ? "completed" : cancelled ? "cancelled" : "pending",
    paymentStatus: billed ? "paid" : "unpaid",
    billClosed: billed,

    tableNo: order.table_name || "",
    tableNumber: order.table_name || "",
    orderType: order.table_type === "takeaway" ? "takeaway" : order.table_type === "delivery" ? "delivery" : "dine_in",
    orderMode: order.table_type === "delivery" ? "delivery" : order.table_type === "takeaway" ? "takeaway" : "table",

    customerName: order.customer_name || "",
    customerPhone: order.customer_phone || "",

    items: (order.items || []).map(item => ({
      name: item.name,
      itemName: item.name,
      price: money(item.price),
      qty: integer(item.qty, 0),
      quantity: integer(item.qty, 0),
      total: money(money(item.price) * integer(item.qty, 0))
    })),

    itemsTotal: money(order.subtotal),
    subtotal: money(order.subtotal),
    discountAmount: money(order.discount),
    taxableAmount: money(order.subtotal),
    tax: money(money(order.cgst) + money(order.sgst)),
    grandTotal: money(order.total),
    total: money(order.total),
    paidAmount: billed ? money(order.total) : 0,
    remainingAmount: billed ? 0 : money(order.total),
    paymentMethod: (order.payment_mode || "").toLowerCase() || "cash",

    businessDate: order.business_date || "",
    dailyOrderNo: integer(order.order_number, 0),
    displayOrderNo: integer(order.order_number, 0),
    createdAt: order.created_at || null,
    updatedAt: order.updated_at || null
  };
}
