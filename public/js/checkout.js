(function () {
  "use strict";

  var BACKEND_URL = "https://scan2plate.onrender.com";
  var RAZORPAY_CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";
  var razorpayScriptPromise = null;

  function loadRazorpayScript() {
    if (window.Razorpay) return Promise.resolve();
    if (razorpayScriptPromise) return razorpayScriptPromise;
    razorpayScriptPromise = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = RAZORPAY_CHECKOUT_SRC;
      script.onload = resolve;
      script.onerror = function () { reject(new Error("Could not load Razorpay checkout.")); };
      document.head.appendChild(script);
    });
    return razorpayScriptPromise;
  }

  document.addEventListener("DOMContentLoaded", function () {
    var modal = document.getElementById("checkoutModal");
    if (!modal) return;

    var formStep = modal.querySelector("[data-checkout-form-step]");
    var payingStep = modal.querySelector("[data-checkout-paying-step]");
    var successStep = modal.querySelector("[data-checkout-success-step]");
    var failedStep = modal.querySelector("[data-checkout-failed-step]");
    var form = modal.querySelector("[data-checkout-form]");
    var errorEl = modal.querySelector("[data-checkout-error]");
    var submitBtn = form ? form.querySelector("[type=submit]") : null;

    function showStep(step) {
      [formStep, payingStep, successStep, failedStep].forEach(function (el) {
        if (el) el.classList.toggle("hidden", el !== step);
      });
    }

    function openModal() {
      showStep(formStep);
      if (errorEl) { errorEl.textContent = ""; errorEl.classList.add("hidden"); }
      modal.classList.add("open");
      document.body.classList.add("checkout-modal-open");
    }

    function closeModal() {
      modal.classList.remove("open");
      document.body.classList.remove("checkout-modal-open");
    }

    document.querySelectorAll("[data-open-checkout]").forEach(function (btn) {
      btn.addEventListener("click", function (event) {
        event.preventDefault();
        openModal();
      });
    });

    modal.querySelectorAll("[data-close-checkout]").forEach(function (btn) {
      btn.addEventListener("click", function (event) {
        event.preventDefault();
        closeModal();
      });
    });

    modal.addEventListener("click", function (event) {
      if (event.target === modal) closeModal();
    });

    modal.querySelectorAll("[data-checkout-retry]").forEach(function (btn) {
      btn.addEventListener("click", function (event) {
        event.preventDefault();
        showStep(formStep);
      });
    });

    function showError(message) {
      if (!errorEl) return;
      errorEl.textContent = message;
      errorEl.classList.remove("hidden");
    }

    function digitsOnly(value) {
      return String(value || "").replace(/\D/g, "");
    }

    if (form) {
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        if (errorEl) { errorEl.textContent = ""; errorEl.classList.add("hidden"); }

        var data = new FormData(form);
        var restaurantName = String(data.get("restaurantName") || "").trim();
        var ownerName = String(data.get("ownerName") || "").trim();
        var phone = digitsOnly(data.get("phone"));
        var email = String(data.get("email") || "").trim();
        var city = String(data.get("city") || "").trim();

        if (!restaurantName || !ownerName || !city || phone.length < 10 || !email.includes("@")) {
          showError("Please fill in every field with a valid phone number and email address.");
          return;
        }

        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Please wait…"; }

        fetch(BACKEND_URL + "/api/subscriptions/create-order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            restaurantName: restaurantName,
            ownerName: ownerName,
            phone: phone,
            email: email,
            city: city,
            planId: "scan2plate-complete",
            billingCycle: "monthly"
          })
        })
          .then(function (response) {
            return response.json().then(function (payload) {
              if (!response.ok || !payload.success) {
                throw new Error((payload && payload.error) || "Could not start checkout. Please try again.");
              }
              return payload;
            });
          })
          .then(function (order) {
            return loadRazorpayScript().then(function () { return order; });
          })
          .then(function (order) {
            showStep(payingStep);
            var options = {
              key: order.publicKeyId,
              amount: order.amount,
              currency: order.currency,
              order_id: order.razorpayOrderId,
              name: "Scan2Plate",
              description: "Scan2Plate Complete — ₹499/month",
              prefill: {
                name: ownerName,
                email: email,
                contact: phone
              },
              notes: {
                restaurantName: restaurantName,
                city: city
              },
              theme: { color: "#e66f00" },
              handler: function (razorpayResponse) {
                verifyPayment(razorpayResponse);
              },
              modal: {
                ondismiss: function () {
                  showStep(failedStep);
                }
              }
            };
            var razorpay = new window.Razorpay(options);
            razorpay.on("payment.failed", function () {
              showStep(failedStep);
            });
            razorpay.open();
          })
          .catch(function (error) {
            showStep(formStep);
            showError(error.message || "Something went wrong. Please try again.");
          })
          .finally(function () {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Continue to Payment — ₹499"; }
          });
      });
    }

    function verifyPayment(razorpayResponse) {
      showStep(payingStep);
      fetch(BACKEND_URL + "/api/subscriptions/verify-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          razorpay_order_id: razorpayResponse.razorpay_order_id,
          razorpay_payment_id: razorpayResponse.razorpay_payment_id,
          razorpay_signature: razorpayResponse.razorpay_signature
        })
      })
        .then(function (response) {
          return response.json().then(function (payload) {
            if (!response.ok || !payload.success) throw new Error("verification_failed");
            return payload;
          });
        })
        .then(function () {
          showStep(successStep);
        })
        .catch(function () {
          showStep(failedStep);
        });
    }
  });
})();
