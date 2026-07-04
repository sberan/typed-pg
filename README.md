# @sberan/typed-pg

Typed Postgres queries: [postgres.js](https://github.com/porsager/postgres)
template tags whose rows are validated by [tjs](https://www.npmjs.com/package/tjs)
JSON Schema validators.

```ts
import { schema } from "tjs";
import { createDb } from "@sberan/typed-pg";

const db = createDb(process.env.DATABASE_URL!);

const User = schema({
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    created_at: { type: "string" },
  },
  required: ["id", "name"],
});

const user = await db.one(User)`select id, name, created_at from users where id = ${id}`;
//    ^? { id: string; name: string; created_at?: string }

const users = await db.many(User)`select id, name, created_at from users`;
const maybe = await db.maybeOne(User)`select id, name from users where name = ${name}`;
await db.exec`update users set name = ${name} where id = ${id}`;
```

Rows are normalized before validation: `Date` becomes an ISO string and `null`
columns are omitted, so nullable columns are `optional: true` in the schema.

## Transactions

`begin(fn)` runs `fn` inside a transaction. The `TypedDb` passed to `fn` has the
identical API but issues every query on the transaction's connection; the
transaction commits when `fn` resolves and rolls back when it throws.

```ts
const total = await db.begin(async (tx) => {
  await tx.exec`insert into orders (id, user_id) values (${orderId}, ${userId})`;
  await tx.exec`update carts set status = 'closed' where user_id = ${userId}`;
  const row = await tx.one(Total)`select sum(amount)::int as total from orders where user_id = ${userId}`;
  return row.total;
});
```

Nested `begin` throws, and `end()` may only be called on the root pool.

## Tests

`npm test` always runs the unit tests. The transaction tests need a real
database: set `DATABASE_URL` (any disposable Postgres works) and they run too;
without it they are skipped with a warning.
