# 用 emulator 執行安全規則的行為測試（49 項）
#
# 需要 Java。若系統沒裝，可下載免安裝版 Temurin JRE 並把路徑填進 $JavaHome：
#   https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse
#   解壓後 JAVA_HOME 指向含 bin\java.exe 的那層目錄
#
# 首次執行前先安裝相依套件：
#   npm install --no-save @firebase/rules-unit-testing firebase
#
# 用法： powershell -File tests/run-emulator.ps1

param(
  [string]$JavaHome = $env:JAVA_HOME
)

if (-not $JavaHome -or -not (Test-Path (Join-Path $JavaHome "bin\java.exe"))) {
  # 系統 PATH 裡有 java 就直接用
  if (-not (Get-Command java -ErrorAction SilentlyContinue)) {
    Write-Error "找不到 Java。請安裝 JDK/JRE，或用 -JavaHome 指定免安裝版的路徑。"
    exit 1
  }
} else {
  $env:JAVA_HOME = $JavaHome
  $env:PATH = "$JavaHome\bin;$env:PATH"
}

$env:PATH = "$env:APPDATA\npm;$env:PATH"

Push-Location (Join-Path $PSScriptRoot "..")
try {
  firebase emulators:exec --only firestore,database "node tests/rules.emulator.test.mjs"
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
