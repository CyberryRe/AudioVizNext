# AudioVizNext — Git 工作流约定

> 新项目从零重建，吸取旧项目「没有版本管理、牵一发而动全身」的教训。
> 本文件是 Git 使用的**铁律**，新功能必须遵守。

## 分支模型：main + 功能分支（简单主线流）

```
main ──●─────●─────●─────●────── 始终可运行
         \         /
feature  ─●───────●─  每个功能独立分支
```

- **main 永远可跑**：只有能通过 `npm run test`（或当前阶段验收）的改动才合并进 main。
- **每个功能一条分支**：`feature/<name>`，如 `feature/playback-state`、`feature/gpu-renderer`。
- 跑通再合并：分支上完成 + 测试通过 → 合并回 main → 删除分支。

## 提交规范

- **一条提交只做一件事**。不要混入无关改动。
- **提交信息用中文**，格式：`<类型>: <简要描述>`
  - `feat:` 新功能
  - `fix:` 修 bug
  - `refactor:` 重构（不改变行为）
  - `test:` 加/改测试
  - `chore:` 杂项（依赖、构建、配置）
  - `docs:` 文档
- 示例：
  - `feat: 实现播放状态机（PlaybackState reducer）`
  - `fix: 修复拖拽 clip 时长不变的 bug`
  - `test: 为音频分析新增 20 项断言`

## 每次改动的标准流程

1. 从最新的 main 拉分支：`git checkout main && git pull && git checkout -b feature/<name>`
2. 开发，小步提交（每完成一个子功能就 commit 一次）
3. 跑测试确认通过
4. `git checkout main && git merge feature/<name>`（用 `--no-ff` 保留合并记录）
5. 删除已合并的分支：`git branch -d feature/<name>`

## 阶段里程碑

- 每完成一个可独立验证的阶段（如「骨架可启动」「时间轴可拖拽」），在 main 上打 tag：
  `git tag stage-<n>-<name>`（如 `stage-1-skeleton`）
- tag 提供可回溯快照：改坏了能立刻 `git checkout <tag>` 回到任一稳定点。

## 关键原则

- **小步前进，绝不一次铺开**。一个阶段验证通过，再进下一个。
- **宁要慢而稳，不要快而乱**。每一步都能回滚，是这个项目最值钱的资产。
- **不提交机密**：.env 之类已进 .gitignore，绝不把 token/路径硬编码入库。
