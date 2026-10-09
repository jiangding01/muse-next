import { describe, expect, expectTypeOf, it } from 'vitest';

import { loadJcx } from '../../../src/formats/jcxParse';
import type { JcxDiagnostic, JcxEncoding, LoadResult } from '../../../src/formats/jcxParse';
import { loadJcx as underlyingLoadJcx } from '../../../src/formats/jcx/loadJcx';
import type { JcxDiagnostic as UnderlyingDiagnostic } from '../../../src/formats/jcx/lexer/diagnostics';
import type { JcxEncoding as UnderlyingEncoding } from '../../../src/formats/jcx/encoding/types';
import type { LoadResult as UnderlyingLoadResult } from '../../../src/formats/jcx/loadJcx';

describe('M3 T0 —— renderer-safe parse façade（§11.1，T0-1 / T0-2）', () => {
  it('façade 的 loadJcx 是底层同一个函数对象（只窄化签名，不含包装逻辑）', () => {
    expect(loadJcx).toBe(underlyingLoadJcx);
  });

  it('字符串输入的结果与底层一致', () => {
    const source = 'X:1\nK:C\nC D E F\n';
    expect(loadJcx(source, { sourceEncoding: 'gb18030' })).toEqual(underlyingLoadJcx(source, { sourceEncoding: 'gb18030' }));
  });

  it('公开签名只接受字符串：Uint8Array 调用在编译期被拒绝', () => {
    expectTypeOf(loadJcx).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(loadJcx).returns.toEqualTypeOf<LoadResult>();
    const neverCalled = (): void => {
      // @ts-expect-error —— 字节解码能力不经 façade 暴露（F14 / R3）
      loadJcx(new Uint8Array([0x41]));
    };
    expect(typeof neverCalled).toBe('function');
  });

  it('导出的类型与定义模块中的类型完全相同', () => {
    expectTypeOf<LoadResult>().toEqualTypeOf<UnderlyingLoadResult>();
    expectTypeOf<JcxDiagnostic>().toEqualTypeOf<UnderlyingDiagnostic>();
    expectTypeOf<JcxEncoding>().toEqualTypeOf<UnderlyingEncoding>();
  });
});
