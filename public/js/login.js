import { auth, db } from "./firebase.js";
import { signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const loginForm = document.getElementById("loginForm");
const emailEl = document.getElementById("email");
const passwordEl = document.getElementById("password");

function isRestaurantExpired(restaurantData = {}) {
  const status = String(restaurantData.status || "").toLowerCase();
  const subscriptionStatus = String(restaurantData.subscriptionStatus || "").toLowerCase();
  if (["expired", "suspended"].includes(status) || subscriptionStatus === "expired") return true;
  const rawExpiry = restaurantData.planExpiryDate || restaurantData.expiryDate;
  if (!rawExpiry) return false;
  const expiry = rawExpiry.toDate ? rawExpiry.toDate() : typeof rawExpiry.seconds === "number" ? new Date(rawExpiry.seconds * 1000) : new Date(rawExpiry);
  if (Number.isNaN(expiry.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  expiry.setHours(0, 0, 0, 0);
  return expiry < today;
}

loginForm?.addEventListener("submit", async (e) => {
  e.preventDefault();

  const email = emailEl.value.trim().toLowerCase();
  const password = passwordEl.value.trim();

  if (!email || !password) {
    alert("Enter email and password");
    return;
  }

  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);

    const restaurantSnap = await getDocs(collection(db, "restaurants"));
    const userDocId = email.replaceAll("@", "_").replaceAll(".", "_");

    let foundProfile = null;
    let foundRestaurant = null;

    for (const restDoc of restaurantSnap.docs) {
      const restaurantId = restDoc.id;
      const userRef = doc(db, "restaurants", restaurantId, "users", userDocId);
      const userSnap = await getDoc(userRef);

      if (userSnap.exists()) {
        const data = userSnap.data();

        if (data.email?.toLowerCase() === email) {
          foundProfile = data;
          foundRestaurant = { id: restaurantId, ...restDoc.data() };
          break;
        }
      }
    }

    if (!foundProfile || !foundRestaurant) {
      alert("User profile not found in restaurant users");
      return;
    }

    if (isRestaurantExpired(foundRestaurant)) {
      await signOut(auth);
      alert("Your plan has expired. Please renew to continue using Scan2Plate.");
      return;
    }

    const payload = {
      uid: cred.user.uid,
      email: cred.user.email || email,
      name: foundProfile.name || "",
      role: foundProfile.role || "staff",
      restaurantId: foundProfile.restaurantId || foundRestaurant.id
    };

    localStorage.setItem("scan2plate_user", JSON.stringify(payload));
    localStorage.setItem("scan2serve_user", JSON.stringify(payload));
    localStorage.setItem("scan2plate_last_restaurant_id", payload.restaurantId);

    if ((payload.role || "").toLowerCase() === "kitchen") {
      window.location.href = "./kitchen-dashboard.html";
    } else {
      window.location.href = "./admin-dashboard.html";
    }
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    alert(err.message || "Login failed");
  }
});
