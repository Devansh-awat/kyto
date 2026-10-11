import { describe, expect, test } from 'bun:test';
import { parsePushCommands, peekPushRefs } from './push-refs';

const OLD = '0'.repeat(40);
const NEW = 'a'.repeat(40);
const pkt = (line: string) =>
  `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;

describe('parsePushCommands', () => {
  test('reads every ref up to the flush', () => {
    const head = Buffer.from(
      `${pkt(`${OLD} ${NEW} refs/heads/u1/fix\0report-status side-band-64k\n`)}${pkt(`${NEW} ${OLD} refs/heads/u1/old\n`)}0000PACK…`
    );
    expect(parsePushCommands(head)).toEqual([
      'refs/heads/u1/fix',
      'refs/heads/u1/old',
    ]);
  });

  test('waits for more, and refuses what is not a command list', () => {
    expect(
      parsePushCommands(Buffer.from(pkt(`${OLD} ${NEW} refs/heads/x\n`)))
    ).toBeUndefined();
    expect(
      parsePushCommands(Buffer.from('\x1f\x8b\x08\x00garbage'))
    ).toBeNull();
    expect(
      parsePushCommands(Buffer.from(`${pkt('push-cert\0x\n')}0000`))
    ).toBeNull();
    expect(parsePushCommands(Buffer.from('0000'))).toEqual([]);
  });
});

describe('peekPushRefs', () => {
  test('replays every byte after peeking', async () => {
    const bytes = Buffer.from(
      `${pkt(`${OLD} ${NEW} refs/heads/u1/fix\0caps\n`)}0000PACKdata`
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 10));
        controller.enqueue(bytes.subarray(10, 60));
        controller.enqueue(bytes.subarray(60));
        controller.close();
      },
    });
    const { body, refs } = await peekPushRefs(stream);
    expect(refs).toEqual(['refs/heads/u1/fix']);
    expect(Buffer.from(await new Response(body).arrayBuffer())).toEqual(bytes);
  });
});
