import { z } from 'zod';
import { runnerSchema } from './health.ts';
export { runnerSchema, type Runner } from './health.ts';

/** The runner ids in order — the contract-facing projection of `runnerSchema`. */
export const RUNNER_IDS = runnerSchema.options as readonly z.infer<typeof runnerSchema>[];

function normalizeLegacyRunnerKey(obj: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(obj, 'agy')) return obj;
  const { agy, ...rest } = obj;
  if (rest.antigravity === undefined && agy !== undefined) {
    rest.antigravity = agy;
  }
  return rest;
}

type PerRunnerShape<S extends z.ZodTypeAny> = { [K in z.infer<typeof runnerSchema>]: S };
type PerRunnerObject<S extends z.ZodTypeAny> = z.ZodObject<PerRunnerShape<S>>;

/**
 * One zod key per runner (<id>: schema) — the additive map every runner-bearing shape is built
 * from, so adding a runner to `runnerSchema` extends every per-runner object without hand-editing
 * a key list (the #387 review lesson: a hand-written key list silently STRIPPED every runner added
 * after the list was written). Call sites apply `.partial()` / `.optional()` as their own
 * nullability requires.
 *
 * Also accepts a legacy `'agy'` key and folds it to `'antigravity'` (without overwriting an
 * explicit `'antigravity'` entry), so persisted configs never keep or re-emit `'agy'`.
 */
export function perRunner<S extends z.ZodTypeAny>(schema: S): PerRunnerObject<S> {
  const shape = Object.fromEntries(runnerSchema.options.map((id: string) => [id, schema])) as PerRunnerShape<S>;
  const base = z.object({ ...shape, agy: schema.optional() });
  const wrap = (obj: z.ZodObject<Record<string, z.ZodTypeAny>>): PerRunnerObject<S> =>
    Object.assign(
      obj.transform((parsed) => normalizeLegacyRunnerKey(parsed)),
      {
        shape,
        passthrough: () => wrap(obj.passthrough()),
        strict: () => wrap(obj.strict()),
        partial: () => wrap(obj.partial()),
      },
    ) as unknown as PerRunnerObject<S>;
  return wrap(base);
}
