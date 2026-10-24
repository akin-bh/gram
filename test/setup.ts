import { expect } from 'bun:test';

// The error must satisfy the predicate exactly, as validator functions did under node:assert.
// expect(fn) calls the function; after .rejects, Bun passes the rejection reason instead.
expect.extend({
  toThrowSatisfying(received: unknown, predicate: (error: any) => boolean) {
    let error: unknown;
    if (typeof received === 'function') {
      try {
        received();
        return { pass: false, message: () => 'Expected the function to throw' };
      } catch (caught) {
        error = caught;
      }
    } else error = received;
    const pass = predicate(error) === true;
    return { pass, message: () => pass ? 'Expected the error not to satisfy the predicate' : `The error did not satisfy the predicate: ${Bun.inspect(error)}` };
  },
});

declare module 'bun:test' {
  interface Matchers<T> {
    toThrowSatisfying(predicate: (error: any) => boolean): void;
  }
}
