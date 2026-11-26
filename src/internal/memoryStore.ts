import { Clock, Duration, Effect } from "effect";
import type {
  Claim,
  ClaimResult,
  Fingerprint,
  IdempotencyStore,
  StoredResponse,
} from "../IdempotencyStore.ts";

interface Entry {
  readonly fingerprint: Fingerprint;
  readonly token: string;
  /** Lock expiry while `response` is undefined, retention expiry after. */
  readonly expiresAt: number;
  readonly response: StoredResponse | undefined;
}

/** How often, in milliseconds, a claim also removes every expired entry. */
export const sweepInterval = 60_000;

// JSON keeps the pair unambiguous whatever characters the scope and key hold.
const entryId = (scope: string, key: string): string =>
  JSON.stringify([scope, key]);

/**
 * The store and the number of entries it holds, which only the tests read.
 *
 * Each operation reads the clock and then works on the map in one synchronous
 * step, which is what makes a claim atomic.
 */
export const makeWithSize: Effect.Effect<{
  readonly store: IdempotencyStore["Service"];
  readonly size: Effect.Effect<number>;
}> = Effect.sync(() => {
  const entries = new Map<string, Entry>();
  let tokens = 0;
  let nextSweep = 0;

  // An expired entry is otherwise only removed when its key is claimed
  // again, and most keys never are.
  const sweep = (now: number): void => {
    if (now < nextSweep) return;
    nextSweep = now + sweepInterval;
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(id);
    }
  };

  /** The entry a claim still owns, if its lock has not expired. */
  const owned = (claim: Claim, now: number): Entry | undefined => {
    const entry = entries.get(entryId(claim.scope, claim.key));
    return entry !== undefined &&
      entry.token === claim.token &&
      entry.response === undefined &&
      entry.expiresAt > now
      ? entry
      : undefined;
  };

  return {
    size: Effect.sync(() => entries.size),
    store: {
      claim: ({ fingerprint, key, lockExpiry, scope }) =>
        Effect.map(Clock.currentTimeMillis, (now): ClaimResult => {
          sweep(now);
          const id = entryId(scope, key);
          const existing = entries.get(id);
          if (existing !== undefined && existing.expiresAt > now) {
            return existing.response === undefined
              ? { _tag: "InProgress", fingerprint: existing.fingerprint }
              : {
                  _tag: "Completed",
                  fingerprint: existing.fingerprint,
                  response: existing.response,
                };
          }
          const token = String(++tokens);
          entries.set(id, {
            fingerprint,
            token,
            expiresAt: now + Duration.toMillis(lockExpiry),
            response: undefined,
          });
          return { _tag: "Claimed", claim: { scope, key, token } };
        }),
      complete: (claim, response, retention) =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          const entry = owned(claim, now);
          if (entry === undefined) return;
          entries.set(entryId(claim.scope, claim.key), {
            ...entry,
            expiresAt: now + Duration.toMillis(retention),
            response,
          });
        }),
      release: (claim) =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          if (owned(claim, now) !== undefined)
            entries.delete(entryId(claim.scope, claim.key));
        }),
    },
  };
});

export const make: Effect.Effect<IdempotencyStore["Service"]> = Effect.map(
  makeWithSize,
  ({ store }) => store,
);
