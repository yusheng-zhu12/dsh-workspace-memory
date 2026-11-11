# Publish dsh-workspace-memory to npm.
#
# This machine has no `npm` on PATH — only the Node and pnpm that ship inside
# DeepSeek Harness — so the script drives pnpm directly with absolute paths.
#
# Usage (from any directory):
#   powershell -ExecutionPolicy Bypass -File D:\dsh-plugin\dsh-workspace-memory\publish.ps1
#
# The first run opens the npm sign-in page; finish it in the browser and come
# back. Later runs reuse the stored token in %USERPROFILE%\.npmrc.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$node = 'C:\Users\TJ_ZYS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm = 'C:\Users\TJ_ZYS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'

if (-not (Test-Path $node)) { throw "Node not found at $node" }
if (-not (Test-Path $pnpm)) { throw "pnpm not found at $pnpm" }

$package = Get-Content package.json -Raw | ConvertFrom-Json
Write-Host "Package : $($package.name)@$($package.version)"
Write-Host "Registry: $($package.publishConfig.registry)"

Write-Host "`n[1/3] Running the tests"
& $node --test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed; not publishing.' }

Write-Host "`n[2/3] Checking the npm sign-in"
& $node $pnpm whoami | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Not signed in yet. Opening the npm login flow — finish it in your browser.'
  & $node $pnpm login
  if ($LASTEXITCODE -ne 0) { throw 'Login did not complete.' }
}
Write-Host "Signed in as: $(& $node $pnpm whoami)"

Write-Host "`n[3/3] Publishing"
& $node $pnpm publish --access public --no-git-checks
if ($LASTEXITCODE -ne 0) { throw 'Publish failed.' }

Write-Host "`nDone. Verify with:"
Write-Host "  & `"$node`" `"$pnpm`" view $($package.name) version"
