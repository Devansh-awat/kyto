import { describe, expect, test } from 'bun:test';
import { githubSkillSource, parseSkill } from './parse';

describe('parseSkill', () => {
  test('reads name, description and body', () => {
    const result = parseSkill(
      "---\nname: voice\ndescription: 'It''s audio work.'\nlicense: MIT\n---\n\n# Voice\nbody\n"
    );
    expect(result).toEqual({
      ok: true,
      skill: {
        body: '# Voice\nbody',
        description: "It's audio work.",
        name: 'voice',
      },
    });
  });

  test('refuses a file with no frontmatter', () => {
    expect(parseSkill('# just a heading').ok).toBe(false);
  });

  test('refuses a name that is not a slug', () => {
    expect(
      parseSkill('---\nname: Voice Skill\ndescription: x\n---\nbody').ok
    ).toBe(false);
  });

  test('refuses a missing description', () => {
    expect(parseSkill('---\nname: voice\n---\nbody').ok).toBe(false);
  });
});

describe('githubSkillSource', () => {
  test('a tree folder', () => {
    expect(
      githubSkillSource(
        'https://github.com/agentmail-to/agentmail-skills/tree/main/agentmail-cli'
      )
    ).toEqual({
      dir: 'agentmail-cli',
      owner: 'agentmail-to',
      ref: 'main',
      repo: 'agentmail-skills',
    });
  });

  test('a blob or raw SKILL.md resolves to its folder', () => {
    const expected = { dir: 'a/b', owner: 'o', ref: 'v1', repo: 'r' };
    expect(
      githubSkillSource('https://github.com/o/r/blob/v1/a/b/SKILL.md')
    ).toEqual(expected);
    expect(
      githubSkillSource('https://raw.githubusercontent.com/o/r/v1/a/b/SKILL.md')
    ).toEqual(expected);
  });

  test('anything that is not GitHub over https is refused', () => {
    expect(
      githubSkillSource('http://github.com/o/r/tree/main/x')
    ).toBeUndefined();
    expect(
      githubSkillSource('https://example.com/o/r/tree/main/x')
    ).toBeUndefined();
    expect(
      githubSkillSource('https://github.com.evil.io/o/r/tree/main/x')
    ).toBeUndefined();
    expect(githubSkillSource('https://github.com/o/r')).toBeUndefined();
    expect(
      githubSkillSource('https://github.com/o/r/tree/main/../../x')
    ).toBeUndefined();
  });
});
