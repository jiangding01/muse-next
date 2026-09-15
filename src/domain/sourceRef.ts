/**
 * Domain —— 源引用（M1.6 方案 v1.1 §1.1）。
 *
 * Domain 层不认识 `AstPath`：这里只是一个不透明字符串，由 parse 层把 AstPath 的字符串形式写入。
 * 这样 `src/domain/**` 无需 import `formats/`（架构守卫测试保证）。
 */
export type SourceRef = string;
