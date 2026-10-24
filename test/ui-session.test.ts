import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createService } from '../src/server.ts';

test('two local UI instances keep independent authenticated sessions in one browser cookie jar', async () => {
  const firstBase = 'http://127.0.0.1:24300';
  const secondBase = 'http://127.0.0.1:24310';
  const first = await createService({ database: ':memory:', baseUrl: firstBase, agentEnabled: false, deliveryIntervalMs: 0 });
  const second = await createService({ database: ':memory:', baseUrl: secondBase, agentEnabled: false, deliveryIntervalMs: 0 });
  try {
    const firstHome = await first.fetch(new Request(firstBase));
    const secondHome = await second.fetch(new Request(secondBase));
    assert.equal(firstHome.status, 200);
    assert.equal(secondHome.status, 200);
    const firstCookie = firstHome.headers.get('set-cookie')!.split(';')[0]!;
    const secondCookie = secondHome.headers.get('set-cookie')!.split(';')[0]!;

    // A browser keys cookies by host/path, without the TCP port. Both sessions
    // must coexist when the user opens a preview alongside the primary app.
    const jar = new Map([firstCookie, secondCookie].map(cookie => {
      const split = cookie.indexOf('=');
      return [cookie.slice(0, split), cookie.slice(split + 1)];
    }));
    assert.equal(jar.size, 2, 'Opening the preview must not overwrite the primary session');
    const combined = [...jar].map(([name, value]) => name + '=' + value).join('; ');

    const bootstrap = (service: typeof first, base: string, cookie: string) => service.fetch(new Request(base + '/api/bootstrap', { headers: { Cookie: cookie } }));
    assert.equal((await bootstrap(first, firstBase, combined)).status, 200);
    assert.equal((await bootstrap(second, secondBase, combined)).status, 200);
    assert.equal((await bootstrap(first, firstBase, secondCookie)).status, 403);
    assert.equal((await bootstrap(second, secondBase, firstCookie)).status, 403);
  } finally {
    await first.close();
    await second.close();
  }
});
