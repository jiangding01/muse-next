import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { MusicEvent, Relation } from '../../../src/domain/index';
import { eventId, isKnownVoiceStyle, relationId, voiceId } from '../../../src/domain/index';

const DOMAIN_DIR = join(import.meta.dirname, '../../../src/domain');

const FORBIDDEN = [
  /(^|\/)formats(\/|$)/,
  /(^|\/)renderer(\/|$)/,
  /(^|\/)main(\/|$)/,
  /(^|\/)preload(\/|$)/,
  /(^|\/)notation(\/|$)/,
  /^node:/,
  /^electron$/,
];

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 覆盖 `import x from 'm'`、`import type {...} from 'm'`、`export ... from 'm'`、`import('m')`。 */
function collectSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const statik = /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g;
  const bare = /\bimport\s*['"]([^'"]+)['"]/g;
  const dynamic = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [statik, bare, dynamic]) {
    let m = re.exec(source);
    while (m !== null) {
      if (m[1] !== undefined) specs.push(m[1]);
      m = re.exec(source);
    }
  }
  return specs;
}

describe('domain 架构守卫（方案 §0-2）', () => {
  const files = collectFiles(DOMAIN_DIR);

  it('至少扫到本批新增的 6 个 domain 文件', () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it.each(files)('%s 不 import 任何外层或平台模块', (file) => {
    const specs = collectSpecifiers(readFileSync(file, 'utf8'));
    const bad = specs.filter((spec) => FORBIDDEN.some((re) => re.test(spec)));
    expect(bad).toEqual([]);
  });
});

describe('联合类型可穷尽 narrow', () => {
  // 编译期断言：漏掉任一分支，`never` 赋值即报错。
  function eventKind(event: MusicEvent): string {
    switch (event.kind) {
      case 'note':
        return event.note.pitch.letter;
      case 'rest':
        return event.rest.variant;
      case 'chord':
        return `chord:${String(event.members.length)}`;
      case 'grace':
        return `grace:${String(event.after)}`;
      case 'barline':
        return event.raw;
      case 'decoration':
        return event.decoration.form;
      case 'chordSymbol':
        return event.symbol.raw;
      case 'tabNote':
        return String(event.note.stringIndex);
      case 'tabGroup':
        return `tabGroup:${String(event.members.length)}`;
      case 'unknown':
        return event.tokenKind;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }

  function relationKind(relation: Relation): string {
    switch (relation.kind) {
      case 'tie':
        // status 判别联合：未解析的 tie 没有 `to`，类型层即禁止误访问。
        return relation.status === 'resolved' ? relation.to.eventId : relation.from.eventId;
      case 'slur':
        return relation.from;
      case 'tuplet':
        return `${String(relation.p)}:${relation.status}`;
      case 'slide':
      case 'hammer':
      case 'pull':
        return relation.from.eventId;
      default: {
        const exhaustive: never = relation;
        return exhaustive;
      }
    }
  }

  it('MusicEvent 与 Relation 的 switch 覆盖全部分支', () => {
    expect(
      eventKind({
        id: eventId(voiceId(1), 0),
        origin: 'p',
        kind: 'unknown',
        raw: '2',
        tokenKind: 'duration',
      }),
    ).toBe('duration');
    expect(
      relationKind({
        id: relationId(voiceId(1), 'slur', 0),
        origins: [],
        kind: 'slur',
        status: 'unclosed',
        from: eventId(voiceId(1), 0),
      }),
    ).toBe('v1:e0');
  });
});

describe('isKnownVoiceStyle', () => {
  it('三个已知值为真', () => {
    expect(isKnownVoiceStyle('staff')).toBe(true);
    expect(isKnownVoiceStyle('jianpu')).toBe(true);
    expect(isKnownVoiceStyle('tab')).toBe(true);
  });

  it('未知值 / undefined / 大小写变体为假', () => {
    expect(isKnownVoiceStyle(undefined)).toBe(false);
    expect(isKnownVoiceStyle('')).toBe(false);
    expect(isKnownVoiceStyle('Staff')).toBe(false);
    expect(isKnownVoiceStyle('drum')).toBe(false);
  });
});
