import { asSchema, type JSONSchema7, jsonSchema, type ToolSet } from 'ai';

type JSONSchema7Definition = JSONSchema7 | boolean;

// OpenAI models fill EVERY property of a tool's schema, optional or not: luna
// sent opencode `model: "."` (and `""`, and the default copied out of the
// description) on 13 of 13 calls, and `opencode run --model .` died with
// "Unexpected server error" on every run in a thread. Its function calling
// was trained on strict schemas, where an optional field is required and
// nullable, so with nothing to say it invents a placeholder. Given a
// `string | null` it sends null (3 of 3, measured 2026-10-18). Haiku leaves
// optional fields out, so only OpenAI requests are rewritten, and haiku's
// cached tool bytes never change.

export function isOpenAiModel(model: string): boolean {
  return /^openai\/|(?:^|\/)gpt-/.test(model);
}

function isSchema(definition: unknown): definition is JSONSchema7 {
  return typeof definition === 'object' && definition !== null;
}

function withNull(definition: JSONSchema7Definition): JSONSchema7Definition {
  if (!isSchema(definition)) {
    return definition;
  }
  const inner = nullableProperties(definition);
  if (typeof inner.type === 'string') {
    if (inner.type === 'null') {
      return inner;
    }
    return {
      ...inner,
      type: [inner.type, 'null'],
      ...(inner.enum ? { enum: [...inner.enum, null] } : {}),
    };
  }
  if (Array.isArray(inner.type)) {
    return inner.type.includes('null')
      ? inner
      : {
          ...inner,
          type: [...inner.type, 'null'],
          ...(inner.enum ? { enum: [...inner.enum, null] } : {}),
        };
  }
  return { anyOf: [inner, { type: 'null' }] };
}

// Every property not in `required` also accepts null, at any depth.
function nullableProperties(schema: JSONSchema7): JSONSchema7 {
  const result: JSONSchema7 = { ...schema };
  if (schema.properties) {
    const required = new Set(schema.required ?? []);
    const properties: Record<string, JSONSchema7Definition> = {};
    for (const [key, definition] of Object.entries(schema.properties)) {
      properties[key] = required.has(key)
        ? recurse(definition)
        : withNull(definition);
    }
    result.properties = properties;
  }
  if (isSchema(schema.items)) {
    result.items = nullableProperties(schema.items);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const list = schema[key];
    if (list) {
      result[key] = list.map(recurse);
    }
  }
  return result;
}

function recurse(definition: JSONSchema7Definition): JSONSchema7Definition {
  return isSchema(definition) ? nullableProperties(definition) : definition;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rewrites a request body's tool schemas in place; true if any changed. */
export function nullableToolSchemas(payload: Record<string, unknown>): boolean {
  if (!Array.isArray(payload.tools)) {
    return false;
  }
  let changed = false;
  for (const tool of payload.tools) {
    // Chat completions nest the schema under `function`; the Responses API
    // doesn't.
    const holder =
      isRecord(tool) && isRecord(tool.function) ? tool.function : tool;
    if (isRecord(holder) && isSchema(holder.parameters)) {
      holder.parameters = nullableProperties(holder.parameters);
      changed = true;
    }
  }
  return changed;
}

// The way back: a null where the schema has an optional property means
// "unset", so it is dropped before the tool's own validation sees it.
export function dropNullOptionals(
  value: unknown,
  schema: JSONSchema7
): unknown {
  if (Array.isArray(value)) {
    const items = schema.items;
    return isSchema(items)
      ? value.map((item) => dropNullOptionals(item, items))
      : value;
  }
  if (!(isRecord(value) && schema.properties)) {
    return value;
  }
  const required = new Set(schema.required ?? []);
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    const definition = schema.properties[key];
    if (field === null && !required.has(key) && definition !== undefined) {
      continue;
    }
    result[key] = isSchema(definition)
      ? dropNullOptionals(field, definition)
      : field;
  }
  return result;
}

/** Same tools and the same schema bytes; validation first drops optional nulls. */
export function acceptNullOptionals(tools: ToolSet): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (tool.inputSchema === undefined) {
      wrapped[name] = tool;
      continue;
    }
    const schema = asSchema(tool.inputSchema);
    wrapped[name] = {
      ...tool,
      inputSchema: jsonSchema(() => schema.jsonSchema, {
        validate: async (value) => {
          const cleaned = dropNullOptionals(value, await schema.jsonSchema);
          return schema.validate
            ? schema.validate(cleaned)
            : { success: true, value: cleaned };
        },
      }),
    };
  }
  return wrapped;
}
