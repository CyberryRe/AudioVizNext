# 在真实 Chrome(Electron 渲染进程) 里跑一次导出 E2E，采集分阶段耗时与编码器可用性。
# 用法（Windows PowerShell 5.1）：
#   .\test\e2e\run.ps1 -Spec test\e2e\spec-auto.json
param(
  [Parameter(Mandatory = $true)][string]$Spec
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$specPath = Resolve-Path $Spec
# 必须 UTF8：spec 里含中文素材路径，按默认编码读会变乱码 → avn-file 找不到文件
$env:AVS_E2E_SPEC = (Get-Content -Raw -Encoding UTF8 $specPath)
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Push-Location $root
try {
  & node_modules\.bin\electron.cmd . 2>&1
} finally {
  Pop-Location
  Remove-Item Env:\AVS_E2E_SPEC -ErrorAction SilentlyContinue
}
