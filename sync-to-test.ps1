# Mirrors this project to C:\Youbefy for loading in Chrome.
#
# Chrome fails silently when loading an unpacked extension from a path with
# accented characters, and this project lives under "sarú\programação". So the
# copy Chrome actually loads lives at an ASCII-only path; run this after every
# edit, then hit Reload on chrome://extensions.

$src = $PSScriptRoot
$dst = "C:\Youbefy"

robocopy $src $dst /MIR /XD .git /XF sync-to-test.ps1 /NFL /NDL /NJH /NJS /NP | Out-Null

if ($LASTEXITCODE -lt 8) {
  Write-Host "Synced $src -> $dst"
  Write-Host "Now press Reload on the Youbefy card at chrome://extensions/"
} else {
  Write-Host "robocopy failed with code $LASTEXITCODE"
  exit 1
}
