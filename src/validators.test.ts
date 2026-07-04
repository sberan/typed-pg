import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { schema } from "tjs";
import { z } from "zod";
import { createDb, TypedDb, serializeRow } from "./index.js";

// Contrast the two validator kinds against a real row carrying a Date and a
// null column. A tjs (JSON-Schema) validator receives the row normalized by
// serializeRow (Date -> ISO string, null omitted -> `optional`); a Zod schema
// receives the RAW row (Date object, null preserved -> `.nullable()`).
const url = process.env.DATABASE_URL;

const TjsRow = schema({
  type: "object",
  properties: {
    id: { type: "integer" },
    label: { type: "string" },
    created_at: { type: "string" },
    note: { type: "string" },
  },
  required: ["id", "label", "created_at"],
});

const ZodRow = z.object({
  id: z.number().int(),
  label: z.string(),
  created_at: z.date(),
  note: z.string().nullable(),
});

describe("serializeRow (tjs normalization)", () => {
  test("Date -> ISO and null omitted", () => {
    const at = new Date("2024-03-04T05:06:07.000Z");
    expect(serializeRow({ id: 1, label: "x", created_at: at, note: null })).toEqual({
      id: 1,
      label: "x",
      created_at: "2024-03-04T05:06:07.000Z",
    });
  });
});

describe.skipIf(!url)("validator kinds against a real row", () => {
  let db: TypedDb;

  beforeAll(async () => {
    db = createDb(url as string);
    await db.exec`drop table if exists typed_pg_validator_test`;
    await db.exec`create table typed_pg_validator_test (
      id int primary key,
      label text not null,
      created_at timestamptz not null,
      note text
    )`;
    await db.exec`insert into typed_pg_validator_test (id, label, created_at, note)
      values (1, ${"a"}, ${"2024-03-04T05:06:07.000Z"}, null)`;
  });

  afterAll(async () => {
    await db.exec`drop table if exists typed_pg_validator_test`;
    await db.end();
  });

  test("tjs validator gets the normalized row (ISO string, note omitted)", async () => {
    const row = await db.one(TjsRow)`
      select id, label, created_at, note from typed_pg_validator_test where id = 1`;
    expect(row).toEqual({ id: 1, label: "a", created_at: "2024-03-04T05:06:07.000Z" });
    //     ^ note is absent (null omitted); created_at is a string
  });

  test("zod schema gets the raw row (Date object, note is null)", async () => {
    const row = await db.one(ZodRow)`
      select id, label, created_at, note from typed_pg_validator_test where id = 1`;
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.created_at.toISOString()).toBe("2024-03-04T05:06:07.000Z");
    expect(row.note).toBeNull();
    expect(row.id).toBe(1);
    expect(row.label).toBe("a");
    // Type inference: row is { id: number; label: string; created_at: Date; note: string | null }
    const _typecheck: { id: number; label: string; created_at: Date; note: string | null } = row;
    void _typecheck;
  });

  test("zod schema enforces the shape (rejects a bad row)", async () => {
    await expect(
      db.one(z.object({ id: z.string() }))`select id from typed_pg_validator_test where id = 1`,
    ).rejects.toThrow();
  });

  test("many and maybeOne work with a zod schema", async () => {
    const rows = await db.many(ZodRow)`
      select id, label, created_at, note from typed_pg_validator_test order by id`;
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBeNull();
    const gone = await db.maybeOne(ZodRow)`
      select id, label, created_at, note from typed_pg_validator_test where id = 999`;
    expect(gone).toBeUndefined();
  });
});

if (!url) {
  console.warn("validators.test.ts: DATABASE_URL not set — real-database validator tests skipped");
}
