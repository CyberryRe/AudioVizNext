# 贡献指南 / Contributing

AudioVizNext 以 **AGPL-3.0-or-later** 发布（见 [LICENSE](LICENSE)）。欢迎 Issue 与 PR。

## 提交前

1. `npm run typecheck` 必须过。
2. `npm test` 必须全绿（模型 / 预设包 / 关键帧 / 音频 / 3D 投影 / 预设 drawer / GIF）。
3. 涉及预览或导出几何的改动，请遵循铁律「**导出 = 预览**」：几何只来自 `src/renderer/src/pixi/layout.ts`
   与 `pixi/layer3d.ts`，不要在导出端另写一份。详见 [AGENTS.md](AGENTS.md)（本地维护，不随仓库发布时请忽略）。
4. 改了依赖或许可证相关文件后跑 `npm run licenses` 重新生成 `THIRD-PARTY-NOTICES.md`。

## 提交信息

中文，格式 `<类型>: <简述>`（`feat` / `fix` / `refactor` / `test` / `chore` / `docs`），一条提交只做一件事。

## 贡献者协议（重要）

本项目采用 **AGPL-3.0-or-later + 贡献者授权** 的模式，目的是：① 保证所有贡献都能合法地以 AGPL 分发；
② 保留作者将来调整许可证或提供商业授权的可能（否则一旦合并了外部代码，作者**无权**单方面改许可）。

因此提交 PR 时请：

1. **每个提交都带上 DCO 签署**（`git commit -s`），表示你同意下面的 Developer Certificate of Origin 1.1；
2. 若你的贡献较多（或被要求），请额外同意下面「贡献者授权」一节（等同简版 CLA）。

### Developer Certificate of Origin 1.1

```
By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I have the right to submit it under the
    open source license indicated in the file; or
(b) The contribution is based upon previous work that, to the best of my knowledge, is covered under an
    appropriate open source license and I have the right under that license to submit that work with
    modifications, whether created in whole or in part by me, under the same open source license (unless
    I am permitted to submit under a different license), as indicated in the file; or
(c) The contribution was provided directly to me by some other person who certified (a), (b) or (c) and
    I have not modified it.
(d) I understand and agree that this project and the contribution are public and that a record of the
    contribution (including all personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with this project or the open source
    license(s) involved.
```

### 贡献者授权（简版 CLA，按需签署）

> 提交贡献即表示你向项目作者授予一项**永久的、全球范围的、非排他的、免版税的**许可，
> 允许作者在你的贡献之上行使著作权（包括再许可、调整项目许可证、或随项目一起提供商业授权），
> 同时你保留你自己贡献的著作权。你声明你有权作出该授权，且贡献不侵犯第三方权利。
>
> ⚠️ 这是一份简化的项目内约定，不构成法律意见；若你的贡献涉及雇主权利或第三方代码，请先确认。

## 不要提交的东西

- `bin/`（ffmpeg 可执行文件）、`out/`、`release/`、`reference/`（第三方参考项目）、`.workbuddy/`；
- 任何第三方素材（图片/字体/音乐/GIF）：这些的体积与许可都会污染仓库与安装包。
