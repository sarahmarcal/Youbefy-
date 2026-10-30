# Mirrors this project to C:\Youbefy for loading in Chrome.
#
# Chrome fails silently when loading an unpacked extension from a path with
# accented characters, and this project lives under "sarú\programação". So the
# copy Chrome actually loads lives at an ASCII-only path; run this after every
# edit, then hit Reload on chrome://extensions.

$src = $PSScriptRoot
$dst = "C:\Youbefy"

# The private key stays out of the copy: Chrome warns when an unpacked
# extension contains one, and the manifest's `key` already pins the ID.
robocopy $src $dst /MIR /XD .git /XF sync-to-test.ps1 youbefy-key.pem /NFL /NDL /NJH /NJS /NP | Out-Null
# /MIR leaves excluded files in place, so remove a copy left by older syncs.
Remove-Item (Join-Path $dst "youbefy-key.pem") -Force -ErrorAction SilentlyContinue

if ($LASTEXITCODE -lt 8) {
  Write-Host "Synced $src -> $dst"
  Write-Host "Now press Reload on the Youbefy card at chrome://extensions/"
  exit 0 # robocopy uses 1-7 for success; don't leak them as failures
} else {
  Write-Host "robocopy failed with code $LASTEXITCODE"
  exit 1
}
