$ErrorActionPreference = 'Stop'
# Runs only in the isolated Windows CI runner. Does not target any real game.
$setup = Get-ChildItem -LiteralPath 'dist' -Filter '*-Setup.exe' | Select-Object -First 1
if (-not $setup) { throw 'Setup EXE missing.' }
$installDir = Join-Path (Get-Location) 'test-results\nsis-installed'
$p = Start-Process -FilePath $setup.FullName -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "Setup failed: $($p.ExitCode)" }
$exe = Join-Path $installDir 'Zhuangjizhai-DLSS5-Manager.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw 'Setup did not install to the explicitly requested directory.' }
node scripts/packaged-smoke.cjs "$exe"
if ($LASTEXITCODE -ne 0) { throw 'Installed EXE launch verification failed.' }
$evidence = Get-Content -LiteralPath 'test-results/install-evidence.json' -Raw | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $evidence.sentinel)) { throw 'Recovery-data sentinel missing before uninstall.' }
$uninstaller = Get-ChildItem -LiteralPath $installDir -Filter 'Uninstall*.exe' | Select-Object -First 1
if (-not $uninstaller) { throw 'Per-user uninstaller missing.' }
$u = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -PassThru
if ($u.ExitCode -ne 0) { throw "Uninstaller failed: $($u.ExitCode)" }
for ($i=0; $i -lt 40 -and (Test-Path -LiteralPath $exe); $i++) { Start-Sleep -Milliseconds 250 }
if (Test-Path -LiteralPath $exe) { throw 'Installed EXE remains after uninstall.' }
if (-not (Test-Path -LiteralPath $evidence.sentinel)) { throw 'Uninstaller deleted recovery data.' }
Write-Output 'NSIS verification passed: explicit per-user path, actual packaged launch, clean uninstall, preserved recovery data.'
