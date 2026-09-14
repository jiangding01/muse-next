/**
 * JCX Lexer —— 行级词表（M1.4 方案 §7 T4，docs/JCX_SPEC.md §8 / §10）。
 *
 * 从 `lexLineKinds.ts` 拆出（T7 批次 C，纯移动、不改行为）：这两张白名单合计
 * 80 余条常量，与词法规则无关，单独成文件后规则文件才读得下去。
 */

/**
 * §8 登记的 information field 字母（10 个）。
 *
 * 取自 docs/JCX_SPEC.md §8.1–§8.10。不在此表中的单字母字段按 §29.1 处理：
 * 仍然按字段行分类并完整保留，但发 `jcx.field.unknown` warning。
 */
export const KNOWN_FIELD_KEYS: readonly string[] = [
  'X',
  'T',
  'C',
  'M',
  'L',
  'Q',
  'K',
  'I',
  'V',
  'w',
];

/** §10.1–§10.6：语料中实际出现的 6 个指令。 */
const CORPUS_DIRECTIVE_NAMES: readonly string[] = [
  'gchord',
  'showfinger',
  'begintext',
  'endtext',
  'skip',
  'indent',
];

/**
 * §10.7：help 记载但语料未出现的 DOCUMENTATION-ONLY 指令清单（67 个）。
 *
 * 按 §29.2「§10.7 清单中的指令……不发 diagnostic」的要求，它们与 §10.1–§10.6
 * 一起构成「已知指令名」集合；只有集合外的名字才发 `jcx.directive.unknown`。
 */
const DOC_ONLY_DIRECTIVE_NAMES: readonly string[] = [
  // 和弦图 / 吉他类（10）
  'showstroke',
  'showpattern',
  'showcheck',
  'showname',
  'chordgridwidth',
  'chordgridheight',
  'gchordspace',
  'tabstemheight',
  'tabstringsep',
  'tab_btextspace',
  // 字体类（12）
  'composerfont',
  'titlefont',
  'subtitlefont',
  'vocalfont',
  'voicefont',
  'textfont',
  'jianpufont',
  'tabfont',
  'gchordfont',
  'barnumberfont',
  'barlabelfont',
  'tempofont',
  // 页面 / 排版类（19）
  'pageheight',
  'pagewidth',
  'leftmargin',
  'topmargin',
  'botmargin',
  'staffwidth',
  'scale',
  'systemsep',
  'sysstaffsep',
  'strictness1',
  'barsperstaff',
  'barnumbers',
  'composerspace',
  'continueall',
  'titlespace',
  'titleleft',
  'subtitlespace',
  'vocalspace',
  'textspace',
  // V2.70 简谱排版参数（22）
  'jpbeamspace',
  'jpbeamthickness',
  'jpbeamnotespace',
  'jpoctavedotspace',
  'jpoctavedotsize',
  'jprhythmdotsize',
  'jprhythmdotspace',
  'jprhythmdotxshift',
  'jprhythmdotyshift',
  'jpbarlength',
  'jpbaryshift',
  'jphighoctavenotespace',
  'jplowoctavenotespace',
  'jplowoctavebeamspace',
  'jpextendthickness',
  'jpgracescale',
  'jpgraceyshift',
  'jpaccscale',
  'jpkeysigxshift',
  'jpkeysigyshift',
  'jpkeysigwidth',
  'jpwedgeyshift',
  // 五线谱 / 页面开关（4）
  'staffwedgeyshift',
  'staffwedgespread',
  'showkeymeter',
  'showpagenumber',
];

/** §10 + §10.7：已知指令名全集（73 个），集合外的名字发 `jcx.directive.unknown`。 */
export const KNOWN_DIRECTIVE_NAMES: readonly string[] = [
  ...CORPUS_DIRECTIVE_NAMES,
  ...DOC_ONLY_DIRECTIVE_NAMES,
];
