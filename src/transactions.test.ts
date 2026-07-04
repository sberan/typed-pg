import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { schema } from "tjs";
import { createDb, TypedDb } from "./index.js";

// Real-database transaction tests. Point DATABASE_URL at a disposable
// Postgres (e.g. `docker run --rm -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:15`)
// to run them; without it the suite is skipped and says so.
const url = process.env.DATABASE_URL;

const Row = schema({
  type: "object",
  properties: { id: { type: "integer" }, label: { type: "string" } },
  required: ["id", "label"],
});

const Count = schema({
  type: "object",
  properties: { count: { type: "integer" } },
  required: ["count"],
});

describe.skipIf(!url)("transactions", () => {
  let db: TypedDb;

  beforeAll(async () => {
    db = createDb(url as string);
    await db.exec`drop table if exists typed_pg_tx_test`;
    await db.exec`create table typed_pg_tx_test (id int primary key, label text not null)`;
  });

  afterAll(async () => {
    await db.exec`drop table if exists typed_pg_tx_test`;
    await db.end();
  });

  test("commits when the callback resolves", async () => {
    await db.begin(async (tx) => {
      await tx.exec`insert into typed_pg_tx_test (id, label) values (1, ${"committed"})`;
    });
    const row = await db.one(Row)`select id, label from typed_pg_tx_test where id = 1`;
    expect(row).toEqual({ id: 1, label: "committed" });
  });

  test("rolls back when the callback throws", async () => {
    await expect(
      db.begin(async (tx) => {
        await tx.exec`insert into typed_pg_tx_test (id, label) values (2, ${"doomed"})`;
        const seen = await tx.one(Count)`select count(*)::int as count from typed_pg_tx_test where id = 2`;
        expect(seen.count).toBe(1);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const gone = await db.maybeOne(Row)`select id, label from typed_pg_tx_test where id = 2`;
    expect(gone).toBeUndefined();
  });

  test("returns the callback result", async () => {
    const value = await db.begin(async (tx) => {
      const row = await tx.one(Count)`select 41 + 1 as count`;
      return row.count;
    });
    expect(value).toBe(42);
  });

  test("queries inside the transaction see uncommitted writes; outside they do not", async () => {
    await db.begin(async (tx) => {
      await tx.exec`insert into typed_pg_tx_test (id, label) values (3, ${"pending"})`;
      const inside = await tx.maybeOne(Row)`select id, label from typed_pg_tx_test where id = 3`;
      expect(inside).toEqual({ id: 3, label: "pending" });
      const outside = await db.maybeOne(Row)`select id, label from typed_pg_tx_test where id = 3`;
      expect(outside).toBeUndefined();
    });
  });

  test("nested begin throws", async () => {
    await expect(
      db.begin(async (tx) => {
        await tx.begin(async () => {});
      }),
    ).rejects.toThrow("Nested transactions are not supported");
  });

  test("end inside a transaction throws", async () => {
    await expect(
      db.begin(async (tx) => {
        await tx.end();
      }),
    ).rejects.toThrow("Cannot end the pool from inside a transaction");
  });

  test("many and validator failures behave inside a transaction", async () => {
    await db.begin(async (tx) => {
      const rows = await tx.many(Row)`select id, label from typed_pg_tx_test order by id`;
      expect(rows.length).toBeGreaterThan(0);
      await expect(
        tx.one(Row)`select 'not-an-int' as id, 'x' as label`,
      ).rejects.toThrow();
    });
  });
});

if (!url) {
  console.warn("transactions.test.ts: DATABASE_URL not set — real-database transaction tests skipped");
}
