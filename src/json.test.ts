import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import { createDb, TypedDb } from "./index.js";

// json/jsonb parity with node-pg: columns come back parsed (not raw text),
// while the `${JSON.stringify(x)}::jsonb` write pattern still stores valid JSON.
const url = process.env.DATABASE_URL;

const Row = z.object({
  id: z.number().int(),
  tools: z.array(z.record(z.string(), z.unknown())),
  runtime: z.record(z.string(), z.unknown()),
  note: z.record(z.string(), z.unknown()).nullable(),
});

describe.skipIf(!url)("json/jsonb parsing", () => {
  let db: TypedDb;

  beforeAll(async () => {
    db = createDb(url as string);
    await db.exec`drop table if exists typed_pg_json_test`;
    await db.exec`create table typed_pg_json_test (id int, tools jsonb, runtime jsonb, note jsonb, j json)`;
    // Write the way repositories do: a JSON.stringify'd string + ::jsonb cast.
    await db.exec`insert into typed_pg_json_test (id, tools, runtime, note, j)
      values (1, ${JSON.stringify([{ a: 1 }])}::jsonb, ${JSON.stringify({ x: true })}::jsonb, null, ${JSON.stringify({ k: 2 })}::json)`;
  });

  afterAll(async () => {
    await db.exec`drop table if exists typed_pg_json_test`;
    await db.end();
  });

  test("jsonb columns are parsed on read (array, object, null)", async () => {
    const row = await db.one(Row)`
      select id, coalesce(tools, '[]'::jsonb) as "tools",
             coalesce(runtime, '{}'::jsonb) as "runtime", note
      from typed_pg_json_test where id = 1`;
    expect(Array.isArray(row.tools)).toBe(true);
    expect(row.tools).toEqual([{ a: 1 }]);
    expect(row.runtime).toEqual({ x: true });
    expect(row.note).toBeNull();
  });

  test("the string + ::jsonb write stored valid JSON, not double-encoded", async () => {
    const probe = z.object({ a: z.string().nullable(), x: z.string().nullable() });
    const row = await db.one(probe)`
      select tools->0->>'a' as a, runtime->>'x' as x from typed_pg_json_test where id = 1`;
    expect(row.a).toBe("1");
    expect(row.x).toBe("true");
  });

  test("json (oid 114) is parsed on read too", async () => {
    const row = await db.one(z.object({ j: z.record(z.string(), z.unknown()) }))`
      select j from typed_pg_json_test where id = 1`;
    expect(row.j).toEqual({ k: 2 });
  });

  test("a non-string object param is JSON-encoded once", async () => {
    await db.exec`insert into typed_pg_json_test (id, tools) values (2, ${db.json({ b: 9 })})`;
    const row = await db.one(z.object({ tools: z.record(z.string(), z.unknown()) }))`
      select tools from typed_pg_json_test where id = 2`;
    expect(row.tools).toEqual({ b: 9 });
  });
});

if (!url) {
  console.warn("json.test.ts: DATABASE_URL not set — real-database json tests skipped");
}
