/* Records what the server asked Razorpay to do, so tests can assert that a
   plan is created only when it genuinely must be, and that a subscription
   bills against the right plan id. */
export const calls = { plans: [], subscriptions: [], cancels: [], orders: [] };

export function resetCalls() {
  calls.plans.length = 0;
  calls.subscriptions.length = 0;
  calls.cancels.length = 0;
  calls.orders.length = 0;
}

export default class RazorpayStub {
  constructor(options) {
    this.options = options;
    this.plans = {
      create: async payload => {
        calls.plans.push(payload);
        return { id: `plan_stub_${calls.plans.length}`, ...payload };
      }
    };
    this.subscriptions = {
      create: async payload => {
        calls.subscriptions.push(payload);
        return {
          id: `sub_stub_${calls.subscriptions.length}`,
          status: "created",
          current_start: Math.floor(Date.parse("2026-09-18T00:00:00Z") / 1000),
          current_end: Math.floor(Date.parse("2026-10-18T00:00:00Z") / 1000),
          ...payload
        };
      },
      cancel: async (id, payload) => { calls.cancels.push({ id, payload }); return { id, status: "cancelled" }; }
    };
    this.orders = {
      create: async payload => { calls.orders.push(payload); return { id: `order_stub_${calls.orders.length}`, ...payload }; }
    };
  }
}
