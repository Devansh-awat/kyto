import { describe, expect, test } from 'bun:test';
import { stepsCostUsd } from './usage-cost';

describe('stepsCostUsd', () => {
  test('adds the upstream cost on a BYOK route, where cost is 0', () => {
    const steps = [
      {
        usage: {
          raw: {
            cost: 0,
            cost_details: { upstream_inference_cost: 0.002 },
            is_byok: true,
          },
        },
      },
      { usage: { raw: { cost: 0.001 } } },
    ];
    expect(stepsCostUsd(steps)).toBeCloseTo(0.003);
  });

  test('ignores the upstream figure when the route is not BYOK', () => {
    const steps = [
      {
        usage: {
          raw: { cost: 0.01, cost_details: { upstream_inference_cost: 0.01 } },
        },
      },
    ];
    expect(stepsCostUsd(steps)).toBeCloseTo(0.01);
  });

  test('is undefined when no step reported a cost', () => {
    expect(stepsCostUsd([{ usage: {} }, { usage: { raw: 'x' } }])).toBe(
      undefined
    );
  });
});
