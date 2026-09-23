/* =========================================================
   POST A RESTAURANT BILL TO A ROOM  (section 17)

   The last thing section 17 asks for, and the one that could most
   easily have broken something:

     Guest in Room 204 orders food worth 850.
     The restaurant bill offers PAY NOW or POST TO ROOM 204.
     Posting puts 850 on that guest's folio.

   HOW THIS AVOIDS TOUCHING THE RESTAURANT POS.

   The spec's very first instruction is not to break, remove or
   negatively affect any existing business mode. admin.js is over
   seven thousand lines and every restaurant in production runs
   it, so the safe way to add a hotel feature to it is not to edit
   it much — it is to make the hotel feature a module that a
   restaurant never loads.

   admin.js imports this lazily, and only when the business type
   supports folios, which only a hotel does. For a restaurant,
   cafe, vendor or any other mode the file is never fetched, never
   parsed and never runs, so its correctness cannot affect them at
   all. That is a stronger guarantee than any amount of careful
   branching inside the POS itself.

   WHAT IT POSTS, AND WHAT IT DOES NOT RECOMPUTE.

   The order's agreed total goes across unchanged. Recomputing tax
   here could produce a folio line that disagrees with the printed
   bill in the guest's hand, and the guest is holding the printed
   one. The charge is keyed by the order's own id, so pressing the
   button twice — or a retry after a dropped connection — posts
   once.
========================================================= */
import { chargeFromPosOrder, roomsAcceptingCharges, FolioError } from "./hotel-folio.js?v=s2p-20260922d";

/**
 * Which rooms this bill may be charged to.
 *
 * Only a guest actually in house: an open folio, with a room. Offering a
 * checked-out or merely-booked room is how a bill lands on an account
 * nobody is going to settle.
 */
export function roomOptionsFor(folios = [], rooms = []) {
  const numberOf = roomId => rooms.find(room => String(room.id) === String(roomId))?.roomNumber || roomId;
  return roomsAcceptingCharges(folios)
    .map(entry => ({ ...entry, roomNumber: numberOf(entry.roomId) }))
    .sort((a, b) => String(a.roomNumber).localeCompare(String(b.roomNumber), undefined, { numeric: true }));
}

/** Can this particular bill be posted at all? */
export function canPostToRoom(order = {}, rooms = []) {
  if (!rooms.length) {
    return { ok: false, reason: "No guests are in house, so there is no room to charge this to." };
  }
  const charge = chargeFromPosOrder(order);
  if (!charge) return { ok: false, reason: "This bill has no amount to post." };
  if (String(order.paymentStatus || "").toLowerCase() === "paid") {
    return { ok: false, reason: "This bill is already paid." };
  }
  if (order.postedToFolioId) {
    return { ok: false, reason: `Already posted to room ${order.postedToRoomNumber || order.postedToRoomId}.` };
  }
  return { ok: true, reason: "", charge };
}

/**
 * Post the bill and mark the order as charged to the room.
 *
 * Two writes, in this order and not the other way round: the folio charge
 * first, then the order. If the second fails the guest has been charged once
 * and the POS shows the bill as unposted — which a receptionist notices and
 * can retry, and the retry is idempotent. The reverse order would mark a
 * bill posted that never reached a folio, which nobody notices until
 * checkout comes up short.
 */
export async function postBillToRoom({
  order, folioId, roomId, roomNumber, guestName, actor, businessDate,
  folioService, markOrderPosted
}) {
  const charge = chargeFromPosOrder(order);
  if (!charge) throw new FolioError("invalid", "This bill has no amount to post.");

  const result = await folioService.postCharge({
    folioId, actor, businessDate: businessDate || charge.businessDate, ...charge
  });

  await markOrderPosted({
    orderId: String(order.id || order.orderId),
    postedToFolioId: folioId,
    postedToRoomId: roomId,
    postedToRoomNumber: roomNumber || roomId,
    postedToGuestName: guestName || "",
    postedChargeId: charge.chargeId
  });

  return { ok: true, duplicate: result.duplicate === true, chargeId: charge.chargeId, amount: charge.rate };
}

/**
 * The line a POS shows once a bill has gone to a room.
 * A bill that vanishes from "unpaid" without being paid is alarming; saying
 * where it went is the whole point.
 */
export function postedLabel(order = {}) {
  if (!order.postedToFolioId) return "";
  const room = order.postedToRoomNumber || order.postedToRoomId;
  return order.postedToGuestName
    ? `Charged to room ${room} · ${order.postedToGuestName}`
    : `Charged to room ${room}`;
}

/**
 * Attach the button to a POS bill area.
 *
 * Returns a teardown function. The host element is given fresh markup on
 * every render, so this re-attaches rather than accumulating handlers — the
 * duplicate-listener fault section 47 names.
 */
export function mountPostToRoom({ host, order, rooms, onPost }) {
  if (!host) return () => {};
  const posted = postedLabel(order);
  if (posted) {
    host.innerHTML = `<div class="hotel-posted-note">${escapeText(posted)}</div>`;
    return () => { host.innerHTML = ""; };
  }

  const check = canPostToRoom(order, rooms);
  if (!check.ok) {
    host.innerHTML = rooms.length ? "" : `<div class="hotel-posted-note muted">${escapeText(check.reason)}</div>`;
    return () => { host.innerHTML = ""; };
  }

  host.innerHTML = `
    <div class="hotel-post-row">
      <select class="hotel-post-room" aria-label="Charge to room">
        ${rooms.map(room => `<option value="${escapeText(room.folioId)}"
          data-room-id="${escapeText(room.roomId)}"
          data-room-number="${escapeText(room.roomNumber)}"
          data-guest="${escapeText(room.guestName)}">Room ${escapeText(room.roomNumber)} · ${escapeText(room.guestName)}</option>`).join("")}
      </select>
      <button type="button" class="btn btn-sm btn-outline hotel-post-btn">Post to room</button>
    </div>`;

  const button = host.querySelector(".hotel-post-btn");
  const handler = () => {
    const select = host.querySelector(".hotel-post-room");
    const option = select?.selectedOptions?.[0];
    if (!option) return;
    onPost({
      folioId: option.value,
      roomId: option.dataset.roomId,
      roomNumber: option.dataset.roomNumber,
      guestName: option.dataset.guest
    });
  };
  button?.addEventListener("click", handler);
  return () => {
    button?.removeEventListener("click", handler);
    host.innerHTML = "";
  };
}

function escapeText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
