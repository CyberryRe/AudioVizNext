# AudioVizNext v{{VERSION}}

发布日期：{{DATE}}

> 本说明由 `npm run dist:hash` 依据本模板生成（见 `release/RELEASE-NOTES.md`），
> 发布时直接复制到 GitHub Release 即可。

## 安装

1. 下载下表中的 `AudioVizNext-Setup-{{VERSION}}.exe`，双击安装。
2. 安装向导里可以选择**安装目录**，以及**仅为我 / 为所有用户**安装（后者会请求管理员权限）。
3. ⚠ **本安装包未做代码签名**，Windows SmartScreen 可能提示"Windows 已保护你的电脑 / 未知发布者"：
   点 **更多信息 → 仍要运行** 即可。介意的话可用下面的 SHA-256 校验文件完整性，或从源码自行构建。

## 校验下载完整性（可选）

```powershell
# 把输出的哈希与下表比对
Get-FileHash .\AudioVizNext-Setup-{{VERSION}}.exe -Algorithm SHA256
```

| 文件 | 大小 | SHA-256 |
|---|---|---|
{{ARTIFACTS}}

## 数据目录（可自定义）

预设、视频代理缓存、日志与首选项默认放在 `%APPDATA%\audioviznext`。
应用内 **文件 → 首选项… → 数据目录** 可以改到其它盘/目录（支持"复制/移动/只换目录"三种方式，改完重启生效）；
临时试用也可以用命令行参数：`AudioVizNext.exe --user-data-dir=D:\某目录`。

## 本版内容

<!-- 在这里写本版变更（或贴 git log --oneline 的摘要） -->

-

## 第三方组件与许可

- 本项目以 **AGPL-3.0-or-later** 发布，见 [LICENSE](../LICENSE)；
  对应源码：<https://github.com/CyberryRe/AudioVizNext>
- 随包分发 **FFmpeg/FFprobe（GPLv3，独立进程调用，未链接）** 与 Electron/Chromium；
  完整清单见 [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)，
  安装目录下 `resources/licenses/` 里也有（应用内：首选项 → 关于 → 开源许可）。
- FFmpeg 源码获取方式见 `resources/licenses/FFMPEG-NOTICE.txt`。

## 从源码构建

```powershell
npm install
npm run dev        # 开发
npm run dist       # 出 Windows 安装包（release/）
```
