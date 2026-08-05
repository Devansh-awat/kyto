import { describe, expect, it } from 'bun:test';
import { comparePrefix, prefixUnits } from './cache-probe';

function payload({
  messages,
  tools,
}: {
  messages: unknown[];
  tools?: unknown[];
}): Record<string, unknown> {
  return tools ? { messages, tools } : { messages };
}

describe('prefixUnits', () => {
  it('puts tools first, then every message in order', () => {
    const units = prefixUnits(
      payload({
        messages: [
          { content: 'you are kyto', role: 'system' },
          { content: 'hi', role: 'user' },
        ],
        tools: [{ name: 'bash' }],
      })
    );
    expect(units.map((unit) => unit.label)).toEqual([
      'tools(1)',
      '0:system',
      '1:user',
    ]);
  });

  it('omits the tools unit when the request sends none', () => {
    const units = prefixUnits(
      payload({ messages: [{ content: 'hi', role: 'user' }] })
    );
    expect(units.map((unit) => unit.label)).toEqual(['0:user']);
  });
});

describe('comparePrefix', () => {
  it('reports nothing for the first request of an attempt', () => {
    const next = prefixUnits(
      payload({ messages: [{ content: 'hi', role: 'user' }] })
    );
    expect(comparePrefix([], next)).toBeNull();
  });

  it('calls a pure append healthy — the multi-step tool loop', () => {
    const first = prefixUnits(
      payload({
        messages: [
          { content: 'system', role: 'system' },
          { content: 'ask', role: 'user' },
        ],
        tools: [{ name: 'bash' }],
      })
    );
    const second = prefixUnits(
      payload({
        messages: [
          { content: 'system', role: 'system' },
          { content: 'ask', role: 'user' },
          { role: 'assistant', tool_calls: [{ id: '1' }] },
          { content: 'output', role: 'tool' },
        ],
        tools: [{ name: 'bash' }],
      })
    );
    const divergence = comparePrefix(first, second);
    expect(divergence?.appendOnly).toBe(true);
    expect(divergence?.index).toBe(3);
  });

  it('flags a changed system prompt as churn at the very front', () => {
    const first = prefixUnits(
      payload({ messages: [{ content: 'system at 10:00', role: 'system' }] })
    );
    const second = prefixUnits(
      payload({ messages: [{ content: 'system at 10:01', role: 'system' }] })
    );
    const divergence = comparePrefix(first, second);
    expect(divergence?.appendOnly).toBe(false);
    expect(divergence?.index).toBe(0);
    expect(divergence?.label).toBe('0:system');
    expect(divergence?.stableChars).toBe(0);
  });

  it('flags a tools array that grew mid-turn (loadTools) before any message', () => {
    const first = prefixUnits(
      payload({
        messages: [{ content: 'system', role: 'system' }],
        tools: [{ name: 'bash' }],
      })
    );
    const second = prefixUnits(
      payload({
        messages: [{ content: 'system', role: 'system' }],
        tools: [{ name: 'bash' }, { name: 'gh' }],
      })
    );
    const divergence = comparePrefix(first, second);
    expect(divergence?.appendOnly).toBe(false);
    expect(divergence?.index).toBe(0);
    expect(divergence?.label).toBe('tools(2)');
  });

  it('counts the stable characters ahead of the divergence', () => {
    const first = prefixUnits(
      payload({
        messages: [
          { content: 'system', role: 'system' },
          { content: 'one', role: 'user' },
        ],
      })
    );
    const second = prefixUnits(
      payload({
        messages: [
          { content: 'system', role: 'system' },
          { content: 'two', role: 'user' },
        ],
      })
    );
    const divergence = comparePrefix(first, second);
    expect(divergence?.index).toBe(1);
    expect(divergence?.stableChars).toBe(first[0]?.chars ?? 0);
    expect(divergence?.totalChars).toBe(
      (second[0]?.chars ?? 0) + (second[1]?.chars ?? 0)
    );
  });
});
