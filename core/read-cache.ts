/**
 * One in-flight load and one stored value per key.
 *
 * `fresh` never returns a snapshot. It joins an in-flight `fresh` load that is
 * running at the current generation (two readers that asked together) and
 * otherwise starts its own; it never joins a non-fresh load. A write drops
 * the key (`invalidate`) so the read after the write cannot observe the
 * pre-write load: that load's generation no longer matches, and it is not
 * stored. The cache is not authority.
 *
 * `maxAgeMs` bounds how long a stored value may satisfy a non-fresh read.
 * Omit it to keep the value until the next invalidate or fresh load.
 */

export interface PayloadCache<T> {
  get(key: string, fresh: boolean, load: () => Promise<T>, maxAgeMs?: number): Promise<T>;
  /** Drop every key, or one key. In-flight loads for a dropped key are not stored. */
  invalidate(key?: string): void;
}

interface Slot<T> {
  generation: number;
  stored?: { generation: number; at: number; value: T };
  flight?: { generation: number; fromFresh: boolean; promise: Promise<T> };
}

export function createPayloadCache<T>(): PayloadCache<T> {
  const slots = new Map<string, Slot<T>>();
  return {
    invalidate(key?: string) {
      if (key === undefined) slots.clear();
      else slots.delete(key);
    },
    get(key, fresh, load, maxAgeMs) {
      let slot = slots.get(key);
      if (!slot) {
        slot = { generation: 0 };
        slots.set(key, slot);
      }
      const ageOk = (at: number) => maxAgeMs === undefined || Date.now() - at < maxAgeMs;
      if (fresh) {
        // A non-fresh load still in flight started before this call. Do not
        // return it: a write may have landed while it was running. Concurrent
        // fresh readers share the load this generation already opened.
        if (slot.flight && slot.flight.fromFresh && slot.flight.generation === slot.generation) {
          return slot.flight.promise;
        }
        slot.generation += 1;
        slot.stored = undefined;
      } else if (slot.stored && slot.stored.generation === slot.generation && ageOk(slot.stored.at)) {
        return Promise.resolve(slot.stored.value);
      } else if (slot.flight && slot.flight.generation === slot.generation) {
        return slot.flight.promise;
      }
      const gen = slot.generation;
      const promise = load().then((value) => {
        if (slots.get(key) === slot && slot.generation === gen) {
          slot.stored = { generation: gen, at: Date.now(), value };
        }
        return value;
      });
      const tracked = promise.finally(() => {
        if (slot.flight?.promise === tracked) slot.flight = undefined;
      });
      slot.flight = { generation: gen, fromFresh: fresh, promise: tracked };
      return tracked;
    },
  };
}
