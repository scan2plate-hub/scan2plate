import { db } from "./firebase.js";
import { collection, doc, getDoc, getDocs, query, serverTimestamp, setDoc, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const trustedSuperAdminEmails = new Set(["info@scan2plate.com"]);

const normalizeEmail = email => String(email || "").trim().toLowerCase();
const isSuperAdminRole = value => String(value || "").trim().toLowerCase() === "super_admin";
const isDisabled = data => ["disabled", "suspended", "inactive"].includes(String(data?.status || "").toLowerCase());

function devHost() {
  return ["localhost", "127.0.0.1", ""].includes(window.location.hostname);
}

async function getRoleDoc(collectionName, uid) {
  const snapshot = await getDoc(doc(db, collectionName, uid));
  if (!snapshot.exists()) return null;
  return { id: snapshot.id, source: collectionName, ...snapshot.data() };
}

async function getUserRole(uid) {
  const direct = await getRoleDoc("users", uid);
  if (direct && isSuperAdminRole(direct.role)) return direct;
  const userQuery = await getDocs(query(collection(db, "users"), where("uid", "==", uid)));
  const match = userQuery.docs.map(item => ({ id: item.id, source: "users", ...item.data() })).find(item => isSuperAdminRole(item.role));
  return match || null;
}

async function getAdminRole(email) {
  const lookupEmails = [...new Set([normalizeEmail(email), String(email || "").trim()].filter(Boolean))];
  const snapshots = await Promise.all(lookupEmails.map(value => getDocs(query(collection(db, "admins"), where("email", "==", value)))));
  const match = snapshots.flatMap(snapshot => snapshot.docs.map(item => ({ id: item.id, source: "admins", ...item.data() }))).find(item => isSuperAdminRole(item.role));
  return match || null;
}

async function ensureTrustedSuperAdminDocs(user, email) {
  const payload = {
    uid: user.uid,
    email: normalizeEmail(email || user.email),
    role: "super_admin",
    status: "active",
    updatedAt: serverTimestamp()
  };
  await Promise.all([
    setDoc(doc(db, "superAdmins", user.uid), { ...payload, createdAt: serverTimestamp() }, { merge: true }),
    setDoc(doc(db, "users", user.uid), { ...payload, name: user.displayName || "Super Admin" }, { merge: true })
  ]);
  return { source: "trusted_email", name: user.displayName || "Super Admin", ...payload };
}

export function friendlyAuthError(error) {
  const code = String(error?.code || "");
  if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"].includes(code)) {
    return "Invalid email or password. Please check Super Admin account in Firebase Authentication.";
  }
  return error?.message || "Login failed. Please try again.";
}

export function debugSuperAdminLogin(details) {
  if (!devHost()) return;
  const { email, selectedBusinessType, loginSuccess, roleFound, source, redirectUrl } = details || {};
  console.debug("Super Admin login", { email: normalizeEmail(email), selectedBusinessType, loginSuccess, roleFound, source, redirectUrl });
}

export async function resolveSuperAdminRole(user, email) {
  const normalizedEmail = normalizeEmail(email || user?.email);
  const trusted = trustedSuperAdminEmails.has(normalizedEmail);
  const roleChecks = await Promise.all([
    getRoleDoc("superAdmins", user.uid),
    getRoleDoc("super_admins", user.uid),
    getUserRole(user.uid),
    getAdminRole(normalizedEmail)
  ]);
  const roleDoc = roleChecks.find(item => item && (isSuperAdminRole(item.role) || item.source === "superAdmins" || item.source === "super_admins"));
  if (roleDoc && !isDisabled(roleDoc)) return { authorized: true, trusted, source: roleDoc.source, profile: roleDoc };
  if (!trusted) return { authorized: false, trusted, source: roleDoc?.source || "", profile: roleDoc };
  const profile = await ensureTrustedSuperAdminDocs(user, normalizedEmail);
  return { authorized: true, trusted, source: profile.source, profile };
}

export function saveSuperAdminSession(user, profile = {}) {
  const session = {
    uid: user.uid,
    email: normalizeEmail(user.email || profile.email),
    name: profile.name || user.displayName || "Super Admin",
    role: "super_admin",
    status: profile.status || "active",
    source: profile.source || ""
  };
  localStorage.removeItem("scan2plate_user");
  localStorage.removeItem("scan2serve_user");
  localStorage.setItem("scan2serve_super_admin", JSON.stringify(session));
  localStorage.setItem("scan2plate_super_admin", JSON.stringify(session));
  return session;
}
