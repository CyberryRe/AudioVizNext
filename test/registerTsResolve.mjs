// 注册 ESM 解析钩子（见 test/tsResolve.mjs）：让测试能 import 省略扩展名的应用源码。
// 用法：node --experimental-strip-types --import ./test/registerTsResolve.mjs test/xxx.test.mjs
import { register } from 'node:module'

register('./tsResolve.mjs', import.meta.url)
