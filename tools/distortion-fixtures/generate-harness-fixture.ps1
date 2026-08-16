# Builds tools/distortion-fixtures/harness.cpp with the Visual Studio C++ compiler and runs it over cases.json,
# writing the fixture the GUI's distortion evaluator spec compares against. Run it after changing the driver's
# distortion code (RadialBezierDistortionProfile.cpp, FovVisualization.cpp, the profile setup in BaseHeadset.cpp
# or DistortionProfileConstructor.cpp) or the cases.
#
#   .\generate-harness-fixture.ps1 [-InfoJson <path to a driver info.json>] [-Out <fixture path>]
#
# The info.json provides the built-in profile definitions the cases refer to by name; the default is the one the
# installed driver writes. Use an info.json from the driver build under test.
param(
    [string]$InfoJson = "$env:APPDATA\CustomHeadset\info.json",
    [string]$Out = "",
    [string]$VsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here '..\..')
if (-not $Out) {
    $Out = Join-Path $repo 'CustomHeadsetGUI\src\app\utilities\distortion\fixtures\driver-harness-cases.json'
}
if (-not (Test-Path $InfoJson)) {
    throw "info.json not found at $InfoJson, pass -InfoJson"
}

$vsPath = & $VsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) {
    throw 'no Visual Studio installation with the C++ toolset found'
}
$vcvars = Join-Path $vsPath 'VC\Auxiliary\Build\vcvars64.bat'
$build = Join-Path $here 'build'
New-Item -ItemType Directory -Force $build | Out-Null

$compile = "`"$vcvars`" >nul 2>&1 && cl /nologo /std:c++17 /EHsc /O2 /D_CRT_SECURE_NO_WARNINGS /D_SILENCE_ALL_CXX17_DEPRECATION_WARNINGS " +
    "/I `"$repo\ThirdParty\openvr\headers`" /I `"$repo\ThirdParty\json\include`" /Fo:`"$build\\`" /Fe:`"$build\harness.exe`" `"$here\harness.cpp`""
cmd /c $compile
if ($LASTEXITCODE -ne 0) {
    throw "compiling the harness failed"
}
& "$build\harness.exe" (Join-Path $here 'cases.json') $InfoJson $Out
if ($LASTEXITCODE -ne 0) {
    throw "running the harness failed"
}
Write-Host "fixture written to $Out, now run 'npx ng test --watch=false --browsers=ChromeHeadless --include=src/app/utilities/distortion/**/*.spec.ts' in CustomHeadsetGUI"
