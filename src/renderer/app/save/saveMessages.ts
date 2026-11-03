/**
 * 保存结果与拒绝提示的穷举文案（M3 T4 B3a-2；B3 r0 §3.8、r0.1 勘误 §5.2，Q-B3-10）。
 *
 * - `SaveMessage` 是保存诊断区（store `save` 字段）的唯一内容；每种提示都有文案，新增种类而未写文案时类型检查失败。
 * - 错误码文案穷举 `SaveErrorCode`：已定的沿用原文，其余按 main 的固定 message 意译；不显示路径，只显示 main 给出的
 *   `displayName`。`not-committed` 的文案一律不承诺「目标绝对未改变」（勘误 §5.2：网络卷上 rename 可能已生效却报错）。
 * - 纯模块：只依赖 shared 类型。
 */

import type { JcxEncoding } from '../../../formats/jcxParse';
import type { SaveErrorCode } from '../../../shared/saveContracts';

export type SaveMessage =
  | { readonly kind: 'saved'; readonly displayName: string }
  | { readonly kind: 'saved-as'; readonly displayName: string }
  /** Q-B3-9：unsafe 文档的 Save As 改用 UTF-8 写出。 */
  | { readonly kind: 'saved-as-utf8'; readonly displayName: string }
  | { readonly kind: 'nothing-to-save' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'ime-timeout' }
  | { readonly kind: 'reject-pending' }
  | { readonly kind: 'changed' }
  | { readonly kind: 'unencodable'; readonly line: number; readonly column: number; readonly encoding: JcxEncoding }
  | { readonly kind: 'save-unconfirmed'; readonly displayName: string }
  | { readonly kind: 'save-as-unconfirmed'; readonly displayName: string }
  | { readonly kind: 'save-as-not-switched'; readonly displayName: string }
  | { readonly kind: 'failed'; readonly code: SaveErrorCode }
  | { readonly kind: 'result-unknown' }
  | { readonly kind: 'result-not-applied' }
  | { readonly kind: 'dialog-failed' };

export type SaveMessageKind = SaveMessage['kind'];

const ERROR_TEXT: Readonly<Record<SaveErrorCode, string>> = {
  'capability-invalid': '文件授权已失效，请使用「另存为」保存。',
  'document-mismatch': '文档与主进程记录的文件不一致，未保存。请使用「另存为」保存。',
  'encoding-mismatch': '保存请求的编码与文档不一致，未保存。',
  'request-timeout': '保存请求超时，未能保存。',
  'unsafe-overwrite-refused': '此文档的原编码无法无损写回，请「另存为」UTF-8。',
  'encoding-verification-failed': '写出的内容无法按原编码无损读回，未能保存。请「另存为」UTF-8。',
  'unencodable-character': '文档中有字符无法用当前编码表示，未能保存。',
  'file-modified-on-disk': '文件已在磁盘上被修改，未保存。',
  'permission-denied': '没有写入该位置的权限，未能保存。',
  'disk-full': '磁盘空间不足，未能保存。',
  'not-found': '找不到原文件，未能保存。请使用「另存为」保存。',
  'target-busy': '目标文件正被占用，未能保存。',
  'same-file-encoding-change-refused': '不能以另一种编码覆盖同一个文件，请另存到其它位置。',
  'file-too-large': '文件过大，未能保存。',
  'not-a-regular-file': '目标不是普通文件，未能保存。',
  busy: '正在进行另一项文件操作，请稍后再试。',
  'identity-unknown': '无法确认目标文件的身份，未保存。',
  'write-failed': '写入失败，未能保存。',
  'atomic-create-unsupported': '此位置不支持安全地新建文件，请另存到其它位置。',
  'source-mismatch': '当前文件与主进程的对应关系尚未确认。请稍后重试；若持续出现，请重新打开该文件后再保存。',
};

const ENCODING_NAME: Readonly<Record<JcxEncoding, string>> = { 'utf-8': 'UTF-8', gb18030: 'GB18030' };

/** 未知错误码（main 版本不一致等）的兜底文案：不承诺目标未改变。 */
const UNKNOWN_ERROR_TEXT = '保存失败，未能保存。';

export function saveErrorText(code: SaveErrorCode): string {
  return (ERROR_TEXT as Readonly<Record<string, string | undefined>>)[code] ?? UNKNOWN_ERROR_TEXT;
}

export function saveMessageText(message: SaveMessage): string {
  switch (message.kind) {
    case 'saved':
      return `已保存 ${message.displayName}。`;
    case 'saved-as':
      return `已另存为 ${message.displayName}，当前文档已切换到该文件。`;
    case 'saved-as-utf8':
      return `已另存为 ${message.displayName}（原编码无法无损写回，已改用 UTF-8），当前文档已切换到该文件。`;
    case 'nothing-to-save':
      return '没有需要保存的修改。';
    case 'busy':
      return '正在进行另一项文件操作，请稍后再试。';
    case 'ime-timeout':
      return '输入法组字尚未结束，未保存。';
    case 'reject-pending':
      return '上一次文件切换的状态尚未与主进程确认，请稍后重试。';
    case 'changed':
      return '保存期间文档已改变，本次保存已取消。';
    case 'unencodable':
      return `第 ${String(message.line)} 行第 ${String(message.column + 1)} 列的字符无法用 ${ENCODING_NAME[message.encoding]} 表示，未保存。`;
    case 'save-unconfirmed':
      return `已写入 ${message.displayName}，但文件授权已失效，后续请使用「另存为」保存。`;
    case 'save-as-unconfirmed':
      return `已写入 ${message.displayName}，但授权已失效，当前文档未切换到该文件。`;
    case 'save-as-not-switched':
      return `内容已写入 ${message.displayName}，但未能切换到该文件。`;
    case 'failed':
      return saveErrorText(message.code);
    case 'result-unknown':
      return '没有得到保存结果：文件可能已写入，也可能没有。文档仍标记为已修改，可以再次保存。';
    case 'result-not-applied':
      return '保存期间当前文档已改变，保存结果没有应用到当前文档。';
    case 'dialog-failed':
      return '无法打开保存对话框，未保存。';
  }
}

/** 是否属于失败 / 被拒（诊断区据此标注）；成功与「没有需要保存的修改」不是失败。 */
export function isSaveFailure(message: SaveMessage): boolean {
  return message.kind !== 'saved' && message.kind !== 'saved-as' && message.kind !== 'saved-as-utf8' && message.kind !== 'nothing-to-save';
}
