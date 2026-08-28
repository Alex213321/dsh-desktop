# DSH Desktop - create the desktop shortcut pointing at the bundled Electron.
# The path is derived from this script's own location (no interpolation).
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\DSH Desktop.lnk')
$lnk.TargetPath = Join-Path $dir 'node_modules\electron\dist\electron.exe'
$lnk.Arguments = '"' + $dir + '"'
$lnk.WorkingDirectory = $dir
$lnk.IconLocation = (Join-Path $dir 'assets\app.ico') + ',0'
$lnk.Description = 'DSH Desktop'
$lnk.Save()
