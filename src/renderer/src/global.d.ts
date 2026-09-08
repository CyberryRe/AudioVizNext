/**
 * global.d.ts —— 渲染进程全局类型声明。
 *
 * ⚠ 为什么 `window.api` 的类型放在这里而不是 `src/preload/index.d.ts`：
 * TypeScript 对同名 `index.ts` + `index.d.ts` 只取前者（后者被当作前者的编译产物而忽略），
 * 所以放在 preload 目录下**永远不会生效**（此前 tsconfig 的 typecheck 是空跑，问题被掩盖）。
 */
import type { Api } from '../../preload/index'

declare global {
  interface Window {
    api: Api
  }
}

export {}
