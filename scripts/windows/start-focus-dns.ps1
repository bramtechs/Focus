# Starts the Focus DNS container with Docker Compose. Run at sign-in by the
# "Focus DNS" scheduled task that install-focus-dns.ps1 registers.

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$deadline = (Get-Date).AddMinutes(5)

# Docker Desktop starts after sign-in, so wait until the engine answers.
while ($true) {
  docker info > $null 2>&1
  if ($LASTEXITCODE -eq 0) { break }
  if ((Get-Date) -gt $deadline) { throw "Docker engine did not start within 5 minutes." }
  Start-Sleep -Seconds 5
}

# --build picks up code changes from git pull; unchanged layers are cached.
Set-Location $repo
docker compose up -d --build
