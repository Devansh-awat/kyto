import { describe, expect, test } from 'bun:test';
import { canvasIdsIn, canvasText } from './linked-canvases';

describe('canvasIdsIn', () => {
  // #76: "Full paper and rubric: [candidate exam canvas](…)", never opened.
  test('a linked canvas and an attached one', () => {
    expect(
      canvasIdsIn({
        attachments: [
          {
            mimeType: 'application/vnd.slack-docs',
            type: 'file',
            url: 'https://files.slack.com/files-pri/T0266FRGM-F0C8NU9L55F/canvas',
          },
        ],
        text: 'rubric: <https://hackclub.enterprise.slack.com/docs/T0266FRGM/F0C8FLWAHLM|candidate exam canvas>',
      })
    ).toEqual(['F0C8NU9L55F', 'F0C8FLWAHLM']);
  });

  test('ordinary files and links are not canvases', () => {
    expect(
      canvasIdsIn({
        attachments: [
          {
            mimeType: 'image/png',
            type: 'image',
            url: 'https://files.slack.com/files-pri/T0266FRGM-F0AAAAAAAA/a.png',
          },
        ],
        text: 'see https://example.com/docs/T1/readme',
      })
    ).toEqual([]);
  });

  test('at most two, each once', () => {
    const link = (id: string) => `https://x.slack.com/docs/T01/${id}`;
    expect(
      canvasIdsIn({
        attachments: [],
        text: [
          link('F0000001'),
          link('F0000001'),
          link('F0000002'),
          link('F0000003'),
        ].join(' '),
      })
    ).toEqual(['F0000001', 'F0000002']);
  });
});

describe('canvasText', () => {
  test('blocks become lines, entities decode', () => {
    expect(
      canvasText(
        '<h1>Exam 1</h1><p>Score &amp; time</p><ul><li>one</li><li>two</li></ul>'
      )
    ).toBe('Exam 1\nScore & time\n- one\n- two');
  });
});
