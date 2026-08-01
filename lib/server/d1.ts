import { HttpError } from "./http-security";

export interface D1ResultLike<T = Record<string, unknown>> {
  success: boolean;
  results?: T[];
  error?: string;
  meta?: { changes?: number; last_row_id?: number | string };
}
export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatementLike[],
  ): Promise<D1ResultLike<T>[]>;
}

export function requireD1Binding(value: unknown): D1DatabaseLike {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as D1DatabaseLike).prepare !== "function" ||
    typeof (value as D1DatabaseLike).batch !== "function"
  ) {
    throw new HttpError(503, "DATABASE_UNAVAILABLE", "The application database is unavailable.", {
      expose: false,
    });
  }
  return value as D1DatabaseLike;
}

export async function firstOrNull<T>(
  statement: D1PreparedStatementLike,
): Promise<T | null> {
  return statement.first<T>();
}

export async function allRows<T>(
  statement: D1PreparedStatementLike,
): Promise<T[]> {
  const result = await statement.all<T>();
  if (!result.success) {
    throw new HttpError(500, "DATABASE_QUERY_FAILED", "The database query failed.", {
      expose: false,
    });
  }
  return result.results ?? [];
}
