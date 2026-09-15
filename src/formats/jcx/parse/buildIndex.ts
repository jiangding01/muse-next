/**
 * Parse 层 —— `DomainIndex` 构建（M1.6 方案 v1.1 §1.6）。
 *
 * 纯函数：只读 `Score`，不改任何对象，不发 diagnostic。
 * 现在遍历的是空结构；T4–T8 往 Score 里填 voice / event / relation 后自动生效。
 */

import type {
  DomainIndex,
  EventId,
  MusicEvent,
  NoteRef,
  Relation,
  RelationId,
  Score,
  SourceRef,
  Voice,
  VoiceId,
} from '../../../domain';
import { noteRefKey } from '../../../domain';

function relationNoteKeys(relation: Relation): readonly string[] {
  switch (relation.kind) {
    case 'slide':
    case 'hammer':
    case 'pull':
      return [noteRefKey(relation.from), noteRefKey(relation.to)];
    // 未解析 / 未闭合的关系只落它确实存在的那一端，不为缺失的对端造 key。
    case 'tie':
      return relation.status === 'resolved'
        ? [noteRefKey(relation.from), noteRefKey(relation.to)]
        : [noteRefKey(relation.from)];
    case 'slur': {
      const ends: NoteRef[] =
        relation.status === 'closed'
          ? [{ eventId: relation.from }, { eventId: relation.to }]
          : [{ eventId: relation.from }];
      return ends.map(noteRefKey);
    }
    case 'tuplet':
      return relation.members.map((eventId) => noteRefKey({ eventId }));
  }
}

function allRelations(voice: Voice): readonly Relation[] {
  return [...voice.ties, ...voice.slurs, ...voice.tuplets, ...voice.tabRelations];
}

function pushNoteKey(
  map: Map<string, RelationId[]>,
  key: string,
  id: RelationId,
): void {
  const bucket = map.get(key);
  if (bucket === undefined) {
    map.set(key, [id]);
    return;
  }
  if (!bucket.includes(id)) {
    bucket.push(id);
  }
}

/**
 * 从 `Score` 构建五张反查表。
 *
 * `byPath` 的取舍：同一 path 理论上只对应一个 Domain 对象；万一重复（例如 T4 之后
 * 同 id `V:` 合并导致 origins 交叠），**先写者赢**并保留——parse 层不在这里报错，
 * 重复本身由产出方的规则负责。
 */
export function buildDomainIndex(score: Score): DomainIndex {
  const byPath = new Map<SourceRef, EventId | VoiceId | RelationId>();
  const eventById = new Map<EventId, { readonly voiceId: VoiceId; readonly event: MusicEvent }>();
  const relationById = new Map<RelationId, Relation>();
  const relationsByNote = new Map<string, RelationId[]>();
  const voiceById = new Map<VoiceId, Voice>();

  const claimPath = (path: SourceRef, id: EventId | VoiceId | RelationId): void => {
    if (!byPath.has(path)) {
      byPath.set(path, id);
    }
  };

  for (const voice of score.voices) {
    voiceById.set(voice.id, voice);
    for (const origin of voice.origins) {
      claimPath(origin, voice.id);
    }

    for (const event of voice.events) {
      eventById.set(event.id, { voiceId: voice.id, event });
      claimPath(event.origin, event.id);
    }

    for (const relation of allRelations(voice)) {
      relationById.set(relation.id, relation);
      for (const origin of relation.origins) {
        claimPath(origin, relation.id);
      }
      for (const key of relationNoteKeys(relation)) {
        pushNoteKey(relationsByNote, key, relation.id);
      }
    }
  }

  return { byPath, eventById, relationById, relationsByNote, voiceById };
}
