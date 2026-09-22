/* =========================================================
   RESTAURANT PRIVATE PROFILE
   ---------------------------------------------------------
   Firestore rules are document-level, not field-level: a rule
   can allow reading a document or not, never "this field but
   not that one". The restaurants/{id} document has to stay
   publicly readable, because the public ordering site lists
   restaurants to let a customer find one.

   So the fields that must not be public cannot stay in that
   document. They move to restaurants/{id}/private/profile,
   which firestore.rules restricts to the restaurant's own
   admin and to super admins.

   What moves, and what deliberately does not:

     adminEmail  moves  — it names the login account for the
     email       moves    business, which is the first half of
                          an account takeover.
     ownerName   moves  — a person's name, with no public use.

     phone       STAYS  — the order tracking page renders a
                          "Call Staff" button from it, so it is
                          business contact information the
                          customer is meant to have.
     adminUid    STAYS  — an opaque Firebase id, not a
                          credential, and firestore.rules reads
                          it from the root document to decide
                          who owns the restaurant.
========================================================= */

export const PRIVATE_PROFILE_FIELDS = ["adminEmail", "email", "ownerName"];

export const PRIVATE_PROFILE_PATH = ["private", "profile"];

/**
 * Splits a restaurant payload into the part that may live in the public
 * document and the part that must not. Neither object shares structure
 * with the input, so callers can write them independently.
 */
export function splitRestaurantPayload(payload = {}) {
  const publicFields = {};
  const privateFields = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (PRIVATE_PROFILE_FIELDS.includes(key)) privateFields[key] = value;
    else publicFields[key] = value;
  }
  return { publicFields, privateFields };
}

/**
 * The view an authorised reader (owner or super admin) wants: the public
 * document with the private profile laid back over it. The private copy
 * wins, because it is the one that is kept up to date after the move.
 */
export function mergeRestaurantProfile(root = {}, privateProfile = null) {
  if (!privateProfile) return { ...root };
  const merged = { ...root };
  for (const field of PRIVATE_PROFILE_FIELDS) {
    const value = privateProfile[field];
    if (value !== undefined && value !== null && String(value).trim() !== "") merged[field] = value;
  }
  return merged;
}

/**
 * The owner's login e-mail, wherever it currently lives.
 *
 * A restaurant created before the split still carries adminEmail in its
 * root document, and the backfill has not necessarily run, so both shapes
 * have to read correctly. Returns "" rather than a placeholder so callers
 * choose their own dash.
 */
export function ownerEmailOf(record = {}, privateProfile = null) {
  const merged = mergeRestaurantProfile(record, privateProfile);
  return String(merged.ownerEmail || merged.adminEmail || merged.email || "").trim();
}

export function ownerNameOf(record = {}, privateProfile = null) {
  return String(mergeRestaurantProfile(record, privateProfile).ownerName || "").trim();
}

/** True when this root document still carries fields that must move. */
export function needsPrivateMigration(root = {}) {
  return PRIVATE_PROFILE_FIELDS.some(field => {
    const value = root?.[field];
    return value !== undefined && value !== null && String(value).trim() !== "";
  });
}
