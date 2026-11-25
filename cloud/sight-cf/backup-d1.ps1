<#
.SYNOPSIS
  一键导出 Cloudflare 远端 D1 数据库 `coop-sight` 到本地离线 `.sql` 备份，并按保留天数清理旧档。
.PARAMETER OutDir
  备份输出目录，默认为当前脚本同级 `.backups\`（已在仓库 `.gitignore` 中忽略）。
.PARAMETER KeepDays
  保留最近多少天的备份（按文件最后写入时间清理）；设为 0 表示不自动删旧备份。默认 30。
.PARAMETER DryRun
  仅预览将执行的导出命令、目标文件路径与旧备份清理范围，不连远程、不写入或删除任何文件。
#>
[CmdletBinding()]
param(
  [string]$OutDir = '',
  [int]$KeepDays = 30,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $OutDir = Join-Path $PSScriptRoot '.backups'
}

# 按北京时间（UTC+8）生成带时间戳的备份文件名，避免时区混淆
$tz = [System.TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
$nowCst = [System.TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $tz)
$stamp = $nowCst.ToString('yyyyMMdd-HHmmss')
$outFile = Join-Path $OutDir ("coop-sight-{0}.sql" -f $stamp)

if ($DryRun) {
  Write-Output ("[DryRun] 工作目录 : {0}" -f $PSScriptRoot)
  Write-Output ("[DryRun] 目标目录 : {0}" -f $OutDir)
  Write-Output ("[DryRun] 执行命令 : wrangler d1 export coop-sight --remote --output `"{0}`"" -f $outFile)
  if ($KeepDays -gt 0) {
    $cutoff = (Get-Date).AddDays(-$KeepDays)
    $expired = @()
    if (Test-Path $OutDir) {
      $expired = @(Get-ChildItem -Path $OutDir -Filter 'coop-sight-*.sql' -File | Where-Object { $_.LastWriteTime -lt $cutoff })
    }
    Write-Output ("[DryRun] 轮转策略 : 保留 {0} 天；当前待清理过期备份 {1} 份" -f $KeepDays, $expired.Count)
  } else {
    Write-Output "[DryRun] 轮转策略 : KeepDays=0（跳过清理）"
  }
  exit 0
}

if (-not (Get-Command wrangler -ErrorAction SilentlyContinue)) {
  Write-Error "未找到 wrangler 命令，请确认已全局安装或加入 PATH。"
  exit 1
}

if (-not (Test-Path $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

Push-Location $PSScriptRoot
try {
  & wrangler d1 export coop-sight --remote --output $outFile
  $exitCode = $LASTEXITCODE
} finally {
  Pop-Location
}

if ($exitCode -ne 0) {
  if (Test-Path $outFile) { Remove-Item $outFile -Force -ErrorAction SilentlyContinue }
  Write-Error ("wrangler d1 export 执行失败，退出码: {0}（未清理旧备份）" -f $exitCode)
  exit $exitCode
}

if (-not (Test-Path $outFile)) {
  Write-Error ("导出未生成目标文件: {0}（未清理旧备份）" -f $outFile)
  exit 1
}

$info = Get-Item $outFile
if ($info.Length -le 0) {
  Remove-Item $outFile -Force -ErrorAction SilentlyContinue
  Write-Error "导出的 SQL 文件为空（0 字节），已删除无效文件且未清理旧备份。"
  exit 1
}

if ($KeepDays -gt 0) {
  $cutoff = (Get-Date).AddDays(-$KeepDays)
  Get-ChildItem -Path $OutDir -Filter 'coop-sight-*.sql' -File |
    Where-Object { $_.LastWriteTime -lt $cutoff -and $_.FullName -ne $info.FullName } |
    Remove-Item -Force
}

$kept = @(Get-ChildItem -Path $OutDir -Filter 'coop-sight-*.sql' -File)
$sizeKb = [Math]::Round($info.Length / 1024, 2)
Write-Output ("备份完成: {0} ({1} KB) | 当前保留备份数: {2}" -f $info.FullName, $sizeKb, $kept.Count)
