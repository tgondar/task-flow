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
#      prefix, /task-flow:task-flow);
#   5. registers the task-flow panel to start when you log on to Windows (a
#      scheduled task for your user, no admin rights), and starts it now. The panel
#      is a local page, http://127.0.0.1:5190/, listing the runs of every project on
#      this machine and taking your answers to their questions. -NoPanel skips this
#      step; -RemovePanel only removes the scheduled task and stops the panel.
#      task-flow works the same without the panel.
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
    [string]$ClaudeDir = (Join-Path $env:USERPROFILE '.claude'),
    # Install everything but the panel's logon task.
    [switch]$NoPanel,
    # Remove the panel's logon task, stop the panel, and do nothing else.
    [switch]$RemovePanel
)

$ErrorActionPreference = 'Stop'
$marketplace = 'task-flow'
$plugin = 'task-flow@task-flow'
$panelTask = 'task-flow panel'

if ($RemovePanel) {
    $existing = Get-ScheduledTask -TaskName $panelTask -ErrorAction SilentlyContinue
    if ($existing) {
        Stop-ScheduledTask -TaskName $panelTask -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $panelTask -Confirm:$false
        Write-Output "Removed the scheduled task '$panelTask'."
    } else {
        Write-Output "No scheduled task '$panelTask' to remove."
    }
    # The panel records its own process; stop that one, and only if it is node.
    $registry = Join-Path $env:LOCALAPPDATA 'task-flow\panel\server.json'
    if (Test-Path $registry) {
        try {
            $info = Get-Content -Raw -Path $registry | ConvertFrom-Json
            $process = Get-Process -Id ([int]$info.pid) -ErrorAction Stop
            # A process id can be reused: stop it only if it is node running panel.mjs.
            $commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)").CommandLine
            if ($process.ProcessName -eq 'node' -and $commandLine -like '*panel.mjs*') {
                Stop-Process -Id $process.Id -Force
                Write-Output "Stopped the panel (process $($process.Id))."
            }
        } catch {
            Write-Output 'The panel was not running.'
        }
        Remove-Item -Path $registry -Force -ErrorAction SilentlyContinue
    }
    return
}

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    throw 'The claude CLI is not on PATH.'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'node is not on PATH (the hooks, the configuration check and the renderer need it).'
}

# --- 1. the marketplace ------------------------------------------------------
$known = (& claude plugin marketplace list 2>&1) -join "`n"
# The whole name, not a word inside a longer one: \b matches before a hyphen, so
# a marketplace called task-flow-x would pass for this one and get "refreshed".
if ($known -match "(?m)(?<![\w-])$([regex]::Escape($marketplace))(?![\w-])") {
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

# --- 5. the panel ----------------------------------------------------------------
# The task runs the panel from the marketplace's own copy of this repository,
# which keeps one path across updates (the plugin cache folder is named after the
# commit and changes with every update). A hidden PowerShell window starts node, so
# nothing appears on screen at logon.
if (-not $NoPanel) {
    $panelScript = Join-Path $ClaudeDir 'plugins\marketplaces\task-flow\plugin\panel\panel.mjs'
    if (-not (Test-Path $panelScript)) {
        Write-Output "The panel was not registered: $panelScript is not there (run 'claude plugin marketplace update task-flow' and install again)."
    } else {
        $node = (Get-Command node).Source
        $command = "& '" + $node.Replace("'", "''") + "' '" + $panelScript.Replace("'", "''") + "' --quiet"
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -Command "' + $command + '"')
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
        Register-ScheduledTask -TaskName $panelTask -Action $action -Trigger $trigger -Settings $settings -Description 'task-flow panel: the runs on this machine and the questions waiting for you, on http://127.0.0.1:5190/' -Force | Out-Null
        Start-ScheduledTask -TaskName $panelTask
        # Open it once through panel.mjs: that hands this browser the panel's key.
        Start-Sleep -Seconds 2
        & $node $panelScript --open
        Write-Output "Registered and started the panel (remove it with -RemovePanel). Open it again any time with: node '$panelScript' --open"
    }
}

Write-Output ''
Write-Output 'Done. Start a NEW Claude Code session (or run /reload-plugins) for it to load.'
Write-Output 'Use it as:  /task-flow <the task>   /task-flow auto <the task>   /task-flow'
Write-Output 'The first run in a repository asks for its docs folder, language and task list.'
