# 导出设备与 Windows GPU 路由（Optimus / 混合显卡 / 虚拟显示适配器）

## 背景

应用处于 NVIDIA Optimus / 混合显卡笔记本时，Windows 决定每个进程用哪块 GPU。
远程场景（GameViewer/UU 远程等驱动级虚拟显示适配器）会进一步干扰 Chromium 的 GPU 进程：
它倾向于选择"能向当前显示器呈现"的适配器，而远程时唯一显示器是虚拟适配器 →
WebCodecs 的硬件编解码（D3D11 VideoEncode/Decode 绑定所选适配器）可能不可用；
ffmpeg 是独立进程、直连 CUDA/NVENC，不受此影响，因此导出会自动落到 ffmpeg 路径。

## 应用写入的注册表（与「设置 → 系统 → 屏幕 → 显卡」手动指定一致）

```
HKCU\Software\Microsoft\DirectX\UserGpuPreferences
  值名：<应用 exe 名>        （dev=electron.exe，打包后=产品 exe 名）
  值： "GpuPreference=<n>;"
```

| 首选项「导出设备」 | GpuPreference | 含义 |
|---|---|---|
| 独立显卡 | `2` | 高性能（强制独显） |
| 核显 / 集成显卡 | `1` | 节能（核显） |
| 自动 / 纯软件 | 删除该值 | 交还系统决定 |

写入时机：首选项保存时 + 每次应用启动时（保证注册表与 `userData/preferences.json` 一致）。
**该值在进程启动时被 DXGI/Chromium 读取，修改后必须重启应用才生效。**

## ⚠ 卸载清理（重要）

卸载/移除应用时**必须删除上述注册表值**，否则系统会一直试图把该 exe 钉在指定 GPU 上。

手动清理命令：

```powershell
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\DirectX\UserGpuPreferences' `
  -Name 'AudioVizNext.exe' -ErrorAction SilentlyContinue
# dev 环境如有残留再删 electron.exe 同名值
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\DirectX\UserGpuPreferences' `
  -Name 'electron.exe' -ErrorAction SilentlyContinue
```

**TODO（做安装包时）**：electron-builder/NSIS 卸载器脚本中必须加入上述删除逻辑
（`nsis` 的 `deleteRegValue` 或卸载前 `powershell` 回调），
否则会出现"卸载后系统仍残留 GPU 绑定"的遗留问题。

## 厂商白名单

枚举 GPU（`src/main/deviceProbe.ts`）按 PNP `VEN_` 码白名单过滤：
NVIDIA `10DE` / Intel `8086` / AMD `1002|1022`；
其余（GameViewer Virtual Display Adapter、Microsoft 基础渲染等）视为虚拟适配器忽略，
用于首选项设备列表与诊断日志，不做任何 GPU 决策。
