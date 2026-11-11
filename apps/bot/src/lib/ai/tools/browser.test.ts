import { expect, test } from 'bun:test';
import { chainAgentBrowser } from './browser';

test('chainAgentBrowser gives each chained segment its own agent-browser', () => {
  expect(chainAgentBrowser('fill @e9 "a && b" && click @e8')).toBe(
    'agent-browser fill @e9 "a && b" && agent-browser click @e8'
  );
  expect(chainAgentBrowser('wait 3000; snapshot -i')).toBe(
    'agent-browser wait 3000 && agent-browser snapshot -i'
  );
  expect(chainAgentBrowser("eval 'a;b'")).toBe("agent-browser eval 'a;b'");
});
