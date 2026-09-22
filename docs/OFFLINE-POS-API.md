# Offline POS Backup & Restore

Backup and restore for the **Scan2Plate Billing** Flutter app. The app runs
fully offline on a local SQLite database; this API is what it uploads to when
it has a connection, and what it downloads from after an uninstall, a
reinstall, or a move to a new device.

Machine-readable spec: [`openapi-offline-pos.yaml`](./openapi-offline-pos.yaml).

---

## The three values the owner needs

In the restaurant dashboard, sidebar → **Connect Offline POS**.

| Value | Where it comes from |
|---|---|
| **Server URL** | Shown on that screen. It is the restaurant's configured backend URL — the same one in Settings → Backend URL. Production is `https://api.scan2plate.com`. |
| **Restaurant Code** | Shown on that screen. It **is** the existing Scan2Plate restaurant id, e.g. `RST006` — not a new number to keep track of. |
| **API Key** | Press **Generate Key**. Name the device when prompted. |

The key is displayed **once**. Scan2Plate stores only a SHA-256 of it, so it
cannot be shown again — if it is lost, generate a new one and revoke the old.
The same screen lists every key with its last-used time, and every device with
its app version, last sync and number of orders synced.

Generate one key per device. Revoking a key stops that device syncing
immediately and leaves the others alone.

### Server URL format

```
https://api.scan2plate.com/api/v1/restaurants/{restaurant_code}
```

Everything below hangs off that base. Example for `RST006`:

```
https://api.scan2plate.com/api/v1/restaurants/RST006/ping
```

---

## Rules that apply to every request

- **HTTPS only.** `Authorization: Bearer <api_key>`.
- **Headers:** `X-Device-Id` (a UUID, stable per install) and `X-App-Version`.
- **JSON, UTF-8.** Money is a number in rupees, to 2 decimals.
- **`uuid` is the identity.** Every record carries a client-generated UUID v4.
  A POST or PUT with an existing uuid **updates** it — it never duplicates.
  The app's local integer ids are not unique across reinstalls, so they are
  stored as `local_id` for reference only and are never keyed on.
- **Timestamps** are ISO-8601 local time with no zone
  (`2026-09-22T13:05:11.123`). Stored exactly as sent — reinterpreting them as
  UTC would shift every timestamp by the device's offset — next to a server
  `received_at` in UTC.
- **Batches** are capped at **500 records**. The app may have been offline for
  days, so results come back per record and only the failures need retrying.

### Status codes

| Code | Meaning |
|---|---|
| 400 | Validation failed. `message` names the field. |
| 401 | Missing, unknown or **revoked** key. |
| 403 | Valid key, but for a different restaurant. |
| 404 | Nothing backed up yet, or unknown uuid. |
| 409 | Conflict. |
| 413 | Batch over 500, or a logo over 500 KB. |
| 429 | Too many requests. |
| 500 | Server fault. |

Errors are always `{ "ok": false, "error": "<code>", "message": "<human text>" }`.

---

## One curl per endpoint

Set these first:

```bash
BASE="https://api.scan2plate.com/api/v1/restaurants/RST006"
KEY="s2p_pos_…"                                  # from Connect Offline POS
DEV="11111111-2222-4333-8444-555555555555"       # stable per install
AUTH=(-H "Authorization: Bearer $KEY" -H "X-Device-Id: $DEV" -H "X-App-Version: 1.4.2" -H "Content-Type: application/json")
```

### 1. Verify the link

```bash
curl "${AUTH[@]}" "$BASE/ping"
```
```json
{ "ok": true, "restaurant_name": "Old Monk Cafe", "server_time": "2026-09-22T07:35:02.411Z" }
```

### 2. Bill settings

```bash
curl -X PUT "${AUTH[@]}" "$BASE/backup/settings" -d '{
  "restaurant_name": "Old Monk Cafe", "address": "Laheriasarai, Darbhanga",
  "phone": "+919876543210", "gstin": "10ABCDE1234F1Z5", "fssai_number": "12345678901234",
  "upi_id": "oldmonk@ybl", "bill_footer_message": "Thank you, visit again",
  "cgst_percent": 2.5, "sgst_percent": 2.5, "logo_base64": null,
  "print_settings": { "paper": "58mm", "copies": 1 },
  "updated_at": "2026-09-22T13:05:11.123"
}'

curl "${AUTH[@]}" "$BASE/backup/settings"
```

A PUT is a **full replace**: a field cleared in the app comes back cleared.
`print_settings` is free-form and is stored and returned exactly as sent.

### 3. Menu — full snapshot

```bash
curl -X PUT "${AUTH[@]}" "$BASE/backup/menu" -d '{
  "categories": [ { "uuid": "aaaaaaaa-1111-4111-8111-111111111111", "name": "Starters", "sort_order": 0 } ],
  "menu_items": [ {
    "uuid": "bbbbbbbb-2222-4222-8222-222222222222",
    "category_uuid": "aaaaaaaa-1111-4111-8111-111111111111",
    "name": "Paneer Tikka", "price": 220.0, "half_price": 120.0,
    "veg": true, "active": true, "favorite": false
  } ],
  "updated_at": "2026-09-22T13:05:11.123"
}'

curl "${AUTH[@]}" "$BASE/backup/menu"
```

**Anything not in the snapshot is deleted.** The whole menu is one document, so
there is no partial state to reconcile and nothing to resurrect on restore.

An item pointing at a `category_uuid` the snapshot does not contain is rejected
with 400, rather than restored as an orphan.

**Older app builds:** `GET $BASE/menu` still returns the original shape
(`{ categories: [{id,name}], menu_items: [{category_id,name,price,veg}] }`)
and is unchanged.

### 4. Tables

```bash
curl -X PUT "${AUTH[@]}" "$BASE/backup/tables" -d '{
  "tables": [ { "uuid": "cccccccc-3333-4333-8333-333333333333", "name": "Table 1", "type": "table", "capacity": 4, "sort_order": 0 } ],
  "updated_at": "2026-09-22T13:05:11.123"
}'

curl "${AUTH[@]}" "$BASE/backup/tables"
```

Takeaway and delivery are not tables and are not sent here.

### 5. Orders — upsert

```bash
curl -X POST "${AUTH[@]}" "$BASE/orders/batch" -d '{
  "orders": [ {
    "uuid": "dddddddd-4444-4444-8444-444444444444", "local_id": 123,
    "table_name": "Table 2", "table_type": "table", "table_uuid": null,
    "status": "billed", "order_number": 14, "business_date": "2026-09-22",
    "created_at": "2026-09-22T13:05:11.123", "closed_at": "2026-09-22T13:45:00.000",
    "kot_count": 2, "discount": 50.0, "discount_type": "flat", "payment_mode": "Cash",
    "subtotal": 2520.0, "cgst": 63.0, "sgst": 63.0, "total": 2646.0,
    "customer_name": null, "company_name": null, "customer_phone": null, "customer_gst": null,
    "items": [ { "uuid": "eeeeeeee-5555-4555-8555-555555555555", "menu_item_uuid": null,
                 "name": "Butter Chicken (Half)", "price": 320.0, "qty": 3, "kot_batch": 1 } ],
    "updated_at": "2026-09-22T13:45:00.000"
  } ]
}'
```
```json
{ "ok": true, "saved": 1, "failed": 0,
  "results": [ { "uuid": "dddddddd-4444-4444-8444-444444444444", "status": "saved" } ] }
```

Re-sending the same uuid **replaces the order entirely, including its items**.
An edit that removed a line must not leave that line behind.

A bad record does not cost the device the batch — the rest still save, and the
per-record `results` say which to retry.

### 6. Delete an order

```bash
curl -X DELETE "${AUTH[@]}" "$BASE/orders/dddddddd-4444-4444-8444-444444444444"
```

404 on an unknown uuid; the app may treat that as success.

### 7. Download orders

```bash
curl "${AUTH[@]}" "$BASE/orders?from=2026-09-01&to=2026-09-22&limit=500"
curl "${AUTH[@]}" "$BASE/orders?cursor=MjAyNi0wOS0yMlQxMDowMDowMC4wMDB8M2YxYw"
```

Sorted by `created_at`, with `uuid` breaking ties so the ordering is total —
two orders written in the same millisecond on a busy till cannot cause the
cursor to skip or repeat a record. Keep following `next_cursor` until it is
`null`. **Still-open orders are included**, so running tables come back.

### 8. Restore after a fresh install

```bash
curl "${AUTH[@]}" "$BASE/restore?business_date=2026-09-22"
```
```json
{ "ok": true, "settings": { }, "menu": { }, "tables": { },
  "counters": { "order_number_date": "2026-09-22", "order_number_counter": 14,
                "takeaway_counter": 37, "delivery_counter": 12 },
  "orders_available": { "count": 1234, "first_date": "2026-01-04", "last_date": "2026-09-22" } }
```

`counters` are computed from stored data so the device carries on numbering
instead of restarting at 1 and colliding with bills that already exist.

> **One decision worth confirming.** All three counters are scoped to a single
> business date, because the app's order numbering resets daily. If takeaway
> and delivery numbering is meant to run continuously rather than per day, say
> so — it is one function, `computeCounters` in `backend/offline-pos-core.js`.

Then fetch orders separately with `GET /orders`, which is paginated.

---

## In the dashboard

Synced orders appear in the restaurant's normal order list and sales reports,
marked **Offline POS** with the device that sent them.

**Only `billed` orders count as revenue.** An `open` order is a running table
and a `cancelled` one was voided; both are visible, neither is money. That
mapping is one function, `toDashboardOrder` in `public/js/offline-pos-view.js`,
and it is the same code the backend imports — there is no second copy to drift.

Per device, the Connect Offline POS screen shows last sync time, app version
and number of orders synced.

---

## Storage

```
offlinePosKeys/{sha256(apiKey)}           one document per device key
restaurants/{code}/offlinePos/settings    full-replace documents
restaurants/{code}/offlinePos/menu
restaurants/{code}/offlinePos/tables
restaurants/{code}/offlinePosOrders/{uuid}
restaurants/{code}/offlinePosDevices/{deviceId}
```

The key document's id **is** the hash, so authenticating a request is one
document read — no query, no index — and a leaked database yields no usable
keys.

`firestore.rules` denies clients everything under `offlinePosKeys`, and the
`restaurants/{id}` catch-all makes the rest owner-only. The API itself runs on
the Admin SDK, which bypasses rules, so the checks above are the access control.

## Tests

```bash
npm test          # 61 core + 29 API tests, among others
```

`test/offline-pos-core.test.mjs` covers validation, counters and cursor
pagination. `test/offline-pos-api.test.mjs` boots the **real** Express app with
Firestore stubbed and covers auth and cross-restaurant 403, idempotent
re-upload, an edit replacing items, the menu snapshot deleting missing items,
pagination across pages, and restore counters.
