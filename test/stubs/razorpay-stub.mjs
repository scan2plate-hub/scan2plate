/* Records what the server asked Razorpay to do, so tests can assert that a
   plan is created only when it genuinely must be, and that a subscription
   bills against the right plan id. */
export const calls = { plans: [], subscriptions: [], cancels: [], orders: [], fetches: [] };

/* Plans that "exist" at Razorpay, as if created in its dashboard. A plan id
   from the other mode is simply absent here, which is exactly how Razorpay
   behaves: there is no cross-mode lookup, the id just does not resolve. */
export const existingPlans = new Map();

export function seedPlan(id, { period = "monthly", interval = 1, amount = 49900, currency = "INR" } = {}) {
  existingPlans.set(id, { id, period, interval, item: { id: `item_${id}`, amount, currency, name: id } });
}

export function resetCalls() {
  calls.plans.length = 0;
  calls.subscriptions.length = 0;
  calls.cancels.length = 0;
  calls.orders.length = 0;
  calls.fetches.length = 0;
  existingPlans.clear();
}

export default class RazorpayStub {
  constructor(options) {
    this.options = options;
    this.plans = {
      create: async payload => {
        calls.plans.push(payload);
        const id = `plan_stub_${calls.plans.length}`;
        const plan = { id, ...payload };
        existingPlans.set(id, plan);
        return plan;
      },
      fetch: async id => {
        calls.fetches.push(id);
        const plan = existingPlans.get(id);
        if (!plan) {
          const error = new Error("The id provided does not exist");
          error.statusCode = 400;
          throw error;
        }
        return plan;
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
