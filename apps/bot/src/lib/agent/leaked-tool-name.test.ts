import { describe, expect, test } from 'bun:test';
import { noteToolNames, stripLeakedToolName } from './leaked-tool-name';

describe('stripLeakedToolName', () => {
  test('drops a name glued to the end of a sentence', () => {
    expect(stripLeakedToolName('Here is the comparison.canvasRead')).toBe(
      'Here is the comparison.'
    );
  });

  test('drops a name on its own last line', () => {
    expect(stripLeakedToolName('Updated the canvas.\ncanvasRead\n')).toBe(
      'Updated the canvas.'
    );
  });

  test('keeps a name mentioned in prose', () => {
    const text = 'kyto calls canvasRead before it edits';
    expect(stripLeakedToolName(text)).toBe(text);
    expect(stripLeakedToolName('try canvasRead')).toBe('try canvasRead');
    expect(stripLeakedToolName('tools: canvasRead')).toBe('tools: canvasRead');
    expect(stripLeakedToolName('- canvasRead\n- canvasWrite')).toBe(
      '- canvasRead\n- canvasWrite'
    );
  });

  test('drops a registered core tool name once noted', () => {
    noteToolNames(['codeMode', 'bash']);
    expect(stripLeakedToolName('Picking it back up now.\ncodeMode\n')).toBe(
      'Picking it back up now.'
    );
  });

  test('keeps text that is not a tool name', () => {
    expect(stripLeakedToolName('All done.')).toBe('All done.');
  });
});
