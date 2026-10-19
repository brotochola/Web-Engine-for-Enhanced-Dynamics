param([int]$Root)

$ids = New-Object System.Collections.Generic.List[int]
if ($Root -le 0) { exit 0 }
$ids.Add($Root)
for ($i = 0; $i -lt $ids.Count; $i++) {
  $id = $ids[$i]
  $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" -ErrorAction SilentlyContinue)
  foreach ($k in $kids) {
    $kid = [int]$k.ProcessId
    if (-not $ids.Contains($kid)) { $ids.Add($kid) }
  }
}
foreach ($id in $ids) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p -and $null -ne $p.CPU) {
    '{0} {1}' -f $id, ([double]$p.CPU).ToString([cultureinfo]::InvariantCulture)
  }
}
