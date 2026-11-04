## Cause

This isn't a bug in the schema. The error comes from the app's insert, which the schema deliberately blocks.

In section 7 you revoke all table privileges from `authenticated`, and for `orders` you grant only:

```sql
grant select on public.orders to authenticated;
grant update (status) on public.orders to authenticated;
```

There is no `INSERT` grant and no INSERT RLS policy. Postgres checks table privileges before RLS, so a direct `supabase.from('orders').insert(...)` fails with `permission denied for table orders`. The schema comments say the same thing: *"inserts via place_order()"*.

## Fix: call `place_order()` instead of inserting

```ts
// ❌ Remove this
// await supabase.from('orders').insert({ buyer_id, seller_id, total_cents, ... })

// ✅ Use this
const { data: orderId, error } = await supabase.rpc('place_order', {
  p_items: [
    { product_id: 'uuid-of-product-1', quantity: 2 },
    { product_id: 'uuid-of-product-2', quantity: 1 },
  ],
  p_shipping_address: {
    name: 'Jane Doe',
    line1: '123 Main St',
    city: 'Springfield',
    postal_code: '12345',
    country: 'US',
  },
})

if (error) {
  // error.code / error.message come from the function's raise exception calls
  console.error(error)
} else {
  // orderId is the new order's uuid (status = 'pending').
  // Pass it to your backend to create the payment intent.
}
```

The function does the rest:
- It sets `buyer_id` from `auth.uid()`.
- It reads prices, currency and seller from the `products` table.
- It computes the total.
- It locks and decrements stock.
- It inserts the `orders` and `order_items` rows.

The client should send only `product_id` and `quantity`, never prices, totals, `buyer_id` or `seller_id`.

## Don't "fix" it by granting INSERT on orders

Granting insert (or adding an INSERT policy) would let buyers set their own `total_cents`, skip stock checks, and create orders for any seller. That would defeat the design.

## Useful error codes from `place_order`

| Code | Meaning |
|---|---|
| `28000` | Not authenticated (no session or JWT) |
| `22023` | Bad input (empty items, bad quantity, mixed sellers or currencies) |
| `P0002` | Product unavailable (inactive, or seller not active) |
| `42501` | Buying your own product |
| `23514` | Insufficient stock |

If the RPC itself returns `permission denied for function place_order`, the user is probably calling it with the anon role (not logged in). The function is granted to `authenticated` only.

## Related issue

`place_order` decrements stock immediately, but the restock trigger only runs when an order is cancelled. A `pending` order that is never paid or cancelled will hold stock indefinitely. You may want a scheduled job (pg_cron or a backend task) that cancels stale `pending` orders. The restock trigger will then return the stock.