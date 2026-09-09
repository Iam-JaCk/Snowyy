param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][ValidateSet('pause', 'resume')][string]$Action
)

$source = @'
using System;
using System.Runtime.InteropServices;
public static class SnowyyProcessControl {
  [DllImport("ntdll.dll")]
  public static extern int NtSuspendProcess(IntPtr processHandle);
  [DllImport("ntdll.dll")]
  public static extern int NtResumeProcess(IntPtr processHandle);
}
'@

Add-Type -TypeDefinition $source
$processes = Get-CimInstance Win32_Process
$ids = [System.Collections.Generic.List[int]]::new()
function Add-ProcessTree([int]$ParentId) {
  foreach ($child in $processes | Where-Object { $_.ParentProcessId -eq $ParentId }) {
    Add-ProcessTree ([int]$child.ProcessId)
  }
  $ids.Add($ParentId)
}
Add-ProcessTree $ProcessId
if ($Action -eq 'resume') { $ids.Reverse() }

foreach ($id in $ids) {
  try {
    $process = Get-Process -Id $id -ErrorAction Stop
    $status = if ($Action -eq 'pause') {
      [SnowyyProcessControl]::NtSuspendProcess($process.Handle)
    } else {
      [SnowyyProcessControl]::NtResumeProcess($process.Handle)
    }
    if ($status -ne 0) { throw "Native process control returned status $status for PID $id." }
  } catch {
    if ($id -eq $ProcessId) { throw }
  }
}
