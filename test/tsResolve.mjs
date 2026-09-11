/**
 * tsResolve.mjs —— 测试用 ESM 解析钩子。
 *
 * 应用源码里的相对导入**省略扩展名**（Vite/TS bundler 允许），而 Node ESM 默认要求写全，
 * 于是 `node --experimental-strip-types` 只能测到「叶子模块」。本钩子在解析失败时补试
 * `.ts / .tsx / index.ts / .js`，让单测可以直接 import 应用模块（如预设 drawer）。
 *
 * 用法：node --experimental-strip-types --import ./test/registerTsResolve.mjs test/xxx.test.mjs
 */
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (err) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) throw err
    for (const ext of ['.ts', '.tsx', '/index.ts', '.js']) {
      try {
        return await next(specifier + ext, context)
      } catch {
        /* 继续试下一个后缀 */
      }
    }
    throw err
  }
}
