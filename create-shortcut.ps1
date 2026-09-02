# DSH Desktop - create the desktop shortcut pointing at the bundled Electron.
# The path is derived from this script's own location (no interpolation),
# and the result is verified by reading the shortcut back.
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $dir 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path $exe)) {
  Write-Output ('[ERROR] electron.exe not found: ' + $exe)
  Write-Output 'Please re-run the installer script (npm install) first.'
  exit 1
}

$ws = New-Object -ComObject WScript.Shell
$lnkPath = [Environment]::GetFolderPath('Desktop') + '\DSH Desktop.lnk'
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = $exe
$lnk.Arguments = '"' + $dir + '"'
$lnk.WorkingDirectory = $dir
$lnk.IconLocation = (Join-Path $dir 'assets\app.ico') + ',0'
$lnk.Description = 'DSH Desktop'
$lnk.Save()

# Verify by reading the shortcut back.
$check = $ws.CreateShortcut($lnkPath)
if ($check.TargetPath -ne $exe) {
  Write-Output ('[ERROR] Shortcut verification failed, target saved as: ' + $check.TargetPath)
  exit 1
}
Write-Output ('[OK] Desktop shortcut created: ' + $lnkPath)
