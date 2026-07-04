import { describe, test, expect } from "vitest";
import { serializeRow } from "./index.js";

describe("serializeRow", () => {
  test("converts Date to ISO string", () => {
    const date = new Date("2024-01-15T12:00:00.000Z");
    const result = serializeRow({ created_at: date });
    expect(result).toEqual({ created_at: "2024-01-15T12:00:00.000Z" });
  });

  test("omits null values", () => {
    const result = serializeRow({ name: "Alice", email: null });
    expect(result).toEqual({ name: "Alice" });
  });

  test("passes through strings and numbers", () => {
    const result = serializeRow({ name: "Alice", age: 30 });
    expect(result).toEqual({ name: "Alice", age: 30 });
  });

  test("passes through booleans", () => {
    const result = serializeRow({ active: true, deleted: false });
    expect(result).toEqual({ active: true, deleted: false });
  });

  test("handles empty object", () => {
    const result = serializeRow({});
    expect(result).toEqual({});
  });

  test("handles all-null object", () => {
    const result = serializeRow({ a: null, b: null });
    expect(result).toEqual({});
  });

  test("handles mixed types", () => {
    const date = new Date("2024-06-01T00:00:00.000Z");
    const result = serializeRow({
      id: "abc",
      count: 42,
      created_at: date,
      deleted_at: null,
      active: true,
    });
    expect(result).toEqual({
      id: "abc",
      count: 42,
      created_at: "2024-06-01T00:00:00.000Z",
      active: true,
    });
  });
});
