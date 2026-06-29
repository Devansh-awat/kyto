import {
  catalogAttempt,
  createAgent,
  deepFallbackAttempts,
  openSession,
  type PiAttempt,
  ROUTER_MODEL,
  type SandboxContext,
  systemPrompt,
} from '@repo/ai';
import { loadSkills } from '@repo/sandbox';
import { type Message, StreamingPlan, type Thread } from 'chat';
import { deleteControls, type postControls } from '@/lib/agent/controls';
import { buildPrompt } from '@/lib/agent/prompt';
import { createReply } from '@/lib/agent/reply';
import { enterModelCapture } from '@/lib/agent/resolved-model';
import { sandbox } from '@/lib/agent/sandbox';
import {
  abortReasonOf,
  interruptTurn,
  queuedInput,
} from '@/lib/agent/steering';
import { clearTurn, getTurn, setTurn } from '@/lib/agent/turns';
import { startThinking } from '@/lib/agent/utils';
import { promptWithAttachments, seedAttachments } from '@/lib/ai/attachments';
import { requestHints } from '@/lib/ai/hints';
import { renderStream } from '@/lib/ai/stream';
import { buildTools } from '@/lib/ai/toolset';
import { runQueuedTurn } from '@/lib/ai/turn-queue';
import { bot, slack } from '@/lib/chat';
import { agentErrorMessage } from '@/lib/errors';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';
import type { ActiveTurn, AgentErrorStage } from '@/types/agent';
import type { AttemptFailure } from '@/types/attempts';

export { stopAllTurns, stopTurn } from '@/lib/agent/turns';

export function runTurn(input: {
  message: Message;
  thread: Thread;
}): Promise<void> {
  const turn = getTurn({ threadId: input.thread.id });
  if (!turn) {
    return runQueuedTurn({
      threadId: input.thread.id,
      run: (controller) => executeTurn(input, controller),
    });
  }

  interruptTurn({ activeTurn: turn, input });
  return slack
    .addReaction(input.thread.id, input.message.id, 'white_check_mark')
    .catch(() => undefined);
}

async function executeTurn(
  { message, thread }: { message: Message; thread: Thread },
  controller: AbortController
): Promise<void> {
  const threadId = thread.id;
  logger.info({ text: message.text, threadId }, '[agent] turn started');
  const activeTurn: ActiveTurn = {
    controller,
    pendingMessages: [],
  };
  setTurn({ threadId, turn: activeTurn });
  await startThinking({ thread });
  const hints = await requestHints({ thread, message });

  let session: Awaited<ReturnType<typeof openSession>> | undefined;
  let activeAttempt: PiAttempt | undefined;
  const controls: Awaited<ReturnType<typeof postControls>> = null;
  let sandboxContext: SandboxContext | undefined;
  let reply: ReturnType<typeof createReply> | undefined;
  let errorStage: AgentErrorStage = 'before_output';

  // No persistence: the Slack thread is the only memory, fed whole into each
  // turn. Tear the session down (kills the E2B sandbox iff it was materialized;
  // a chat-only turn never created one, so this is a cheap no-op there).
  const endSession = async (): Promise<void> => {
    if (!session) {
      return;
    }
    await session.destroy().catch(() => undefined);
  };

  try {
    await thread.post(
      new StreamingPlan(renderTurn({ message, thread }), {
        groupTasks: 'plan',
      })
    );
    if (!session) {
      throw new Error('Agent turn ended before session was recorded.');
    }
    await reply?.flush({ thread });
    if (hints.customization?.prompt && !slack.isDM(thread.id)) {
      await thread
        .post({
          markdown: "_kyto's responses are shaped by this user's instructions_",
        })
        .catch(() => undefined);
    }
    await deleteControls({ controls });
    await endSession();
    logger.info(
      { attempt: attemptLog(activeAttempt), threadId },
      '[agent] turn complete'
    );
  } catch (error) {
    const reason = abortReasonOf(controller.signal);
    if (reason) {
      logger.info({ reason, threadId }, '[agent] turn interrupted');
      await deleteControls({ controls });
      // No persistence: an interrupt re-runs immediately and the follow-up
      // rebuilds context from the whole Slack thread, so we always tear the
      // session down (and its sandbox, if any) regardless of the reason.
      await endSession();
    } else {
      logger.error(
        { attempt: attemptLog(activeAttempt), err: error, threadId },
        '[agent] turn failed'
      );
      await reply?.flush({ thread });
      await endSession();
      await deleteControls({ controls });
      await thread.post(agentErrorMessage({ error, stage: errorStage }));
    }
  } finally {
    clearTurn({ threadId, turn: activeTurn });
    // Only an interrupt replays queued messages; a rapid burst is merged into a
    // single follow-up so steering does not drop intermediate corrections.
    const resume =
      abortReasonOf(controller.signal) === 'interrupt'
        ? queuedInput(activeTurn)
        : undefined;
    if (resume) {
      runTurn(resume).catch((error: unknown) => {
        logger.error(
          { err: error, threadId },
          '[agent] failed to run interrupted follow-up turn'
        );
      });
    }
  }

  async function* renderTurn({
    message,
    thread,
  }: {
    message: Message;
    thread: Thread;
  }) {
    const skills = await loadSkills();
    const messageText = await buildPrompt(message, {
      customizationPrompt: hints.customization?.prompt,
      thread,
    });
    let attachments: Awaited<ReturnType<typeof seedAttachments>> = [];
    // Track real reply text (not generic activity): tool-call/activity chunks
    // don't count, so this tells "the model actually replied" apart from "the
    // model only ran tools and then stopped". A turn that ends with tool activity
    // but no assistant text (and no deliberate skip) is a degenerate completion —
    // the user sees the tool tasks and then silence — so we treat it as an empty
    // turn and fall through to a model that actually answers.
    let producedText = false;
    let skipped = false;
    const attempts: AttemptFailure[] = [];
    // The main query runs on OpenRouter's own model router via HackClub
    // (`openrouter/auto`): OpenRouter picks the best underlying model per
    // request, so we no longer maintain a catalog or pay a separate router-LLM
    // hop. On failure we fall through to the baishui/Gemini deep backup so the
    // bot still answers if HackClub/OpenRouter is down.
    const failedKeys = new Set<string>();
    let triedAuto = false;
    let attempt: PiAttempt | undefined;
    // Built once: the tool set does not depend on the chosen model, and its keys
    // let renderStream hide hallucinated calls to non-existent tools.
    const tools = buildTools({
      bot,
      getSandboxContext: () => sandboxContext,
      message,
      thread,
    });
    const knownTools = new Set(Object.keys(tools));
    // Selects the next attempt as a side effect: `openrouter/auto` first, then
    // the deep backup chain (each entry tried at most once).
    const routeNextAttempt = () => {
      if (!triedAuto) {
        triedAuto = true;
        attempt = catalogAttempt(ROUTER_MODEL);
        return;
      }
      attempt = deepFallbackAttempts.find(
        (candidate) =>
          !failedKeys.has(`${candidate.provider}:${candidate.model}`)
      );
    };
    routeNextAttempt();
    logger.info(
      { model: attempt?.model, provider: attempt?.provider, threadId },
      '[agent] routed turn'
    );
    while (attempt) {
      const currentAttempt = attempt;
      try {
        activeAttempt = currentAttempt;
        const agent = createAgent({
          attempt: currentAttempt,
          onSandboxReady: async (context) => {
            sandboxContext = context;
            // Only seeding attachments touches the sandbox here, and only when
            // the message actually has files — so a chat-only turn leaves the
            // lazy sandbox unmaterialized (zero E2B cost).
            attachments = await seedAttachments({
              message,
              sandboxContext: context,
            });
          },
          sandbox,
          sessionId: threadId,
          skills,
          systemPrompt: systemPrompt({ hints }),
          tools,
        });
        session = await openSession({ agent, threadId });
        reply = createReply({ threadId });
        const modelTaskId = `model-${attempts.length}`;
        const modelTaskTitle =
          attempts.length > 0 ? 'Model · fallback' : 'Model';
        // Surface the model in the thinking section (not the reply text). On a
        // fallback this shows the model we advanced to, so it is visible which
        // model actually served the turn — without announcing it in the output.
        // Opened in_progress and completed after streaming (same id) so the one
        // task updates in place — and so the completion can append the concrete
        // model `openrouter/auto` resolved to.
        yield {
          id: modelTaskId,
          output: `${currentAttempt.provider} · ${currentAttempt.model}`,
          status: 'in_progress',
          title: modelTaskTitle,
          type: 'task_update',
        };
        // `openrouter/auto` resolves the real model server-side; capture it off
        // the global fetch so we can show the concrete pick (see resolved-model).
        const modelHolder = enterModelCapture();
        const result = await agent.stream({
          abortSignal: controller.signal,
          prompt: promptWithAttachments({
            attachments,
            text: messageText,
          }),
          session,
        });
        for await (const chunk of renderStream({
          knownTools,
          onSkip: () => {
            // A skip is a deliberate, successful "no reply" — mark the turn as
            // handled so the empty-response guard below does NOT advance the
            // fallback chain (which previously produced placeholder garbage).
            skipped = true;
          },
          onTextDelta: async (text) => {
            producedText = true;
            errorStage = 'after_text';
            await reply?.append({ text, thread });
          },
          stream: result.stream,
        })) {
          if (errorStage === 'before_output') {
            errorStage = 'after_progress';
          }
          yield chunk;
        }

        // Complete the Model task, appending the concrete model OpenRouter
        // resolved `openrouter/auto` to (now known from the streamed response).
        {
          const resolved =
            modelHolder.model && modelHolder.model !== currentAttempt.model
              ? ` → ${modelHolder.model}`
              : '';
          yield {
            id: modelTaskId,
            output: `${currentAttempt.provider} · ${currentAttempt.model}${resolved}`,
            status: 'complete',
            title: modelTaskTitle,
            type: 'task_update',
          };
        }

        // A model that finishes without producing a reply must NOT be treated as
        // a successful turn — whether it emitted nothing at all (e.g. an upstream
        // 504 swallowed into an empty stream) or only ran tools and then stopped
        // without answering (observed: gemini-3.1-pro ending the loop right after
        // searchSlack). Both end with no user-visible text and no deliberate
        // skip; throw so the fallback chain advances to a model that answers.
        if (!(producedText || skipped)) {
          throw new Error(
            `Model ${currentAttempt.model} returned an empty response.`
          );
        }
        return;
      } catch (error) {
        attempts.push({ attempt: currentAttempt, error });
        failedKeys.add(`${currentAttempt.provider}:${currentAttempt.model}`);
        routeNextAttempt();
        const retryAttempt = attempt;
        // Gate on `producedText`, not `streamed`: if the model only emitted tool
        // activity (no reply text) before failing — including the empty-response
        // throw above — nothing user-visible was shown, so it is safe to fall
        // back to another model. Only a turn that already streamed real reply
        // text must not fall back (it would duplicate the user-facing output).
        if (controller.signal.aborted || producedText || !retryAttempt) {
          throw error;
        }
        logger.warn(
          {
            attempt: attemptLog(currentAttempt),
            err: errorMessage(error),
            nextAttempt: attemptLog(retryAttempt),
            threadId,
          },
          '[agent] attempt failed, falling back'
        );
        await session?.detach().catch(() => undefined);
        session = undefined;
        attempt = retryAttempt;
      }
    }
  }
}

function attemptLog(attempt: PiAttempt | undefined) {
  return attempt
    ? { model: attempt.model, provider: attempt.provider }
    : undefined;
}
