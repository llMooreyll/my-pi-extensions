import { err } from "./errors.ts";

type Args = Record<string, unknown>;
const bad = (m: string) => err("bad_request", m);

export function str(a: Args, k: string): string {
  const v = a[k];
  if (typeof v !== "string" || v.length === 0) throw bad(`${k} must be a non-empty string`);
  return v;
}
export function optStr(a: Args, k: string): string | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw bad(`${k} must be a string`);
  return v;
}
export function anyStr(a: Args, k: string): string {
  const v = a[k];
  if (typeof v !== "string") throw bad(`${k} must be a string`);
  return v;
}
export function bool(a: Args, k: string): boolean {
  const v = a[k];
  if (typeof v !== "boolean") throw bad(`${k} must be a boolean`);
  return v;
}
export function optBool(a: Args, k: string): boolean | undefined {
  const v = a[k];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw bad(`${k} must be a boolean`);
  return v;
}
export function optInt(a: Args, k: string, min: number, max: number): number | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw bad(`${k} must be an integer in [${min}, ${max}]`);
  return v;
}
export function oneOf<T extends string>(a: Args, k: string, options: readonly T[]): T {
  const v = a[k];
  if (typeof v !== "string" || !options.includes(v as T)) throw bad(`${k} must be one of ${options.join(", ")}`);
  return v as T;
}
export function optOneOf<T extends string>(a: Args, k: string, options: readonly T[]): T | undefined {
  if (a[k] === undefined || a[k] === null) return undefined;
  return oneOf(a, k, options);
}
export function obj(a: Args, k: string): Record<string, unknown> {
  const v = a[k];
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad(`${k} must be an object`);
  return v as Record<string, unknown>;
}
