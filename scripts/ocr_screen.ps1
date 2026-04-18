# Windows OCR Script using Windows.Media.Ocr
# Equivalent of ocr_screen.swift on macOS
# Usage: powershell -File ocr_screen.ps1 [screenshot_path]
# Outputs JSON with same format as the Swift version

param(
    [string]$ImagePath = ""
)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# ── Capture screenshot if no path provided ──────
$tempCapture = $false
if (-not $ImagePath -or $ImagePath -eq "") {
    $ImagePath = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "atlas_ocr_$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()).png")
    $screens = [System.Windows.Forms.Screen]::AllScreens
    $bounds = [System.Drawing.Rectangle]::Empty
    foreach ($s in $screens) { $bounds = [System.Drawing.Rectangle]::Union($bounds, $s.Bounds) }
    $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $g.Dispose()
    $bmp.Save($ImagePath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $tempCapture = $true
}

# ── Load image ──────────────────────────────────
try {
    $img = [System.Drawing.Image]::FromFile($ImagePath)
} catch {
    Write-Output '{"error": "Failed to load image"}'
    exit 1
}

$imageWidth = $img.Width
$imageHeight = $img.Height

# Get logical screen size
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$screenWidth = $screen.Width
$screenHeight = $screen.Height

# ── Run Windows.Media.Ocr ──────────────────────
# Load WinRT OCR assemblies
try {
    Add-Type -AssemblyName 'System.Runtime.WindowsRuntime'

    # Load the OCR engine
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
    $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType=WindowsRuntime]
    $null = [Windows.Storage.Streams.RandomAccessStream, Windows.Foundation, ContentType=WindowsRuntime]

    # Helper to await WinRT async operations
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

    Function Await($WinRtTask, $ResultType) {
        $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
        $netTask = $asTask.Invoke($null, @($WinRtTask))
        $netTask.Wait(-1) | Out-Null
        $netTask.Result
    }

    Function AwaitAction($WinRtTask) {
        $asActionTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
            Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
        $netTask = $asActionTask.Invoke($null, @($WinRtTask))
        $netTask.Wait(-1) | Out-Null
    }

    # Get OCR engine for user's language
    $ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()

    if ($null -eq $ocrEngine) {
        # Try English
        $lang = New-Object Windows.Globalization.Language("en-US")
        $ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    }

    if ($null -eq $ocrEngine) {
        Write-Output '{"error": "OCR engine not available"}'
        exit 1
    }

    # Open file as StorageFile
    $storageFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])

    # Open file stream
    $stream = Await ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])

    # Decode image
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])

    # Get software bitmap
    $softwareBitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

    # Run OCR
    $ocrResult = Await ($ocrEngine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])

    # Build elements array
    $elements = @()
    foreach ($line in $ocrResult.Lines) {
        foreach ($word in $line.Words) {
            $rect = $word.BoundingRect

            # Normalized coordinates (0-1)
            $cx_norm = ($rect.X + $rect.Width / 2) / $imageWidth
            $cy_norm = ($rect.Y + $rect.Height / 2) / $imageHeight
            $w_norm = $rect.Width / $imageWidth
            $h_norm = $rect.Height / $imageHeight

            # Screen coordinates
            $cx_screen = $cx_norm * $screenWidth
            $cy_screen = $cy_norm * $screenHeight

            $elements += @{
                text = $word.Text
                cx_norm = [Math]::Round($cx_norm, 5)
                cy_norm = [Math]::Round($cy_norm, 5)
                w_norm = [Math]::Round($w_norm, 5)
                h_norm = [Math]::Round($h_norm, 5)
                cx_screen = [Math]::Round($cx_screen, 1)
                cy_screen = [Math]::Round($cy_screen, 1)
                w_screen = [Math]::Round($rect.Width / $imageWidth * $screenWidth, 1)
                h_screen = [Math]::Round($rect.Height / $imageHeight * $screenHeight, 1)
                confidence = 0.95
            }
        }
    }

    $stream.Dispose()
    $softwareBitmap.Dispose()
    $img.Dispose()

} catch {
    # Fallback: output error with empty elements
    $img.Dispose()
    $output = @{
        error = $_.Exception.Message
        image_width = $imageWidth
        image_height = $imageHeight
        screen_width = $screenWidth
        screen_height = $screenHeight
        element_count = 0
        elements = @()
    }
    Write-Output ($output | ConvertTo-Json -Depth 3 -Compress)
    if ($tempCapture -and (Test-Path $ImagePath)) { Remove-Item $ImagePath -Force }
    exit 0
}

# ── Cleanup temp screenshot ────────────────────
if ($tempCapture -and (Test-Path $ImagePath)) {
    Remove-Item $ImagePath -Force
}

# ── Output JSON ────────────────────────────────
$output = @{
    image_width = $imageWidth
    image_height = $imageHeight
    screen_width = $screenWidth
    screen_height = $screenHeight
    recognition = "accurate"
    element_count = $elements.Count
    elements = $elements
}

Write-Output ($output | ConvertTo-Json -Depth 3 -Compress)
