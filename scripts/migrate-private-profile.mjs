#!/usr/bin/env node
/**
 * Moves the owner's login e-mail and name out of the public restaurant
 * document and into restaurants/{id}/private/profile.
 *
 * WHY THIS EXISTS
 * ---------------
 * Firestore rules are document-level. restaurants/{id} has to stay publicly
 * readable, because the public ordering site lists restaurants so a customer
 * can find one. Anything left in that document is therefore world-readable,
 * including adminEmail — which names the login account for the business.
 *
 * Deploying firestore.rules does NOT fix that on its own. This script is the
 * step that actually removes the data from the public document.
 *
 * SAFETY
 * ------
 *  - Copies first and deletes second, per restaurant, so an interrupted run
 *    never loses a field.
 *  - Idempotent: a restaurant already migrated is skipped.
 *  - DRY RUN by default; changes nothing until --apply.
 *  - phone and adminUid are deliberately left alone (see restaurant-private.js).
 *
 * USAGE
 *   cd backend                      # where firebase-admin is installed
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *   node ../scripts/migrate-private-profile.mjs           # dry run
 *   node ../scripts/migrate-private-profile.mjs --apply   # perform the move
 */

import { PRIVATE_PROFILE_FIELDS, needsPrivateMigration } from "../public/js/restaurant-private.js";

/**
 * The migration itself, with its database handed in so it can be tested
 * without touching a real project.
 *
 * @returns {{moved:string[], skipped:string[], failed:Array<{id:string,error:string}>}}
 */
export async function migratePrivateProfiles({ db, FieldValue, apply = false, log = () => {} }) {
  const snapshot = await db.collection("restaurants").get();
  const moved = [];
  const skipped = [];
  const failed = [];

  for (const docSnap of snapshot.docs) {
    const id = docSnap.id;
    const data = docSnap.data() || {};

    if (!needsPrivateMigration(data)) {
      skipped.push(id);
      continue;
    }

    const privatePayload = {};
    for (const field of PRIVATE_PROFILE_FIELDS) {
      const value = data[field];
      if (value !== undefined && value !== null && String(value).trim() !== "") privatePayload[field] = value;
    }

    const fields = Object.keys(privatePayload);
    if (!apply) {
      log(`  [dry run] ${id}: would move ${fields.join(", ")}`);
      moved.push(id);
      continue;
    }

    try {
      // Copy first. If the run dies here the public document is untouched,
      // and rerunning simply repeats the copy.
      await db.doc(`restaurants/${id}/private/profile`).set(
        { ...privatePayload, migratedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );

      // Only now remove them from the document the world can read.
      const deletions = {};
      for (const field of fields) deletions[field] = FieldValue.delete();
      await db.doc(`restaurants/${id}`).update(deletions);

      log(`  moved ${id}: ${fields.join(", ")}`);
      moved.push(id);
    } catch (error) {
      log(`  FAILED ${id}: ${error.message}`);
      failed.push({ id, error: error.message });
    }
  }

  return { moved, skipped, failed };
}

/* ------------------------------------------------------------------ */

const isCli = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isCli) {
  const apply = process.argv.includes("--apply");
  let app, firestore;
  try {
    app = await import("firebase-admin/app");
    firestore = await import("firebase-admin/firestore");
  } catch {
    console.error("firebase-admin is not resolvable from here.");
    console.error("Run this from the backend/ directory, where it is installed:");
    console.error("  cd backend && node ../scripts/migrate-private-profile.mjs" + (apply ? " --apply" : ""));
    process.exit(1);
  }

  if (!app.getApps().length) app.initializeApp({ credential: app.applicationDefault() });
  const db = firestore.getFirestore();

  const result = await migratePrivateProfiles({
    db,
    FieldValue: firestore.FieldValue,
    apply,
    log: message => console.log(message)
  });

  console.log(`\n${apply ? "Migrated" : "Would migrate"}: ${result.moved.length}  ·  already done: ${result.skipped.length}  ·  failed: ${result.failed.length}`);
  if (!apply) console.log("\nNothing was changed. Re-run with --apply to perform the move.");
  if (result.failed.length) process.exitCode = 1;
}
