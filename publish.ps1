# Publish dsh-workspace-memory to npm.
#
# This machine has no `npm` on PATH — only the Node and pnpm that ship inside
# DeepSeek Harness — so the script drives pnpm directly with absolute paths.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File D:\dsh-plugin\dsh-workspace-memory\publish.ps1
#   powershell -ExecutionPolicy Bypass -File ...\publish.ps1 -Otp 123456
#
# Accounts with two-factor authentication need either `-Otp <6-digit code>` or a
# token created with "Bypass two-factor authentication" enabled (see PUBLISHING.md).

param(
  [string]$Otp
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$node = 'C:\Users\TJ_ZYS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm = 'C:\Users\TJ_ZYS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'

if (-not (Test-Path $node)) { throw "Node not found at $node" }
if (-not (Test-Path $pnpm)) { throw "pnpm not found at $pnpm" }

$package = Get-Content package.json -Raw | ConvertFrom-Json
Write-Host "Package : $($package.name)@$($package.version)"
Write-Host "Registry: $($package.publishConfig.registry)"

# npm uploads a snapshot of this directory, not a pointer to GitHub. Publish only
# from a clean tree whose HEAD carries the matching tag, so the two stay aligned.
if (Get-Command git -ErrorAction SilentlyContinue) {
  $dirty = & git status --porcelain 2>$null
  if ($LASTEXITCODE -eq 0) {
    if ($dirty) {
      throw 'Working tree has uncommitted changes. Commit them first, or npm would ship code that GitHub does not have.'
    }
    $tag = "v$($package.version)"
    & git rev-parse -q --verify "refs/tags/$tag" > $null 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "Tag $tag does not exist. Create it (git tag $tag) so the npm snapshot matches a GitHub tag."
    }
    $head = (& git rev-parse HEAD).Trim()
    $tagged = (& git rev-parse "$tag^{commit}").Trim()
    if ($head -ne $tagged) {
      Write-Host "Git     : tag $tag points at $($tagged.Substring(0,7)), HEAD is $($head.Substring(0,7))" -ForegroundColor Yellow
      Write-Host '          npm will ship the working tree, which is newer than the tag.' -ForegroundColor Yellow
    } else {
      Write-Host "Git     : clean tree at tag $tag"
    }
  }
} else {
  Write-Host 'Git     : not available, skipping the sync check' -ForegroundColor Yellow
}

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
$publishArgs = @('publish', '--access', 'public', '--no-git-checks')
if ($Otp) { $publishArgs += @('--otp', $Otp) }
& $node $pnpm @publishArgs
$code = $LASTEXITCODE

if ($code -ne 0) {
  Write-Host ''
  Write-Host 'Publish failed.' -ForegroundColor Yellow
  Write-Host 'If the error mentions "Two-factor authentication", npm wants a one-time code:' -ForegroundColor Yellow
  Write-Host '  rerun with a fresh 6-digit code from your authenticator:  -Otp 123456'
  Write-Host 'Long-lived tokens that bypass 2FA are being deprecated by npm, so prefer -Otp.'
  throw 'Publish failed.'
}

Write-Host "`nDone. Verify with:"
Write-Host "  & `"$node`" `"$pnpm`" view $($package.name) version"
