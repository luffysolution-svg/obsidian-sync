# env_check.ps1 - obsidian-sync environment check (read-only)
# Usage: powershell -File env_check.ps1  (works on Windows PowerShell 5.1 and pwsh 7+)
# Output: a single JSON object. ASCII-only on purpose so PS 5.1 (ANSI/GBK default)
#         never mis-parses the file. See references/env-and-auth.md for field meanings.

$ErrorActionPreference = 'SilentlyContinue'

function Get-Trimmed {
    param([string[]]$Lines)
    return (($Lines | Out-String) -replace '\s+$', '')
}

# Pull the first JSON object out of text that may carry stderr prefixes.
function Extract-JsonText {
    param([string]$Text)
    $s = $Text.IndexOf('{')
    $e = $Text.LastIndexOf('}')
    if ($s -ge 0 -and $e -gt $s) {
        return $Text.Substring($s, $e - $s + 1)
    }
    return $Text
}

$result = [ordered]@{}

# node / npm / git
$result.node = Get-Trimmed (node --version 2>&1)
$result.npm  = Get-Trimmed (cmd /c "npm --version" 2>&1)
$result.git  = Get-Trimmed (cmd /c "git --version" 2>&1)

# lark-cli
$cli = Get-Command lark-cli -ErrorAction SilentlyContinue
if ($cli) {
    $cliPath = $cli.Source
    $result.lark_cli = [ordered]@{ path = $cliPath }
    $result.lark_cli.version = Get-Trimmed (& $cliPath --version 2>&1)

    # auth status summary (identity fields only)
    $authRaw = (& $cliPath auth status 2>&1 | Out-String)
    $jsonText = Extract-JsonText $authRaw
    try {
        $auth = $jsonText | ConvertFrom-Json
        $result.lark_auth = [ordered]@{
            identity  = $auth.identity
            bot       = $auth.identities.bot.status
            user      = $auth.identities.user.status
            user_hint = $auth.identities.user.hint
        }
    }
    catch {
        $len = [Math]::Min(400, $jsonText.Length)
        $result.lark_auth = [ordered]@{ raw = $jsonText.Substring(0, $len) }
    }
}
else {
    $result.lark_cli = [ordered]@{ installed = $false }
}

# ima credentials (presence only, never the value)
$clientId = $env:IMA_OPENAPI_CLIENTID
if (-not $clientId) { $clientId = $env:IMA_CLIENT_ID }
if (-not $clientId -and (Test-Path "$HOME\.config\ima\client_id")) {
    $clientId = (Get-Content "$HOME\.config\ima\client_id" -Raw).Trim()
}
$apiKey = $env:IMA_OPENAPI_APIKEY
if (-not $apiKey) { $apiKey = $env:IMA_API_KEY }
if (-not $apiKey -and (Test-Path "$HOME\.config\ima\api_key")) {
    $apiKey = (Get-Content "$HOME\.config\ima\api_key" -Raw).Trim()
}
$cidStatus = 'MISSING'; if ($clientId) { $cidStatus = 'set' }
$keyStatus = 'MISSING'; if ($apiKey) { $keyStatus = 'set' }

$result.ima = [ordered]@{
    client_id = $cidStatus
    api_key   = $keyStatus
}

# Notion token (presence only, never the value)
$notionToken = $env:NOTION_TOKEN
if (-not $notionToken) { $notionToken = $env:NOTION_API_KEY }
if (-not $notionToken -and (Test-Path "$HOME\.config\notion\token")) {
    $notionToken = (Get-Content "$HOME\.config\notion\token" -Raw).Trim()
}
$notionStatus = 'MISSING'; if ($notionToken) { $notionStatus = 'set' }
$result.notion = [ordered]@{
    token = $notionStatus
    proxy = if ($env:NOTION_PROXY) { 'set' } else { 'unset' }
}

$result | ConvertTo-Json -Depth 6
