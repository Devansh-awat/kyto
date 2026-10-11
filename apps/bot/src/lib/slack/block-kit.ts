import { z } from 'zod';
import { slack } from '@/lib/chat';
import { errorMessage } from '@/lib/utils/error';

// Code channel tabs are stricter than messages, and setView answers only
// `invalid_blocks` with no detail, so these rules (found live) are checked by
// hand. Slack's blocks.validate knows only the message rules.
const TAB_REFUSED_BLOCKS: Record<string, string> = {
  alert: 'alert blocks (those are for modals)',
  file: 'file blocks',
};
const TAB_REFUSED_IN_ACTIONS = new Set([
  'multi_channels_select',
  'multi_conversations_select',
  'multi_external_select',
  'multi_static_select',
  'multi_users_select',
]);
const TAB_REFUSED_AS_ACCESSORY = new Set(['datetimepicker']);
const TAB_REFUSED_IN_INPUT = new Set(['file_input', 'rich_text_input']);

const typed = z.looseObject({ type: z.string().optional() });
const blockSchema = z.looseObject({
  accessory: typed.optional(),
  child_blocks: z.array(z.unknown()).optional(),
  element: typed.optional(),
  elements: z.array(z.unknown()).optional(),
  type: z.string().optional(),
});

const validateResponse = z.looseObject({
  error: z.string().optional(),
  errors: z
    .array(
      z.looseObject({
        code: z.string().optional(),
        message: z.string().optional(),
        pointer: z.string().optional(),
      })
    )
    .optional(),
  ok: z.boolean().optional(),
});

function tabProblems(blocks: unknown[]): string[] {
  const problems: string[] = [];
  const check = (raw: unknown, pointer: string) => {
    const block = blockSchema.safeParse(raw);
    if (!block.success) {
      return;
    }
    const { accessory, child_blocks, element, elements, type } = block.data;
    const refused = type ? TAB_REFUSED_BLOCKS[type] : undefined;
    if (refused) {
      problems.push(`${pointer}: tabs don't take ${refused}.`);
    }
    if (type === 'actions') {
      for (const [index, child] of (elements ?? []).entries()) {
        const childType = typed.safeParse(child).data?.type;
        if (childType && TAB_REFUSED_IN_ACTIONS.has(childType)) {
          problems.push(
            `${pointer}/elements/${index}: tabs don't take a ${childType} in an actions block; put it in its own section block as the accessory.`
          );
        }
      }
    }
    if (
      type === 'section' &&
      accessory?.type &&
      TAB_REFUSED_AS_ACCESSORY.has(accessory.type)
    ) {
      problems.push(
        `${pointer}/accessory: tabs don't take a ${accessory.type} as an accessory; put it in an actions block.`
      );
    }
    if (
      type === 'input' &&
      element?.type &&
      TAB_REFUSED_IN_INPUT.has(element.type)
    ) {
      problems.push(`${pointer}/element: tabs don't take a ${element.type}.`);
    }
    for (const [index, child] of (child_blocks ?? []).entries()) {
      check(child, `${pointer}/child_blocks/${index}`);
    }
  };
  for (const [index, block] of blocks.entries()) {
    check(block, `/${index}`);
  }
  return problems;
}

/**
 * Every problem Slack (and, for a tab, the tab rules) finds in `blocks`, each
 * with a JSON pointer like `/0/elements/1`. Empty means valid. A failed call
 * to Slack is reported as unknown rather than valid or invalid: it says
 * nothing about the blocks, so it must not block a post.
 */
export async function blockKitProblems({
  blocks,
  surface,
}: {
  blocks: unknown[];
  surface: 'message' | 'tab';
}): Promise<{ problems: string[]; unchecked?: string }> {
  const problems: string[] = [];
  let unchecked: string | undefined;
  try {
    const response = validateResponse.parse(
      await slack.webClient.apiCall('blocks.validate', { blocks })
    );
    if (response.ok === false) {
      for (const error of response.errors ?? []) {
        problems.push(
          `${error.pointer ?? '?'}: ${error.message ?? error.code ?? 'invalid'}`
        );
      }
      if (!response.errors?.length) {
        problems.push(`Slack refused them (${response.error ?? 'invalid'}).`);
      }
    }
  } catch (error) {
    // The WebClient throws on ok:false too; its response still carries the
    // detail, which is the whole point of asking.
    const data =
      error instanceof Error && 'data' in error
        ? validateResponse.safeParse(error.data).data
        : undefined;
    if (data?.errors?.length) {
      for (const item of data.errors) {
        problems.push(
          `${item.pointer ?? '?'}: ${item.message ?? item.code ?? 'invalid'}`
        );
      }
    } else if (data?.error === 'invalid_blocks') {
      problems.push('Slack refused them (invalid_blocks).');
    } else {
      unchecked = errorMessage(error);
    }
  }
  if (surface === 'tab') {
    problems.push(...tabProblems(blocks));
  }
  return unchecked ? { problems, unchecked } : { problems };
}

export function describeBlockKitProblems(problems: string[]): string {
  return `The blocks are not valid Block Kit (pointers are /block/...):\n${problems.map((problem) => `- ${problem}`).join('\n')}\nFix what each one points at and try again.`;
}
