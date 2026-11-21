import {
  afterEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from 'bun:test';
import { hackclubOutage } from '@/lib/ai/hackclub-status';

// Past the status cache, so each case reads its own answer.
const CACHE_STEP_MS = 61_000;
let now = Date.parse('2026-11-21T00:00:00Z');

function answer({ body, status }: { body: string; status: number }) {
  now += CACHE_STEP_MS;
  setSystemTime(new Date(now));
  return spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(body, { status })
  );
}

afterEach(() => {
  setSystemTime();
});

describe('hackclubOutage', () => {
  test('a "down" over parts chat never uses is no outage', async () => {
    // The live answer on 2026-11-21: Replicate's credit scrape failed, every
    // part chat needs was fine, and it still said 503 "down".
    const fetchSpy = answer({
      body: JSON.stringify({
        balanceRemaining: 9.45,
        clickhouse: true,
        exa: true,
        mistral: true,
        openRouter: true,
        postgres: true,
        status: 'down',
      }),
      status: 503,
    });
    expect(await hackclubOutage()).toBeUndefined();
    fetchSpy.mockRestore();
  });

  test('OpenRouter down is an outage', async () => {
    const fetchSpy = answer({
      body: JSON.stringify({
        openRouter: false,
        postgres: true,
        status: 'down',
      }),
      status: 503,
    });
    expect(await hackclubOutage()).toBe(
      "Hack Club AI's model provider is down"
    );
    fetchSpy.mockRestore();
  });

  test('a spent balance is an outage', async () => {
    const fetchSpy = answer({
      body: JSON.stringify({
        balanceRemaining: 0,
        openRouter: true,
        status: 'up',
      }),
      status: 200,
    });
    expect(await hackclubOutage()).toBe('Hack Club AI is out of credit');
    fetchSpy.mockRestore();
  });

  test('a gateway error page means the site itself is down', async () => {
    const fetchSpy = answer({ body: '<html>Bad gateway</html>', status: 502 });
    expect(await hackclubOutage()).toBe(
      "Hack Club AI's status page answers 502"
    );
    fetchSpy.mockRestore();
  });
});
