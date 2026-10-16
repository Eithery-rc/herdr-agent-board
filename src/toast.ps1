# Windows toast carrying the agent's actual words, in place of herdr's built-in popup (keep
# herdr's [ui.toast] delivery = "off" so they do not double up). A Claude Code hook, registered
# by the board's install action with --toast (the "notifications" action):
#   Stop                       -> "<workspace> . <session title>", body = last reply
#   Notification               -> same title, body = Claude's message (permission prompt etc.)
#   PreToolUse AskUserQuestion -> same title, body = the question
# Skipped when this pane is focused in herdr and the terminal is the foreground window,
# like herdr, which only pops up for background work.
# Clicking the toast opens claude-pane:<pane id>, a URL protocol registered below that runs
# this script again as `open <uri>`: the agent board shows that session when it runs and has it
# (its window comes up on the session's sheet), else herdr switches to that pane and the terminal
# comes to front.
# Runs as an async hook, so the herdr and WinRT calls do not hold up Claude.
# Try it from a herdr pane: a Stop payload on stdin and `force` (skips the focused-pane check):
#   '{"hook_event_name":"Stop","last_assistant_message":"Hi"}' | powershell -File toast.ps1 force

param([string]$Action = "", [string]$Uri = "")

$AppId = "Herdr.ClaudeAgent"
$ProtocolKey = "HKCU:\Software\Classes\claude-pane"
# This copy of the board (the script lives in its src folder); a click goes to its web board first.
$BoardDir = Split-Path -Parent $PSScriptRoot
$Dot = [char]0x00B7
$Ellipsis = [char]0x2026

# Read stdin as raw UTF-8: PowerShell 5.1 would decode it with the OEM code page.
function Read-Stdin {
    $ms = New-Object IO.MemoryStream
    [Console]::OpenStandardInput().CopyTo($ms)
    [Text.Encoding]::UTF8.GetString($ms.ToArray())
}

# Same reason: run herdr with an explicit UTF-8 stdout so Cyrillic labels survive.
# Errors go to stderr, so an empty result means the call failed.
function Invoke-Herdr([string[]]$ArgList) {
    $exe = if ([string]::IsNullOrWhiteSpace($env:HERDR_BIN_PATH)) { "herdr" } else { $env:HERDR_BIN_PATH }
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = $ArgList -join " "
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.CreateNoWindow = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $p = [Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEnd()
    $p.WaitForExit(5000) | Out-Null
    $out
}

function Get-HerdrSnapshot {
    try { (Invoke-Herdr @("api", "snapshot") | ConvertFrom-Json).result.snapshot } catch { $null }
}

function Import-Native {
    if ("ClaudeToast.Native" -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace ClaudeToast {
    public static class Native {
        delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        struct INPUT { public uint type; public MOUSEINPUT mi; }

        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
        [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

        public static uint ForegroundProcessId() {
            uint pid;
            GetWindowThreadProcessId(GetForegroundWindow(), out pid);
            return pid;
        }

        // Windows Terminal window, preferring the one titled by herdr ("<host>: <workspace>").
        public static IntPtr FindTerminal(string titlePrefix) {
            IntPtr match = IntPtr.Zero, first = IntPtr.Zero;
            EnumWindows((h, l) => {
                var cls = new StringBuilder(256);
                GetClassName(h, cls, cls.Capacity);
                if (cls.ToString() != "CASCADIA_HOSTING_WINDOW_CLASS" || !IsWindowVisible(h)) return true;
                if (first == IntPtr.Zero) first = h;
                var title = new StringBuilder(512);
                GetWindowText(h, title, title.Capacity);
                if (title.ToString().StartsWith(titlePrefix, StringComparison.OrdinalIgnoreCase)) { match = h; return false; }
                return true;
            }, IntPtr.Zero);
            return match != IntPtr.Zero ? match : first;
        }

        public static bool IsMinimized(IntPtr hWnd) { return IsIconic(hWnd); }
        public static bool IsForeground(IntPtr hWnd) { return GetForegroundWindow() == hWnd; }

        // Windows lets a process take the foreground only if it sent the last input or shares
        // input with the foreground thread, so send an empty mouse event and attach to that thread.
        public static void Activate(IntPtr hWnd) {
            var inputs = new INPUT[] { new INPUT { type = 0 } };
            SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
            uint ignored;
            uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
            uint me = GetCurrentThreadId();
            bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
            try {
                if (IsIconic(hWnd)) {
                    ShowWindow(hWnd, 9);
                    // SC_RESTORE is what the taskbar button sends; the window handles it itself.
                    if (IsIconic(hWnd)) PostMessage(hWnd, 0x0112, (IntPtr)0xF120, IntPtr.Zero);
                }
                BringWindowToTop(hWnd);
                SetForegroundWindow(hWnd);
            } finally {
                if (attached) AttachThreadInput(me, fgThread, false);
            }
        }
    }
}
'@
}

function Test-TerminalForeground {
    Import-Native
    $proc = Get-Process -Id ([ClaudeToast.Native]::ForegroundProcessId()) -ErrorAction SilentlyContinue
    $proc -and @("WindowsTerminal", "OpenConsole", "herdr") -contains $proc.ProcessName
}

function Register-Handlers {
    # An unpackaged app may post toasts under its own AUMID once it is registered here;
    # DisplayName is what the toast header shows instead of "Windows PowerShell".
    $aumidKey = "HKCU:\Software\Classes\AppUserModelId\$AppId"
    if (-not (Test-Path $aumidKey)) {
        New-Item -Path $aumidKey -Force | Out-Null
        New-ItemProperty -Path $aumidKey -Name DisplayName -Value "Claude" -PropertyType String -Force | Out-Null
    }

    # Rewritten on every toast so the click handler follows herdr updates (the binary path is versioned).
    $commandKey = "$ProtocolKey\shell\open\command"
    if (-not (Test-Path $commandKey)) { New-Item -Path $commandKey -Force | Out-Null }
    $ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
    # conhost --headless keeps the handler windowless; a plain launch would flash a terminal.
    $command = "`"$conhost`" --headless `"$ps`" -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" open `"%1`""
    Set-ItemProperty -Path $ProtocolKey -Name "(default)" -Value "URL:Claude pane"
    Set-ItemProperty -Path $ProtocolKey -Name "URL Protocol" -Value ""
    if (-not [string]::IsNullOrWhiteSpace($env:HERDR_BIN_PATH)) {
        Set-ItemProperty -Path $ProtocolKey -Name HerdrPath -Value $env:HERDR_BIN_PATH
    }
    Set-ItemProperty -Path $commandKey -Name "(default)" -Value $command
}

function ConvertTo-PlainText([string]$Text, [int]$Max) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return "" }
    $t = $Text -replace '```[\s\S]*?```', ' '
    $t = $t -replace '\[([^\]]+)\]\([^)]*\)', '$1'
    $t = $t -replace '\*\*|__|`', ''
    $t = $t -replace '(?m)^\s{0,3}#{1,6}\s*', ''
    $t = $t -replace '(?m)^\s*>\s?', ''
    $t = $t -replace '(?m)^\s*[-*+]\s+', ''
    $t = ($t -replace '\s+', ' ').Trim()
    if ($t.Length -gt $Max) { $t = $t.Substring(0, $Max).TrimEnd() + $Ellipsis }
    $t
}

function Get-LastAssistantText([string]$TranscriptPath) {
    if ([string]::IsNullOrWhiteSpace($TranscriptPath) -or -not (Test-Path -LiteralPath $TranscriptPath)) { return "" }
    $lines = @(Get-Content -LiteralPath $TranscriptPath -Tail 300 -Encoding UTF8)
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        if ($lines[$i] -notmatch '"type":"assistant"') { continue }
        try { $entry = $lines[$i] | ConvertFrom-Json } catch { continue }
        if ($entry.type -ne "assistant" -or $entry.isSidechain) { continue }
        $texts = @($entry.message.content | Where-Object { $_.type -eq "text" } | ForEach-Object { $_.text })
        if ($texts.Count -gt 0) { return ($texts -join "`n") }
    }
    ""
}

function Show-Toast([string]$Title, [string]$Body, [string]$Attribution, [string]$PaneId) {
    Register-Handlers

    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
    $esc = { param($s) [Security.SecurityElement]::Escape($s) }
    # Silent: herdr's own [ui.sound] already plays the done/request sound.
    $xml = @"
<toast activationType="protocol" launch="$(& $esc "claude-pane:$PaneId")">
  <visual>
    <binding template="ToastGeneric">
      <text hint-maxLines="1">$(& $esc $Title)</text>
      <text>$(& $esc $Body)</text>
      <text placement="attribution">$(& $esc $Attribution)</text>
    </binding>
  </visual>
  <audio silent="true"/>
</toast>
"@
    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($xml)
    $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
    # One live toast per pane: a newer one replaces the old in the notification center.
    $toast.Group = "herdr"
    $toast.Tag = $PaneId -replace '[^A-Za-z0-9_.-]', '_'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
}

if ($Action -eq "open") {
    # Any app or web page can open a claude-pane: link, so accept nothing but a pane id.
    if ([Uri]::UnescapeDataString($Uri) -notmatch '^claude-pane:([A-Za-z0-9]+:p[A-Za-z0-9]+)/?$') { exit 0 }
    $paneId = $Matches[1]

    # The board first: when it runs and has a session in this pane, its window comes up on that
    # session (web-open.mjs does both). Exit code 3: it does not run or has no such session.
    $boardOpen = Join-Path $BoardDir "src\web-open.mjs"
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if ($node -and (Test-Path -LiteralPath $boardOpen)) {
        & $node $boardOpen --pane $paneId | Out-Null
        if ($LASTEXITCODE -eq 0) { exit 0 }
    }

    $env:HERDR_BIN_PATH = (Get-ItemProperty -Path $ProtocolKey -Name HerdrPath -ErrorAction SilentlyContinue).HerdrPath
    if ($env:HERDR_BIN_PATH -and -not (Test-Path -LiteralPath $env:HERDR_BIN_PATH)) { $env:HERDR_BIN_PATH = "" }

    # agent focus switches workspace, tab and pane at once but needs a live agent in the pane;
    # if Claude has exited since, at least open the pane's tab.
    if (-not (Invoke-Herdr @("agent", "focus", $paneId))) {
        $snap = Get-HerdrSnapshot
        $pane = if ($snap) { @($snap.panes | Where-Object { $_.pane_id -eq $paneId })[0] } else { $null }
        if ($pane) { Invoke-Herdr @("tab", "focus", $pane.tab_id) | Out-Null }
    }

    Import-Native
    $window = [ClaudeToast.Native]::FindTerminal("$($env:COMPUTERNAME):")
    if ($window -ne [IntPtr]::Zero) {
        # The click's own flyout may still hold the foreground for a moment, so check and retry.
        for ($try = 1; $try -le 5; $try++) {
            [ClaudeToast.Native]::Activate($window)
            Start-Sleep -Milliseconds 200
            if (-not [ClaudeToast.Native]::IsMinimized($window) -and [ClaudeToast.Native]::IsForeground($window)) { break }
        }
    }
    exit 0
}

if ($env:HERDR_ENV -ne "1") { exit 0 }
if ([string]::IsNullOrWhiteSpace($env:HERDR_PANE_ID)) { exit 0 }

try {
    $payload = Read-Stdin | ConvertFrom-Json
} catch {
    exit 0
}
if ($null -eq $payload) { exit 0 }
if (-not [string]::IsNullOrWhiteSpace($payload.agent_id)) { exit 0 }

switch ($payload.hook_event_name) {
    "Stop" {
        $text = $payload.last_assistant_message
        if ([string]::IsNullOrWhiteSpace($text)) { $text = Get-LastAssistantText $payload.transcript_path }
        $body = ConvertTo-PlainText $text 300
        if (-not $body) { $body = "finished" }
        $attribution = "claude finished"
    }
    "Notification" {
        # idle_prompt ("waiting for your input") only repeats what the Stop toast said.
        if (@("permission_prompt", "elicitation_dialog") -notcontains $payload.notification_type) { exit 0 }
        $body = ConvertTo-PlainText $payload.message 300
        $attribution = "claude needs attention"
    }
    "PreToolUse" {
        if ($payload.tool_name -ne "AskUserQuestion") { exit 0 }
        $q = @($payload.tool_input.questions)[0]
        $body = ConvertTo-PlainText $q.question 300
        $attribution = "claude asks"
    }
    default { exit 0 }
}

$snap = Get-HerdrSnapshot
$pane = if ($snap) { @($snap.panes | Where-Object { $_.pane_id -eq $env:HERDR_PANE_ID })[0] } else { $null }

if ($pane) {
    # A headless `claude -p` started from inside this pane is not the pane's agent: stay quiet.
    $paneSession = $pane.agent_session.value
    if ($paneSession -and $payload.session_id -and $paneSession -ne $payload.session_id) { exit 0 }

    # `-File claude-toast.ps1 force` skips this check, for trying it out from the focused pane.
    if ($Action -ne "force" -and $snap.focused_pane_id -eq $pane.pane_id -and (Test-TerminalForeground)) { exit 0 }

    $ws = @($snap.workspaces | Where-Object { $_.workspace_id -eq $pane.workspace_id })[0]
    $tab = @($snap.tabs | Where-Object { $_.tab_id -eq $pane.tab_id })[0]
    $topic = $pane.terminal_title_stripped
    if ([string]::IsNullOrWhiteSpace($topic) -or $topic -eq "Claude Code") { $topic = $tab.label }
    $title = (@($ws.label, $topic) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join " $Dot "
} else {
    $title = Split-Path -Leaf $payload.cwd
}
if ([string]::IsNullOrWhiteSpace($title)) { $title = "Claude" }

try {
    Show-Toast $title $body $attribution $env:HERDR_PANE_ID
} catch {
}
