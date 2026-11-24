# Packs the working copy (including uncommitted changes) into one archive to upload to the server,
# leaving out dependencies, local data, secrets and exports. Uses the tar built into Windows.
#
#   powershell -File deploy\pack.ps1            -> classone-app.tar.gz in the repo root
#   scp classone-app.tar.gz ubuntu@<server-ip>:~
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'classone-app.tar.gz'
Push-Location $root
try {
  tar -czf $out `
    --exclude=node_modules --exclude=.venv --exclude=.mongo-data --exclude=frontend/dist `
    --exclude=logs --exclude=exports --exclude=Motion_as_kit --exclude=.env --exclude='.env.*' `
    --exclude=__pycache__ --exclude=classone-app.tar.gz --exclude='*.ndjson.gz' --exclude=.git `
    --exclude='*.pptx' --exclude='AI_Sales_Automation_Notion.md' `
    .
  "{0}  ({1:N1} MB)" -f $out, ((Get-Item $out).Length / 1MB)
} finally { Pop-Location }
