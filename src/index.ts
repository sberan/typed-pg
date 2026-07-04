import postgres from "postgres";
import type { Validator } from "tjs";

/** Normalize postgres rows for JSON Schema validation:
 *  - Date -> ISO string
 *  - null -> omitted (matches `optional: true` in validators) */
export function serializeRow(row: object): object {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null) continue;
    result[key] = value instanceof Date ? value.toISOString() : value;
  }
  return result;
}

/** Anything with a `parse(value): T` method — notably a Zod schema. Unlike a
 *  JSON-Schema (`tjs`) validator, a parse-validator receives the RAW postgres
 *  row: `Date` values and `null` columns are preserved, so nullable columns are
 *  `.nullable()` (present-and-null), not omitted. */
export interface ParseValidator<T> {
  parse(value: unknown): T;
}

/** A row validator is either a `tjs` `Validator<T>` (JSON-Schema; the row is
 *  normalized via {@link serializeRow} before validation) or a
 *  {@link ParseValidator} such as a Zod schema (the raw row is validated). */
export type RowValidator<T> = Validator<T> | ParseValidator<T>;

function isAssertValidator<T>(validator: RowValidator<T>): validator is Validator<T> {
  return typeof (validator as Validator<T>).assert === "function";
}

/** tjs validators get the JSON-normalized row; parse-validators (Zod) get the
 *  raw postgres row so `Date`/`null` survive to the schema unchanged. */
function validateRow<T>(validator: RowValidator<T>, row: object): T {
  return isAssertValidator(validator)
    ? validator.assert(serializeRow(row))
    : validator.parse(row);
}

// The callable subset shared by postgres.Sql and postgres.TransactionSql —
// the two don't share a supertype in postgres.js's typings.
type QueryTag = (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<postgres.Row[]>;

// postgres.js returns json/jsonb columns as raw text; node-pg parses them into
// JS values. To match node-pg (the ubiquitous expectation, and what row
// schemas written against it assume) json (oid 114) and jsonb (oid 3802) are
// parsed on read. Serialization is left alone for text: a string parameter —
// the `${JSON.stringify(x)}::jsonb` pattern — passes through untouched (no
// double-encoding), and a non-string parameter is JSON-encoded once.
const JSON_TYPE = {
  to: 114,
  from: [114, 3802],
  serialize: (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value)),
  parse: (value: string) => JSON.parse(value),
};

function withJsonParsing(
  options: postgres.Options<Record<string, postgres.PostgresType>> | undefined,
): postgres.Options<Record<string, postgres.PostgresType>> {
  return {
    ...options,
    types: { json: JSON_TYPE as unknown as postgres.PostgresType, ...(options?.types ?? {}) },
  };
}

export class TypedDb {
  private raw: postgres.Sql;
  private tag: QueryTag;

  constructor(
    connectionString: string,
    options?: postgres.Options<Record<string, postgres.PostgresType>>,
  ) {
    this.raw = postgres(connectionString, withJsonParsing(options));
    this.tag = this.raw as unknown as QueryTag;
  }

  one<T>(validator: RowValidator<T>) {
    return async (strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<T> => {
      const rows = await this.tag(strings, ...(values as never[]));
      if (rows.length === 0) throw new Error("Expected one row, got none");
      return validateRow(validator, rows[0]);
    };
  }

  maybeOne<T>(validator: RowValidator<T>) {
    return async (
      strings: TemplateStringsArray,
      ...values: readonly unknown[]
    ): Promise<T | undefined> => {
      const rows = await this.tag(strings, ...(values as never[]));
      return rows.length > 0 ? validateRow(validator, rows[0]) : undefined;
    };
  }

  many<T>(validator: RowValidator<T>) {
    return async (strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<T[]> => {
      const rows = await this.tag(strings, ...(values as never[]));
      return rows.map((r) => validateRow(validator, r));
    };
  }

  exec(strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<void> {
    return this.tag(strings, ...(values as never[])).then(() => {});
  }

  /** Run `fn` inside a transaction. The TypedDb passed to `fn` issues every
   *  query on the transaction's connection; it commits when `fn` resolves and
   *  rolls back when `fn` throws. Nested `begin` is not supported. */
  async begin<T>(fn: (tx: TypedDb) => Promise<T>): Promise<T> {
    if (this.tag !== this.raw) throw new Error("Nested transactions are not supported");
    const result = await this.raw.begin((sql) => {
      // A transaction-scoped view over the same pool: identical API, but every
      // template tag runs on the transaction's reserved connection.
      const tx = Object.create(TypedDb.prototype) as TypedDb;
      tx.raw = this.raw;
      tx.tag = sql as unknown as QueryTag;
      return fn(tx);
    });
    return result as T;
  }

  json(value: Record<string, unknown>): postgres.Parameter {
    return this.raw.json(value as postgres.JSONValue);
  }

  async end(): Promise<void> {
    if (this.tag !== this.raw) throw new Error("Cannot end the pool from inside a transaction");
    await this.raw.end();
  }
}

export function createDb(
  connectionString: string,
  options?: postgres.Options<Record<string, postgres.PostgresType>>,
): TypedDb {
  return new TypedDb(connectionString, options);
}
