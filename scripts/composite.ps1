# Composite the account-view layer onto the chrome screenshot.
# Electron cannot capture native child views together with the window, so the two layers are shot
# separately and merged here.
param([string]$Base, [string]$Overlay, [int]$X = 240, [int]$Y = 48, [string]$Out = "")
Add-Type -AssemblyName System.Drawing
if (-not $Out) { $Out = $Base }
$b = [System.Drawing.Image]::FromFile((Resolve-Path $Base))
$o = [System.Drawing.Image]::FromFile((Resolve-Path $Overlay))
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($b, 0, 0, $b.Width, $b.Height)
$g.DrawImage($o, $X, $Y, $o.Width, $o.Height)
$full = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Out))
$b.Dispose(); $o.Dispose()
$bmp.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "composited -> $Out"
