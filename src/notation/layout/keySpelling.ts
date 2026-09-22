/**
 * notation/layout —— `K:` 的**规范拼写**与「raw 里是否还有别的文本」（M2 T7.2）。
 *
 * 背景：`KeySignature` 是「事实 + 派生」的混合体——`raw` 是作者原样写下的整行值
 * （可能是 `Eb`，也可能是 `Eb major`、`G % 1 sharps`、`C clef=bass`），`tonic`/`alter`
 * 只是从 `raw` 开头**尽力**读出的音名与升降记号（`src/formats/jcx/parse/keyMeter.ts`
 * 的 `parseKey`：读不出时两者一起缺省，`alter === 0` 表示「读到了音名且其后没有升降
 * 记号」，**不是**「未解析」）。
 *
 * 五线谱要画调号，必须回答一个比「转述文本」更强的问题：**`raw` 里除了音名与升降
 * 记号之外，还有没有我们没解释的东西**。有（mode 文本、`clef=`、行内 `%` 注释……）就
 * 不画调号——画出来等于替作者断言「`Eb major` 的调号就是 `Eb` 的调号」，而 mode 与调号
 * 的映射在 spec §8.7 里是 `DOC-ONLY`（明确不解析 mode / clef）。
 *
 * 本文件因此只导出两个**纯字符串层面**的判断（无几何、无记谱法知识）。放在 `layout/`
 * 而不是 `staff/`：简谱头部标签（`scoreHeader.ts` 的 `keyText`）判断「raw 是否就是
 * tonic」用的是同一问题的**更弱版本**（没把 `alter` 算进来，`K:Eb` 会被判成「含未识别
 * 的调式文本」）。T7.4 把 `scoreHeader.ts` 切到本文件，本任务不动它。
 */

import type { KeySignature } from '../../domain';

/**
 * `alter` → 升降记号的文本形式。这里的 `#` / `b` 是**作者在 `K:` 里写下的 JCX 字符**
 * （用于与 `raw` 逐字比较），不是任何渲染器的升降号编码。
 *
 * **只接受 `-1` / `0` / `undefined` / `+1`**：这四个值覆盖 `parseKey` 的全部产出形态
 * （`#` → 1、`b` → −1、无记号 → 0、整体未解析 → 缺省）。其它取值（重升重降 `±2`、或
 * 将来某次改动引入的新编码）返回 `undefined` 表示「本层不认识这个 alter」——**绝不
 * 静默当成自然音**：把 `alter: -2` 当 `0` 会画出高两个半音的调号，属于编造。
 */
function accidentalFromAlter(alter: number | undefined): string | undefined {
  if (alter === undefined || alter === 0) return '';
  if (alter === 1) return '#';
  if (alter === -1) return 'b';
  return undefined;
}

/**
 * `tonic + 升降记号` 的规范拼写（如 `E` + `b` → `Eb`）。
 *
 * `tonic` 缺失（`parseKey` 整体没读出音名）或 `alter` 不是本层认识的取值时返回
 * `undefined`：没有规范拼写可言，调用方据此一律走「不画调号」。
 */
export function canonicalKeySpelling(key: KeySignature): string | undefined {
  if (key.tonic === undefined) return undefined;
  const accidental = accidentalFromAlter(key.alter);
  return accidental === undefined ? undefined : key.tonic + accidental;
}

/**
 * `raw` 里是否还有规范拼写之外的文本（mode、`clef=`、行内 `%` 注释……）。
 *
 * 规范拼写不存在时**返回 `true`**：「拼不出规范形式」与「拼得出但 raw 更长」对调用方
 * 是同一结论（不画调号）。只 `trim()`，不做大小写归一、不折叠内部空白。
 */
export function keyHasExtraText(key: KeySignature): boolean {
  const canonical = canonicalKeySpelling(key);
  return canonical === undefined || key.raw.trim() !== canonical;
}
