import http from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { safeFetch } from '@/lib/checks/util';

/**
 * The only test in the suite that opens real sockets, deliberately.
 *
 * Every other test stubs `fetch`, which means none of them can prove the
 * address guard works — a stub answers whatever it is told to. This one stands
 * up an HTTP server on the loopback interface holding a string no public host
 * would return, then tries to reach it the five ways an attacker would.
 *
 * It caught the gap that made the guard worth writing twice: undici's
 * `connect.lookup` hook never fires for an IP literal, because there is no
 * name to resolve, so the dispatcher alone blocked `http://localhost:PORT/`
 * and let `http://127.0.0.1:PORT/` through.
 */

let internal: http.Server;
let redirector: http.Server;
let internalPort = 0;
let redirectorPort = 0;

beforeAll(async () => {
  internal = http.createServer((_, res) => res.end('SECRET-INTERNAL-DATA'));
  await new Promise<void>((r) => internal.listen(0, '127.0.0.1', () => r()));
  internalPort = (internal.address() as { port: number }).port;

  redirector = http.createServer((req, res) => {
    if (req.url === '/to-ip') {
      res.writeHead(302, { location: `http://127.0.0.1:${internalPort}/` });
      return res.end();
    }
    if (req.url === '/to-name') {
      res.writeHead(302, { location: `http://localhost:${internalPort}/` });
      return res.end();
    }
    if (req.url === '/to-file') {
      res.writeHead(302, { location: 'file:///etc/passwd' });
      return res.end();
    }
    res.end('public page');
  });
  await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', () => r()));
  redirectorPort = (redirector.address() as { port: number }).port;
});

afterAll(() => { internal.close(); redirector.close(); });

describe('safeFetch address guard (live sockets)', () => {
  it('refuses a direct request to a loopback IP literal', async () => {
    expect(await safeFetch(`http://127.0.0.1:${internalPort}/`)).toBeNull();
  });

  it('refuses a direct request to a loopback host name', async () => {
    expect(await safeFetch(`http://localhost:${internalPort}/`)).toBeNull();
  });

  it('refuses a redirect that lands on an IP literal', async () => {
    expect(await safeFetch(`http://127.0.0.1:${redirectorPort}/to-ip`)).toBeNull();
  });

  it('refuses a redirect that lands on a loopback host name', async () => {
    expect(await safeFetch(`http://127.0.0.1:${redirectorPort}/to-name`)).toBeNull();
  });

  it('refuses a redirect to a non-HTTP scheme', async () => {
    expect(await safeFetch(`http://127.0.0.1:${redirectorPort}/to-file`)).toBeNull();
  });
});
