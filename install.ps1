# 云图记忆插件 · 一键安装（2026-11-06）
#
# 原则：**能不碰就不碰，碰之前先备份，改完先验，验不过就回滚。**
#
#   1. 找到 DSH 的 profile 目录（~/.dsh/profiles/*）
#   2. 把插件拷进 <profile>/node_modules/dsh-plugin-neural-cloud（不跑 pnpm）
#   3. package.json：加 dependencies + dsh.profile.bundles（已存在就跳过）
#   4. cordis.patch.yml：追加一段 id=neural-cloud（已存在就跳过）
#   5. 每一步写前备份，写后校验 JSON；校验失败立刻还原
#   6. 最后检查 Java 17 与引擎，给出结论

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginName = 'dsh-plugin-neural-cloud'

function Write-Step($msg) { Write-Host "  → $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  × $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "云图记忆插件 · 一键安装" -ForegroundColor Magenta
Write-Host "================================================"

# ---------- 1. 找 profile ----------
$profilesRoot = Join-Path $env:USERPROFILE '.dsh\profiles'
if (-not (Test-Path $profilesRoot)) {
    Write-Err "没找到 DSH 的 profiles 目录：$profilesRoot"
    Write-Host "      先确认 DSH 桌面版装过、并且启动过一次。" -ForegroundColor Gray
    exit 1
}

$candidates = Get-ChildItem $profilesRoot -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName 'package.json') }

if (-not $candidates) {
    Write-Err "profiles 下没有可用目录（没有 package.json）"
    exit 1
}

$profile = $null
if ($candidates.Count -eq 1) {
    $profile = $candidates[0]
} else {
    Write-Host "  发现多个 profile："
    for ($i = 0; $i -lt $candidates.Count; $i++) {
        Write-Host ("    [{0}] {1}" -f ($i + 1), $candidates[$i].Name)
    }
    $pick = Read-Host "  选哪个（默认 1）"
    if ([string]::IsNullOrWhiteSpace($pick)) { $pick = '1' }
    $idx = [int]$pick - 1
    if ($idx -lt 0 -or $idx -ge $candidates.Count) { $idx = 0 }
    $profile = $candidates[$idx]
}
Write-Ok "profile：$($profile.FullName)"

$pkgPath   = Join-Path $profile.FullName 'package.json'
$patchPath = Join-Path $profile.FullName 'cordis.patch.yml'
$nmPath    = Join-Path $profile.FullName 'node_modules'
$stamp     = Get-Date -Format 'yyyyMMdd_HHmmss'

# ---------- 2. 拷贝插件 ----------
Write-Step "拷贝插件到 node_modules"
$target = Join-Path $nmPath $pluginName
if (Test-Path $target) {
    $bak = "$target.bak-$stamp"
    Move-Item $target $bak
    Write-Warn "已存在旧版本，改名为 $(Split-Path -Leaf $bak)"
}
New-Item -ItemType Directory -Force -Path $target | Out-Null
robocopy $here $target /E /XD node_modules /XF *.bak* *.keep* 一键安装.bat install.ps1 | Out-Null
if ($LASTEXITCODE -ge 8) {
    Write-Err "拷贝失败（robocopy 退出码 $LASTEXITCODE）"
    exit 1
}
Write-Ok "已拷贝：$target"

# ---------- 3. package.json ----------
Write-Step "登记 package.json"
Copy-Item $pkgPath "$pkgPath.bak-$stamp" -Force
Write-Ok "已备份 package.json.bak-$stamp"

try {
    $raw = Get-Content $pkgPath -Raw -Encoding UTF8
    $json = $raw | ConvertFrom-Json

    if (-not $json.dependencies) {
        $json | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    $linkValue = 'link:' + $target.Replace('\', '/')
    $hadDep = $false
    if ($json.dependencies.PSObject.Properties.Name -contains $pluginName) {
        $hadDep = $true
        $old = $json.dependencies.$pluginName
        if ($old -eq $linkValue) {
            Write-Warn "dependencies 里已指向本目录，跳过"
        } else {
            Write-Warn "dependencies 原来指向 $old"
            Write-Ok   "改为本地 link（旧值已备份在 package.json.bak-$stamp）"
        }
    } else {
        $json.dependencies | Add-Member -NotePropertyName $pluginName -NotePropertyValue $linkValue -Force
        Write-Ok "dependencies += $pluginName"
    }
    if ($hadDep) {
        $json.dependencies | Add-Member -NotePropertyName $pluginName -NotePropertyValue $linkValue -Force
    }

    if (-not $json.dsh) {
        $json | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    if (-not $json.dsh.profile) {
        $json.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    if (-not $json.dsh.profile.bundles) {
        $json.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() -Force
    }
    $bundles = @($json.dsh.profile.bundles)
    if ($bundles -contains $pluginName) {
        Write-Warn "bundles 里已有 $pluginName，跳过"
    } else {
        $bundles += $pluginName
        $json.dsh.profile.bundles = $bundles
        Write-Ok "bundles += $pluginName"
    }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
        # 用 node 改，保持原有缩进风格（2 空格），不要 PS 那种重排
        $env:PKG_PATH = $pkgPath
        $env:PKG_NAME = $pluginName
        $env:PKG_LINK = $linkValue
        $nodeJs = @'
const fs = require('fs')
const p = process.env.PKG_PATH
const name = process.env.PKG_NAME
const link = process.env.PKG_LINK
let raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
const j = JSON.parse(raw)
j.dependencies = { ...(j.dependencies || {}), [name]: link }
j.dsh = j.dsh || {}
j.dsh.profile = j.dsh.profile || {}
const b = Array.isArray(j.dsh.profile.bundles) ? j.dsh.profile.bundles : []
if (!b.includes(name)) b.push(name)
j.dsh.profile.bundles = b
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf8')
'@
        Set-Content -Path (Join-Path $env:TEMP 'dsh-mem-patch.cjs') -Value $nodeJs -Encoding UTF8
        & $node.Source (Join-Path $env:TEMP 'dsh-mem-patch.cjs')
        $nodeExit = $LASTEXITCODE
        Remove-Item (Join-Path $env:TEMP 'dsh-mem-patch.cjs') -Force -ErrorAction SilentlyContinue
        if ($nodeExit -ne 0) { throw "node 改 package.json 失败（退出码 $nodeExit）" }
    } else {
        $out = $json | ConvertTo-Json -Depth 32
        Set-Content -Path $pkgPath -Value $out -Encoding UTF8
    }

    # 校验
    $check = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $check.dependencies.$pluginName) { throw '校验失败：dependencies 没写进去' }
    if (-not ($check.dsh.profile.bundles -contains $pluginName)) { throw '校验失败：bundles 没写进去' }
    Write-Ok "package.json 校验通过"
} catch {
    Copy-Item "$pkgPath.bak-$stamp" $pkgPath -Force
    Write-Err "package.json 处理失败，已还原：$($_.Exception.Message)"
    exit 1
}

# ---------- 4. cordis.patch.yml ----------
Write-Step "登记 cordis.patch.yml"
$patchText = @"
# 云图记忆插件（2026-11-06 一键安装）
- id: neural-cloud
  name: $pluginName
  config:
    injectLimit: 6
    defaultLimit: 8
"@

if (Test-Path $patchPath) {
    Copy-Item $patchPath "$patchPath.bak-$stamp" -Force
    Write-Ok "已备份 cordis.patch.yml.bak-$stamp"
    $content = Get-Content $patchPath -Raw -Encoding UTF8
    if ($content -match '(?m)^\s*-\s*id:\s*neural-cloud\s*$') {
        Write-Warn "patch 里已有 neural-cloud 段，跳过"
    } else {
        Add-Content -Path $patchPath -Value $patchText -Encoding UTF8
        Write-Ok "已追加 patch 段"
    }
} else {
    Set-Content -Path $patchPath -Value $patchText -Encoding UTF8
    Write-Ok "已新建 cordis.patch.yml"
}

# ---------- 5. Java 与引擎 ----------
Write-Step "检查 Java 17 与引擎"
$java = $null
foreach ($p in @(
    $env:MEMORY_JAVA,
    $(if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin\java.exe' }),
    'D:\jdk17\bin\java.exe',
    'C:\Program Files\Java\jdk-17\bin\java.exe',
    'C:\Program Files\Eclipse Adoptium\jdk-17\bin\java.exe'
)) {
    if ($p -and (Test-Path $p)) { $java = $p; break }
}
if (-not $java) {
    $cmd = Get-Command java -ErrorAction SilentlyContinue
    if ($cmd) { $java = $cmd.Source }
}

if (-not $java) {
    Write-Warn "没找到 Java。插件仍能加载，但记忆会回退到云图自带实现。"
    Write-Host "      装一个 JDK 17：https://adoptium.net/" -ForegroundColor Gray
} else {
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $ver = ''
    try {
        $ver = (cmd /c ""$java" -version 2>&1" | Select-Object -First 1) -join ''
    } catch {
        $ver = ''
    }
    $ErrorActionPreference = $prevEap
    Write-Ok "java：$java（$ver）"
    if ($ver -notmatch '"(1[7-9]|[2-9][0-9])') {
        Write-Warn "这个 Java 低于 17，引擎可能起不来；装了 17 会自动优先用 17。"
    }
}

$engineLib = Join-Path $target 'engine\lib'
if (Test-Path $engineLib) {
    $n = (Get-ChildItem $engineLib -Filter *.jar | Measure-Object).Count
    Write-Ok "引擎随包：$n 个 jar"
} else {
    Write-Warn "包里没有 engine/lib —— 只会用云图自带实现。"
}

# ---------- 6. 结论 ----------
Write-Host ""
Write-Host "================================================"
Write-Ok "安装完成"
Write-Host ""
Write-Host "  接下来" -ForegroundColor Magenta
Write-Host "    1) 完全退出 DSH（不是关窗口，要退进程）"
Write-Host "    2) 重新打开 DSH"
Write-Host "    3) 看 ~/.dsh/storages/neural-cloud/inject.log 有没有 [engine] 启动成功"
Write-Host ""
Write-Host "  要卸载" -ForegroundColor Magenta
Write-Host "    - 删掉 <profile>\node_modules\$pluginName"
Write-Host "    - package.json / cordis.patch.yml 用同目录的 .bak-$stamp 还原"
Write-Host ""
