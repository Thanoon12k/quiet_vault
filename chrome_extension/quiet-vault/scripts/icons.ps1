Add-Type -AssemblyName System.Drawing
# Editable source: public/icons/mascot.svg. Render at 4x and downsample for crisp toolbar icons.
$edge = 512
$bitmap = [System.Drawing.Bitmap]::new($edge, $edge)
$g = [System.Drawing.Graphics]::FromImage($bitmap)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)
$g.ScaleTransform(4, 4)
function RoundedPath([single]$x,[single]$y,[single]$width,[single]$height,[single]$radius) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $radius * 2
  $path.AddArc($x,$y,$diameter,$diameter,180,90)
  $path.AddArc(($x+$width-$diameter),$y,$diameter,$diameter,270,90)
  $path.AddArc(($x+$width-$diameter),($y+$height-$diameter),$diameter,$diameter,0,90)
  $path.AddArc($x,($y+$height-$diameter),$diameter,$diameter,90,90)
  $path.CloseFigure()
  return $path
}
$sage = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#eaf0df'))
$green = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#355a45'))
$cream = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#fffdf3'))
$pink = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#eea89e'))
$dark = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#233c2c'))
$tile = RoundedPath 2 2 124 124 27
$g.FillPath($sage, $tile)
$shackle = [System.Drawing.Pen]::new($green.Color, 13)
$shackle.StartCap = 'Round'; $shackle.EndCap = 'Round'
$g.DrawArc($shackle, 44, 19, 42, 55, 180, 180)
$g.DrawLine($shackle, 44, 46, 44, 55)
$g.DrawLine($shackle, 86, 46, 86, 55)
$body = RoundedPath 19 43 90 72 23
$g.FillPath($green, $body)
$g.FillEllipse($cream, 28, 54, 31, 31)
$g.FillEllipse($cream, 66, 49, 36, 36)
$g.FillEllipse($dark, 39, 63, 12, 14)
$g.FillEllipse($dark, 72, 60, 13, 15)
$g.FillEllipse($cream, 42, 65, 4, 4)
$g.FillEllipse($cream, 75, 62, 4, 4)
$smile = [System.Drawing.Pen]::new($dark.Color, 5)
$smile.StartCap = 'Round'; $smile.EndCap = 'Round'
$g.DrawArc($smile, 46, 77, 37, 25, 12, 150)
$g.FillEllipse($pink, 65, 92, 12, 12)
$tongue = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#cf7f78'), 1.7)
$g.DrawLine($tongue, 71, 94, 71, 98)
foreach ($size in @(16,48,128,512)) {
  $target = [System.Drawing.Bitmap]::new($size,$size)
  $renderer = [System.Drawing.Graphics]::FromImage($target)
  $renderer.CompositingQuality = 'HighQuality'
  $renderer.InterpolationMode = 'HighQualityBicubic'
  $renderer.PixelOffsetMode = 'HighQuality'
  $renderer.DrawImage($bitmap,0,0,$size,$size)
  $target.Save((Join-Path $PSScriptRoot "../public/icons/icon$size.png"),[System.Drawing.Imaging.ImageFormat]::Png)
  $renderer.Dispose(); $target.Dispose()
}
$g.Dispose(); $bitmap.Dispose()
foreach ($item in @($sage,$green,$cream,$pink,$dark,$tile,$body,$shackle,$smile,$tongue)) { $item.Dispose() }
