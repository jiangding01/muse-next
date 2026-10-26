/**
 * 源码编辑的平台门控（M3 T3c；实施 Gate 附录 v2 §4，用户裁决 Q9-A；纯逻辑）。
 *
 * - 平台提示由适配层在启动时读取一次（`navigator.userAgentData.platform`，回退 `navigator.platform`）交给本模块；本模块不读任何平台全局。
 * - 开关表冻结：只对 macOS 开放源码编辑；Windows / Linux 在各自 G4 实机验收通过之前保持只读；无法识别 → `unknown` → 只读（fail closed）。
 * - 门控不是安全边界，只防止在未验收的平台上开放编辑；解除某个平台的门控须经用户裁决，并同步修改架构守卫中的开关表断言。
 */

export type EditingPlatform = 'macos' | 'windows' | 'linux' | 'unknown';

export const SOURCE_EDITING_ENABLED: Readonly<Record<EditingPlatform, boolean>> = Object.freeze({ macos: true, windows: false, linux: false, unknown: false });

/**
 * 平台提示 → 平台。UA-CH 取值为 `macOS` / `Windows` / `Linux` / `Chrome OS` / `Android` / `iOS` 等；`navigator.platform` 取值为
 * `MacIntel` / `Win32` / `Linux x86_64` 等。其它一律 `unknown`。
 */
export function sourceEditingPlatform(hint: string | null | undefined): EditingPlatform {
  const value = (hint ?? '').trim().toLowerCase();
  if (value === 'macos' || value.startsWith('macintel') || value.startsWith('macppc')) return 'macos';
  if (value === 'windows' || value.startsWith('win32') || value.startsWith('win64')) return 'windows';
  if (value === 'linux' || value.startsWith('linux ')) return 'linux';
  return 'unknown';
}

export function sourceEditingEnabledOn(platform: EditingPlatform): boolean {
  return SOURCE_EDITING_ENABLED[platform];
}
