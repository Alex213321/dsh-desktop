# DSH Desktop - create the desktop shortcut + a fallback VBS launcher.
# The path is derived from this script's own location (no interpolation),
# and the shortcut result is verified by reading it back.

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $dir 'node_modules\electron\dist\electron.exe'

# Cloud-sync folders (Baidu Netdisk / OneDrive / Dropbox ...) offload files
# to the cloud, which breaks shortcuts and even the app itself.
if ($dir -match 'BaiduNetdisk|OneDrive|Dropbox|iCloud|Google Drive') {
  Write-Output ('[WARN] Install path is inside a cloud-sync folder: ' + $dir)
  Write-Output '       Cloud sync may offload electron.exe and break the shortcut.'
  Write-Output '       Please move the whole folder to a normal local directory'
  Write-Output '       (e.g. D:\DSH) and run the installer again.'
}

if (-not (Test-Path $exe)) {
  Write-Output ('[ERROR] electron.exe not found: ' + $exe)
  Write-Output 'Please re-run the installer script (npm install) first.'
  exit 1
}

$desktop = [Environment]::GetFolderPath('Desktop')

# 1) Regular shortcut (nice icon, standard double-click)
$ws = New-Object -ComObject WScript.Shell
$lnkPath = $desktop + '\DSH Desktop.lnk'
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = $exe
$lnk.Arguments = '"' + $dir + '"'
$lnk.WorkingDirectory = $dir
$lnk.IconLocation = (Join-Path $dir 'assets\app.ico') + ',0'
$lnk.Description = 'DSH Desktop'
$lnk.Save()
$check = $ws.CreateShortcut($lnkPath)
if ($check.TargetPath -ne $exe) {
  Write-Output ('[ERROR] Shortcut verification failed, target saved as: ' + $check.TargetPath)
  exit 1
}
Write-Output ('[OK] Desktop shortcut created: ' + $lnkPath)

# 2) Fallback VBS launcher: launches Electron silently with no shortcut
#    resolution involved. Works even where .lnk resolution misbehaves.
$vbs = 'Set sh = CreateObject("WScript.Shell")' + "`r`n" +
       'sh.Run """' + $exe + '"" """' + $dir + '""", 0, False'
$vbsPath = $desktop + '\DSH Desktop Launcher.vbs'
[System.IO.File]::WriteAllText($vbsPath, $vbs, [System.Text.Encoding]::Unicode)
Write-Output ('[OK] Fallback launcher created: ' + $vbsPath)
