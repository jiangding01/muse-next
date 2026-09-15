/**
 * L2 投影 —— 比较工具（M1.7 T6）。
 *
 * 断言用 `toEqual` 就够了；本文件存在是为了**差异定位**：语料预演（T7 及本地
 * 脚本）不允许把语料内容打印出来（版权边界，方案 §9 第 6 条），所以需要一个
 * 「只报字段路径、不报值」的比较器。`projectionEquals` 则是同一算法的布尔封装，
 * 供不便使用 vitest 断言的调用方（脚本）使用。
 *
 * 前提：投影结果是纯数据且无 `undefined`（见 `./types`），因此这里只需处理
 * 数组 / 普通对象 / 基元三种情形，不必考虑 `Date` / `Map` / 循环引用。
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diffArrays(a: readonly unknown[], b: readonly unknown[], path: string): string | null {
  if (a.length !== b.length) {
    return `${path}.length`;
  }
  for (let i = 0; i < a.length; i += 1) {
    const found = firstProjectionDifference(a[i], b[i], `${path}[${String(i)}]`);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function diffObjects(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  path: string,
): string | null {
  const keys = [...Object.keys(a), ...Object.keys(b).filter((key) => !(key in a))];
  for (const key of keys) {
    if (!(key in a) || !(key in b)) {
      return `${path}.${key}`;
    }
    const found = firstProjectionDifference(a[key], b[key], `${path}.${key}`);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/**
 * 返回第一处差异的字段路径（如 `$.voices[0].events[3].note.durationRaw`），
 * 完全相等时返回 `null`。**只报路径，不报值**。
 */
export function firstProjectionDifference(a: unknown, b: unknown, path = '$'): string | null {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return path;
    }
    return diffArrays(a, b, path);
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) {
      return path;
    }
    return diffObjects(a, b, path);
  }
  return Object.is(a, b) ? null : path;
}

export function projectionEquals(a: unknown, b: unknown): boolean {
  return firstProjectionDifference(a, b) === null;
}
