import { describe, expect, test } from 'bun:test';
import { isMediaOnlyBrief, isReadOnlyBrief } from './coding-agent';

describe('isMediaOnlyBrief', () => {
  test('a one-off media file is bash work (#110)', () => {
    for (const brief of [
      'Make a 128x128 two-frame GIF with ImageMagick from emoji.png, a.png and b.png: keep the checkmark, swap the small picture every 6 seconds, loop forever. Save as out.gif.',
      'Use ffmpeg to cut clip.mp4 to the first 10 seconds and save it as short.mp4.',
      'Resize every png in ./pics to 512px wide and convert them to webp.',
      'Add a watch strap to pebble-time-2.stl: attach two lugs and a 22mm band and save it as strap.stl.',
    ]) {
      expect(isMediaOnlyBrief(brief)).toBe(true);
    }
  });

  test('code work that touches media still goes to the coding agent', () => {
    for (const brief of [
      'Write a Node CLI that converts PNGs to WebP with sharp, with tests.',
      'In the repo at ./bot, fix the ffmpeg call in src/encode.ts so the server stops crashing.',
      'Build a Fabric mod that adds a block; the texture is block.png.',
      'Fix the failing typecheck in packages/db.',
    ]) {
      expect(isMediaOnlyBrief(brief)).toBe(false);
    }
  });
});

describe('isReadOnlyBrief', () => {
  test('reading or reviewing code is not coding work (#199)', () => {
    expect(
      isReadOnlyBrief(
        'Perform a read-only code review of the GitHub pull request in ./nephthys-plus and report bugs.'
      )
    ).toBe(true);
    expect(
      isReadOnlyBrief('Explain how the auth middleware in ./api works.')
    ).toBe(true);
  });

  test('a review that also changes code still runs', () => {
    expect(isReadOnlyBrief('Review the PR, then fix the bugs you find.')).toBe(
      false
    );
    expect(isReadOnlyBrief('Build a CLI that parses logs.')).toBe(false);
  });
});
