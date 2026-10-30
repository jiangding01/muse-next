/**
 * 保存使用的写文件系统 port（`docs/M3_EDITOR_CORE_PLAN.md` §14，M3 T4 B1；Gate B1 C3）。
 *
 * - 本文件只有类型。唯一的 Node 实现是 `nodeWriteFileSystem.ts`——`src/main/**` 中唯一允许调用 Node 写盘 API 的
 *   文件（`architecture.m3t3` G1 与 `architecture.m3t4` W1–W6 钉死）。写盘策略（只读、指纹、sameFile、提交顺序）
 *   全部在 `atomicWrite.ts` / `savePipeline.ts`，经本接口注入，单元测试用内存 fake。
 * - 不扩展 T1a 的只读 port（`fileSystemPort.ts`）：Open 管线在类型层仍然无法写盘。
 * - 以 `Sync` 结尾的方法只供提交前同步临界区（C2）使用：从最后一次复核到 rename / link 返回之间不让出事件循环。
 */

/** 保存关心的 stat 子集（bigint，避免大 ino / size 丢精度）。`mode` 是 `st_mode & 0o7777`。 */
export interface WriteStat {
  isFile(): boolean;
  readonly size: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: number;
  readonly mtimeNs: bigint;
}

/** 以独占方式新建的临时文件句柄。 */
export interface ExclusiveFileHandle {
  /** 把全部字节写入（内部循环直到写完）。 */
  writeAll(bytes: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  chmod(mode: number): Promise<void>;
  stat(): Promise<WriteStat>;
  close(): Promise<void>;
}

export interface WriteFileSystem {
  stat(path: string): Promise<WriteStat>;
  lstat(path: string): Promise<WriteStat>;
  /** POSIX `access(W_OK)`；Windows 上反映只读属性。 */
  isWritable(path: string): Promise<boolean>;
  /** 独占新建（`wx`）：同名已存在即 `EEXIST`，绝不覆盖。 */
  openExclusive(path: string, mode: number): Promise<ExclusiveFileHandle>;
  /** 删除临时文件（未提交路径的清理）。 */
  removeFile(path: string): Promise<void>;
  /** 尽力 fsync 目录（失败由调用方忽略）。 */
  syncDirectory(path: string): Promise<void>;

  openReadSync(path: string): number;
  fstatSync(fd: number): WriteStat;
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  closeSync(fd: number): void;
  statSync(path: string): WriteStat;
  realpathSync(path: string): string;
  /** 已存在目标的提交原语：原子替换目标名（符号链接本身不被替换，调用方传入的是 realpath）。 */
  renameSync(from: string, to: string): void;
  /** 初始不存在目标的提交原语：目标名已存在（任何类型）即 `EEXIST`，绝不覆盖。 */
  linkSync(existing: string, newPath: string): void;
  unlinkSync(path: string): void;
}
