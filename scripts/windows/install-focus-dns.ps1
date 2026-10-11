# One-time setup for network-wide Focus DNS on Windows:
#  - opens inbound ports 53 (UDP/TCP) and 8080 (dashboard) for the local subnet
#  - registers a scheduled task that runs start-focus-dns.ps1 at sign-in
# Run from an elevated PowerShell (the firewall rules need administrator rights).

#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'
$start = Join-Path $PSScriptRoot 'start-focus-dns.ps1'
$rules = @(
  @{ Name = 'Focus DNS (UDP 53)'; Protocol = 'UDP'; Port = 53 }
  @{ Name = 'Focus DNS (TCP 53)'; Protocol = 'TCP'; Port = 53 }
  @{ Name = 'Focus DNS dashboard (TCP 8080)'; Protocol = 'TCP'; Port = 8080 }
)

# LocalSubnet keeps DNS and the dashboard off the internet even on a public-facing port.
foreach ($rule in $rules) {
  Remove-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Action Allow `
    -Protocol $rule.Protocol -LocalPort $rule.Port `
    -Profile Private, Domain -RemoteAddress LocalSubnet | Out-Null
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$start`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName 'Focus DNS' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Starts the Focus DNS docker container at sign-in.' -Force | Out-Null

Write-Output "Installed. Start it now with: Start-ScheduledTask -TaskName 'Focus DNS'"
Write-Output "Set Docker Desktop to start when you sign in (Settings > General)."
