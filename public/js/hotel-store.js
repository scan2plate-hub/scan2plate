/* =========================================================
   SHARED HOTEL STORE

   Section 47 is explicit about the failures not to repeat:
   duplicate Firestore listeners, repeated getDocs, rebuilding
   the DOM for nothing, and navigation that feels slow. A front
   desk has five screens all showing the same rooms and the same
   bookings — a dashboard, a room grid, an arrivals list, a
   departures list and a calendar. Opened naively that is five
   live copies of the same two collections.

   This module owns ONE listener per collection and fans the
   result out. It follows the same shape as orders-store.js,
   which already solved this for the restaurant dashboard, so
   there is one pattern in the codebase rather than two.

   Three properties do the work:

     * One listener regardless of how many screens are open, and
       the listener is closed when the last screen lets go.
     * The latest snapshot is kept, so a screen opened later
       renders immediately from memory — no second read, and no
       spinner on a tab the user has already visited. That is
       what makes navigation feel instant without a reload.
     * Bursts are coalesced into one render pass, because a
       check-in writes a reservation and a room in the same
       breath and the grid should repaint once, not twice.

   Firestore is injected rather than imported, so the fan-out can
   be tested against a stub. The listener count is the thing worth
   asserting, and it cannot be asserted against a live database.
========================================================= */

const COALESCE_MS = 120;

/**
 * @param firestore {{ collection, onSnapshot, query?, where? }}
 */
export function createHotelStore({ db, restaurantId, firestore, onError = () => {} }) {
  const { collection, onSnapshot } = firestore;

  // One record per collection: its listener, its subscribers, its last data.
  const streams = new Map();

  function streamFor(name) {
    if (!streams.has(name)) {
      streams.set(name, { subscribers: new Set(), unsubscribe: null, latest: null, timer: null });
    }
    return streams.get(name);
  }

  function emit(name) {
    const stream = streamFor(name);
    stream.timer = null;
    stream.subscribers.forEach(handler => {
      // One screen throwing must never stop the others from updating. A
      // render bug in the calendar cannot be allowed to freeze the grid the
      // receptionist is checking someone in from.
      try { handler(stream.latest); } catch (error) { onError(error, { stream: name, phase: "subscriber" }); }
    });
  }

  function schedule(name, { immediate = false } = {}) {
    const stream = streamFor(name);
    if (immediate) {
      if (stream.timer) { clearTimeout(stream.timer); stream.timer = null; }
      emit(name);
      return;
    }
    if (stream.timer) return;
    stream.timer = setTimeout(() => emit(name), COALESCE_MS);
  }

  function start(name) {
    const stream = streamFor(name);
    if (stream.unsubscribe) return;
    stream.unsubscribe = onSnapshot(
      collection(db, "restaurants", restaurantId, name),
      snapshot => {
        stream.latest = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
        // The FIRST snapshot renders at once. Coalescing it would put a
        // visible delay on every initial load to save a repaint that is not
        // happening yet.
        schedule(name, { immediate: !stream.hasLoaded });
        stream.hasLoaded = true;
      },
      error => onError(error, { stream: name, phase: "listener" })
    );
  }

  function stop(name) {
    const stream = streamFor(name);
    if (stream.timer) { clearTimeout(stream.timer); stream.timer = null; }
    stream.unsubscribe?.();
    stream.unsubscribe = null;
    stream.hasLoaded = false;
  }

  /**
   * Subscribe a screen to a collection. Returns an unsubscribe function.
   *
   * A subscriber joining a stream that already has data is called back
   * immediately with it, which is what removes the spinner from a revisited
   * tab. Dropping the last subscriber closes the listener, so a hotel that
   * navigates away from the calendar stops paying for it.
   */
  function subscribe(name, handler) {
    const stream = streamFor(name);
    stream.subscribers.add(handler);
    start(name);
    if (stream.latest) {
      try { handler(stream.latest); } catch (error) { onError(error, { stream: name, phase: "subscriber" }); }
    }
    return () => {
      stream.subscribers.delete(handler);
      if (!stream.subscribers.size) stop(name);
    };
  }

  /** The cached rows, without subscribing. For a one-off read during a save. */
  function current(name) {
    return streamFor(name).latest || [];
  }

  /** For tests and for asserting the invariant this module exists to hold. */
  function listenerCount() {
    return [...streams.values()].filter(stream => stream.unsubscribe).length;
  }

  function subscriberCount(name) {
    return streamFor(name).subscribers.size;
  }

  function destroy() {
    [...streams.keys()].forEach(stop);
    streams.clear();
  }

  return { subscribe, current, listenerCount, subscriberCount, destroy };
}

/* ---------------------------------------------------------
   DERIVED VIEWS

   Pure shaping of the two collections into what each screen
   needs. Kept out of the render path's way so a screen can be
   re-rendered from cached data without touching Firestore, and
   kept pure so the arithmetic is testable.
--------------------------------------------------------- */
import {
  normalizeRoomStatus, normalizeReservationStatus, reservationHoldsRoom,
  RESERVATION_STATUS, ROOM_STATUS, asStayDate, isSellableRoom
} from "./hotel-core.js?v=s2p-20260922d";

/**
 * The room grid: every room with the booking currently in it, if any.
 *
 * A room's displayed state is the room's own status EXCEPT where a guest is
 * actually in house — an occupied room whose status field says AVAILABLE is a
 * data fault, and showing AVAILABLE would invite a receptionist to sell it.
 * The reservation is the stronger evidence, so it wins, and the mismatch is
 * flagged so it can be repaired rather than silently papered over.
 */
export function roomGrid(rooms = [], reservations = [], businessDate) {
  const today = asStayDate(businessDate);
  const inHouseByRoom = new Map();
  const arrivingByRoom = new Map();

  reservations.forEach(reservation => {
    const status = normalizeReservationStatus(reservation.status);
    const roomId = String(reservation.roomId || "");
    if (!roomId) return;
    if (status === RESERVATION_STATUS.CHECKED_IN) inHouseByRoom.set(roomId, reservation);
    else if (asStayDate(reservation.checkIn) === today && reservationHoldsRoom(reservation)) {
      arrivingByRoom.set(roomId, reservation);
    }
  });

  return rooms.map(room => {
    const id = String(room.id);
    const stored = normalizeRoomStatus(room.status);
    const occupant = inHouseByRoom.get(id) || null;
    const arriving = arrivingByRoom.get(id) || null;
    const displayStatus = occupant ? ROOM_STATUS.OCCUPIED
      : arriving && stored === ROOM_STATUS.AVAILABLE ? ROOM_STATUS.RESERVED
      : stored;
    return {
      ...room,
      id,
      storedStatus: stored,
      status: displayStatus,
      occupant,
      arriving,
      sellable: isSellableRoom(room),
      // Worth surfacing: the room record and the bookings disagree.
      statusMismatch: Boolean(occupant) && stored !== ROOM_STATUS.OCCUPIED
    };
  }).sort((a, b) => String(a.roomNumber || a.id).localeCompare(String(b.roomNumber || b.id), undefined, { numeric: true }));
}

/** Today's arrivals, departures and in-house list, for the front desk. */
export function todayLists(reservations = [], businessDate) {
  const today = asStayDate(businessDate);
  const arrivals = [];
  const departures = [];
  const inHouse = [];

  reservations.forEach(reservation => {
    const status = normalizeReservationStatus(reservation.status);
    if (status === RESERVATION_STATUS.CHECKED_IN) {
      inHouse.push(reservation);
      if (asStayDate(reservation.checkOut) === today) departures.push(reservation);
      return;
    }
    if (asStayDate(reservation.checkIn) === today && reservationHoldsRoom(reservation)) arrivals.push(reservation);
  });

  const byName = (a, b) => String(a.guestName || "").localeCompare(String(b.guestName || ""));
  return { arrivals: arrivals.sort(byName), departures: departures.sort(byName), inHouse: inHouse.sort(byName) };
}

/**
 * The calendar grid: one row per room, one cell per date.
 *
 * Each cell says which booking occupies it and whether it is the first night
 * of that stay, so the renderer can draw one continuous block per booking
 * instead of a run of identical squares.
 */
export function calendarGrid(rooms = [], reservations = [], dates = []) {
  const byRoomNight = new Map();
  reservations.filter(reservationHoldsRoom).forEach(reservation => {
    const roomId = String(reservation.roomId || "");
    const from = asStayDate(reservation.checkIn);
    const to = asStayDate(reservation.checkOut);
    if (!roomId || !from || !to) return;
    dates.forEach(date => {
      // Half-open, exactly as the booking rules define a stay: the checkout
      // day belongs to the next guest.
      if (date >= from && date < to) byRoomNight.set(`${roomId}|${date}`, reservation);
    });
  });

  return rooms.map(room => {
    const roomId = String(room.id);
    return {
      room,
      cells: dates.map(date => {
        const reservation = byRoomNight.get(`${roomId}|${date}`) || null;
        return {
          date,
          reservation,
          isStart: Boolean(reservation) && asStayDate(reservation.checkIn) === date,
          sellable: isSellableRoom(room)
        };
      })
    };
  });
}
