import { describe, expect, test } from 'bun:test';
import { asSchema, tool } from 'ai';
import { z } from 'zod';
import {
  acceptNullOptionals,
  dropNullOptionals,
  isOpenAiModel,
  nullableToolSchemas,
} from './nullable-optionals';

const codingAgentParameters = {
  additionalProperties: false,
  properties: {
    brief: { type: 'string' },
    continue: { type: 'boolean' },
    model: { description: 'Leave unset for the default.', type: 'string' },
    options: {
      properties: { mode: { enum: ['a', 'b'], type: 'string' } },
      type: 'object',
    },
  },
  required: ['brief'],
  type: 'object',
};

describe('nullableToolSchemas', () => {
  test('optional properties accept null, required ones do not', () => {
    const payload: Record<string, unknown> = {
      tools: [
        {
          function: { name: 'codingAgent', parameters: codingAgentParameters },
          type: 'function',
        },
      ],
    };
    expect(nullableToolSchemas(payload)).toBe(true);
    expect(
      JSON.parse(JSON.stringify(payload)).tools[0].function.parameters
    ).toEqual({
      additionalProperties: false,
      properties: {
        brief: { type: 'string' },
        continue: { type: ['boolean', 'null'] },
        model: {
          description: 'Leave unset for the default.',
          type: ['string', 'null'],
        },
        options: {
          properties: {
            mode: { enum: ['a', 'b', null], type: ['string', 'null'] },
          },
          type: ['object', 'null'],
        },
      },
      required: ['brief'],
      type: 'object',
    });
  });

  test('the Responses API shape is rewritten too', () => {
    const payload: Record<string, unknown> = {
      tools: [
        { name: 'x', parameters: codingAgentParameters, type: 'function' },
      ],
    };
    expect(nullableToolSchemas(payload)).toBe(true);
    expect(JSON.stringify(payload)).toContain(
      '"model":{"description":"Leave unset for the default.","type":["string","null"]}'
    );
  });
});

describe('dropNullOptionals', () => {
  test('drops a null optional, keeps a null the schema requires', () => {
    expect(
      dropNullOptionals(
        { brief: null, model: null, options: { mode: null } },
        codingAgentParameters
      )
    ).toEqual({ brief: null, options: {} });
  });
});

describe('acceptNullOptionals', () => {
  test("a null optional passes the tool's own zod schema", async () => {
    const tools = acceptNullOptionals({
      codingAgent: tool({
        inputSchema: z.object({
          brief: z.string(),
          model: z.string().optional(),
        }),
      }),
    });
    const { validate } = asSchema(tools.codingAgent?.inputSchema);
    expect(await validate?.({ brief: 'x', model: null })).toEqual({
      success: true,
      value: { brief: 'x' },
    });
  });
});

test('isOpenAiModel', () => {
  expect(isOpenAiModel('openai/gpt-6-luna')).toBe(true);
  expect(isOpenAiModel('gpt-5.5')).toBe(true);
  expect(isOpenAiModel('anthropic/claude-haiku-5.5')).toBe(false);
  expect(isOpenAiModel('z-ai/glm-5.3-flash')).toBe(false);
});
