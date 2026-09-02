# DSH Desktop - create a bulletproof desktop launcher set:
#   1) a VBS launcher that runs Electron silently (no shell-link resolution);
#   2) a .lnk whose target is the system script host wscript.exe (a file that
#      ALWAYS exists), which simply executes that VBS. The classic
#      "target changed or moved" repair wizard can therefore never appear.
# The paths are derived from this script's own location (no interpolation).

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
$ws = New-Object -ComObject WScript.Shell

# 1) VBS launcher (the real engine; runs hidden, no console window).
#    If electron.exe ever goes missing, show a clear message instead of
#    failing silently.
$vbs = 'Set fso = CreateObject("Scripting.FileSystemObject")' + "`r`n" +
       'If Not fso.FileExists("' + ($exe -replace '"', '""') + '") Then' + "`r`n" +
       '  MsgBox "DSH: electron.exe not found. Please run the installer again (双击一键安装.bat).", 48, "DSH Desktop"' + "`r`n" +
       'Else' + "`r`n" +
       '  Set sh = CreateObject("WScript.Shell")' + "`r`n" +
       '  sh.Run """' + $exe + '"" """' + $dir + '""", 0, False' + "`r`n" +
       'End If'
$vbsPath = $desktop + '\DSH Desktop Launcher.vbs'
[System.IO.File]::WriteAllText($vbsPath, $vbs, [System.Text.Encoding]::Unicode)
Write-Output ('[OK] VBS launcher created: ' + $vbsPath)

# 2) Desktop shortcut whose target is the always-present script host.
$wsHost = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path $wsHost)) {
  $wsHost = Join-Path $env:SystemRoot 'SysWOW64\wscript.exe'
}
$lnkPath = $desktop + '\DSH Desktop.lnk'
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = $wsHost
$lnk.Arguments = '"' + $vbsPath + '"'
$lnk.WorkingDirectory = $dir
$lnk.IconLocation = (Join-Path $dir 'assets\app.ico') + ',0'
$lnk.Description = 'DSH Desktop'
$lnk.Save()
$check = $ws.CreateShortcut($lnkPath)
if ($check.TargetPath -ne $wsHost) {
  Write-Output ('[ERROR] Shortcut verification failed, target saved as: ' + $check.TargetPath)
  exit 1
}
Write-Output ('[OK] Desktop shortcut created: ' + $lnkPath)
