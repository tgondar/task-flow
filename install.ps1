# Sets up /task-flow on this machine. Run it ONCE per machine; after that the plugin
# updates itself and there is nothing to re-run.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# What it does, each step idempotent:
#
#   1. adds this repository as a Claude Code marketplace (user scope);
#   2. installs the task-flow plugin from it (user scope - every project sees it,
#      and its hooks only act where .claude/task-flow.json exists);
#   3. turns on background auto-update for that marketplace, via the documented
#      extraKnownMarketplaces.<name>.autoUpdate setting in ~/.claude/settings.json.
#      With no "version" in plugin.json, every commit on main is an update;
#   4. puts a forwarder at ~/.claude/commands/task-flow.md, so the pipeline is
#      invoked as /task-flow (plugin skills can otherwise only be invoked with their
#      prefix, /task-flow:task-flow).
#
# Each repository still has to be configured once - the skill asks for the docs
# folder, the language and the task list the first time it runs there.
#
# ASCII only: Windows PowerShell 5.1 reads a BOM-less script as ANSI.

[CmdletBinding()]
param(
    # A GitHub owner/repo, a git URL or a local path (a local path is for testing
    # this repository before pushing it).
    [string]$Source = 'tgondar/task-flow',
    [string]$ClaudeDir = (Join-Path $env:USERPROFILE '.claude')
)

$ErrorActionPreference = 'Stop'
$marketplace = 'task-flow'
$plugin = 'task-flow@task-flow'

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    throw 'The claude CLI is not on PATH.'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'node is not on PATH (the hooks, the configuration check and the renderer need it).'
}

# --- 1. the marketplace ------------------------------------------------------
$known = (& claude plugin marketplace list 2>&1) -join "`n"
if ($known -match "(?m)\b$marketplace\b") {
    Write-Output "Marketplace '$marketplace' already added; refreshing it."
    & claude plugin marketplace update $marketplace
} else {
    & claude plugin marketplace add $Source
}
if ($LASTEXITCODE -ne 0) { throw "Adding the marketplace from $Source failed." }

# --- 2. the plugin -------------------------------------------------------------
& claude plugin install $plugin
if ($LASTEXITCODE -ne 0) { throw "Installing $plugin failed." }

# --- 3. auto-update ------------------------------------------------------------
# Done in node, from a file, with every value passed as an argument: PowerShell 5.1
# would re-encode the file with Set-Content, and strips the double quotes out of a
# JSON string handed to a native program on its command line.
$settings = Join-Path $ClaudeDir 'settings.json'
$sourceArg = if (Test-Path $Source) { (Resolve-Path $Source).Path } else { $Source }
& node (Join-Path $PSScriptRoot 'scripts\enable-autoupdate.js') $settings $marketplace $plugin $sourceArg
if ($LASTEXITCODE -ne 0) { throw "Could not update $settings." }
Write-Output "Auto-update on for '$marketplace' in $settings."

# --- 4. the /task-flow forwarder -----------------------------------------------
$commands = Join-Path $ClaudeDir 'commands'
if (-not (Test-Path $commands)) { New-Item -ItemType Directory -Path $commands -Force | Out-Null }
$shim = Join-Path $PSScriptRoot 'shim\task-flow.md'
$target = Join-Path $commands 'task-flow.md'
# Copy-Item copies bytes; no re-encoding.
Copy-Item -Path $shim -Destination $target -Force
Write-Output "Installed the /task-flow forwarder at $target."

Write-Output ''
Write-Output 'Done. Start a NEW Claude Code session (or run /reload-plugins) for it to load.'
Write-Output 'Use it as:  /task-flow <the task>   /task-flow auto <the task>   /task-flow'
Write-Output 'The first run in a repository asks for its docs folder, language and task list.'
