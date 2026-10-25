param(
    [string]$RuntimePath = '',
    [string]$RuntimeLicensePath = '',
    [string]$OutputDirectory = '',
    [string]$ArchiveDirectory = '',
    [string]$CommitRef = '',
    [switch]$SourceOnly,
    [switch]$SkipTests,
    [switch]$PassThru
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))

$runtimeCandidates = @($RuntimePath, (Join-Path $projectRoot 'runtime\node.exe'))
$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($nodeCommand) { $runtimeCandidates += $nodeCommand.Source }
$runtimeCandidates += (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
$nodePath = $null
foreach ($candidate in ($runtimeCandidates | Where-Object { $_ } | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $nodeVersion = & $candidate --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $nodeVersion -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) { $nodePath = [IO.Path]::GetFullPath($candidate); break }
}
if (-not $nodePath) { throw 'Node.js 22+ is required to test and build releases.' }
if (-not $RuntimePath) { $RuntimePath = $nodePath }
if (-not $RuntimeLicensePath) { $RuntimeLicensePath = Join-Path $projectRoot 'templates\node-LICENSE.txt' }

if (-not $SkipTests) {
    $testFiles = @((Get-ChildItem -LiteralPath $projectRoot -Filter '*.test.mjs' -File).FullName)
    $testFiles += @((Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.test.mjs' -File).FullName)
    if ($testFiles.Count -eq 0) { throw 'No automated release checks were found.' }
    & $nodePath --test @testFiles | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw 'Release checks failed.' }
}

$options = [ordered]@{
    root = $projectRoot
    outputDir = $OutputDirectory
    archiveDir = $ArchiveDirectory
    runtimePath = [IO.Path]::GetFullPath($RuntimePath)
    runtimeLicensePath = [IO.Path]::GetFullPath($RuntimeLicensePath)
    commitRef = $CommitRef
    sourceOnly = [bool]$SourceOnly
}
$optionFile = Join-Path ([IO.Path]::GetTempPath()) ('codex-daylight-release-' + [guid]::NewGuid().ToString('N') + '.json')
try {
    [IO.File]::WriteAllText($optionFile, ($options | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
    $json = & $nodePath (Join-Path $PSScriptRoot 'release-core.mjs') $optionFile
    if ($LASTEXITCODE -ne 0) { throw 'Release packaging failed. Existing archives were preserved.' }
    $release = ($json | Out-String) | ConvertFrom-Json
    Write-Host ('Source ZIP: ' + $release.sourceZip)
    if ($release.portableZip) { Write-Host ('Windows x64 ZIP: ' + $release.portableZip) }
    Write-Host ('Checksums: ' + $release.checksumsPath)
    Write-Host ('Verified version snapshot: ' + $release.snapshotDir)
    Write-Host 'Packaging does not create commits, push repositories, or send model requests.'
    if ($PassThru) { $release }
}
finally {
    # Delete one explicitly-created temporary options file; no recursive cleanup.
    if (Test-Path -LiteralPath $optionFile -PathType Leaf) { Remove-Item -LiteralPath $optionFile -Force }
}
