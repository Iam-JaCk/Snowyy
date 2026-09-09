Add-Type -AssemblyName System.Windows.Forms

$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a workspace for Snowyy'
$dialog.UseDescriptionForTitle = $true
$dialog.ShowNewFolderButton = $true

if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output $dialog.SelectedPath
}
