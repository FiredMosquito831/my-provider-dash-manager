# OS-level screenshot of THIS app's window only.
#
# Why not Electron's capturePage()? It captures the window's own page only — account dashboards are
# native child WebContentsViews and never appear in it.
#
# Why PrintWindow and not CopyFromScreen? CopyFromScreen grabs whatever pixels occupy that screen
# rectangle, which is another window if the app is not truly in front — it can capture unrelated,
# private content. PrintWindow(PW_RENDERFULLCONTENT) asks the window to render itself, so the result
# can only ever contain this app.
#
#   powershell -File scripts/shot.ps1 -TitleLike "*Provider Dash*" -Out docs/screenshots/x.png
param(
  [string]$TitleLike = "*Provider Dash*",
  [string]$Out = "shot.png",
  [int]$WaitSeconds = 0
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinShot {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

if ($WaitSeconds -gt 0) { Start-Sleep -Seconds $WaitSeconds }

$proc = Get-Process | Where-Object { $_.MainWindowTitle -like $TitleLike } | Select-Object -First 1
if (-not $proc) { Write-Error "No window matching '$TitleLike'"; exit 1 }
$h = $proc.MainWindowHandle

if ([WinShot]::IsIconic($h)) { [void][WinShot]::ShowWindow($h, 9); Start-Sleep -Milliseconds 800 }

$r = New-Object WinShot+RECT
[void][WinShot]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $ht = $r.B - $r.T
if ($w -le 0 -or $ht -le 0) { Write-Error "Bad window rect"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# 0x2 = PW_RENDERFULLCONTENT: required for hardware-accelerated / Chromium windows
$ok = [WinShot]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
if (-not $ok) { $g.Dispose(); $bmp.Dispose(); Write-Error "PrintWindow failed"; exit 1 }

$full = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Out))
$dir = Split-Path -Parent $full
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "saved $Out ($w x $ht) from '$($proc.MainWindowTitle)'"
