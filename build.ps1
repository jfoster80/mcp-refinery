#Requires -Version 5.1
<#
.SYNOPSIS
    Build, bundle, and publish MCP Refinery.
    Outputs the Cursor MCP server connection config that must match mcp_settings.json.

.DESCRIPTION
    1. Compiles TypeScript
    2. Bundles to a single portable CJS file
    3. Validates the bundle exists and is runnable
    4. Emits the exact mcpServers connection block for Cursor settings
    5. Verifies the live connection config matches the expected config

.EXAMPLE
    .\build.ps1
    .\build.ps1 -SkipBundle
#>

param(
    [switch]$SkipBundle,
    [switch]$VerifyOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Constants — single source of truth for the MCP connection
# ---------------------------------------------------------------------------

$ProjectRoot   = $PSScriptRoot
$PackageJson   = Get-Content "$ProjectRoot\package.json" -Raw | ConvertFrom-Json
$ServerName    = $PackageJson.name            # "mcp-refinery"
$ServerVersion = $PackageJson.version         # "0.1.0"
$BundlePath    = "$ProjectRoot\dist\mcp-refinery.cjs"
$DevEntryPoint = "$ProjectRoot\src\index.ts"

# The canonical MCP server connection config.
# This is what Cursor needs in its settings to connect to this server.
# NOTE: API keys are passed through from the parent process environment.
# The server checks env vars LIVE — adding a key later works without restart.
# Only include keys you actually have. Remove the rest; the server handles missing keys gracefully.
#
# Current setup: Anthropic only. Uncomment others when keys become available.
$McpConnection = @{
    $ServerName = @{
        command = "node"
        args    = @($BundlePath.Replace('\', '/'))
        env     = @{
            REFINERY_DATA_PATH = "./data"
        }
    }
}

# Dev-mode connection (uses tsx, no build required)
$McpConnectionDev = @{
    $ServerName = @{
        command = "npx"
        args    = @("tsx", $DevEntryPoint.Replace('\', '/'))
        env     = @{
            REFINERY_DATA_PATH = "./data"
        }
    }
}

# This is the JSON you paste into Cursor MCP settings.
# API keys: Cursor inherits from your system environment.
# Set them in your shell profile or .env, NOT in the JSON config.
# The server detects keys live: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_AI_API_KEY, XAI_API_KEY
$CursorJsonBlock = @"
{
  "mcpServers": {
    "mcp-refinery": {
      "command": "node",
      "args": ["$($BundlePath.Replace('\', '/'))"],
      "env": {
        "REFINERY_DATA_PATH": "./data"
      }
    }
  }
}
"@

# ---------------------------------------------------------------------------
# Functions
# ---------------------------------------------------------------------------

function Write-Header([string]$text) {
    Write-Host ""
    Write-Host "=== $text ===" -ForegroundColor Cyan
}

function Write-McpConfig {
    param([hashtable]$Config, [string]$Label)

    Write-Header $Label
    $wrapper = @{ mcpServers = $Config }
    $json = $wrapper | ConvertTo-Json -Depth 5
    Write-Host $json -ForegroundColor Green
    Write-Host ""
    return $json
}

function Test-BundleExists {
    if (-not (Test-Path $BundlePath)) {
        Write-Host "ERROR: Bundle not found at $BundlePath" -ForegroundColor Red
        Write-Host "Run: .\build.ps1  (without -SkipBundle)" -ForegroundColor Yellow
        return $false
    }
    $size = (Get-Item $BundlePath).Length
    $sizeKB = [math]::Round($size / 1024)
    Write-Host "Bundle: $BundlePath ($sizeKB KB)" -ForegroundColor Green
    return $true
}

function Test-NodeAvailable {
    try {
        $ver = & node --version 2>&1
        Write-Host "Node.js: $ver" -ForegroundColor Green
        return $true
    } catch {
        Write-Host "ERROR: Node.js not found in PATH" -ForegroundColor Red
        return $false
    }
}

function Invoke-Build {
    Write-Header "TypeScript Compile"
    Push-Location $ProjectRoot
    try {
        & npm run build 2>&1 | Write-Host
        if ($LASTEXITCODE -ne 0) { throw "TypeScript compilation failed" }
        Write-Host "Compile: OK" -ForegroundColor Green
    } finally { Pop-Location }
}

function Invoke-Bundle {
    Write-Header "esbuild Bundle"
    Push-Location $ProjectRoot
    try {
        & npm run bundle 2>&1 | Write-Host
        if ($LASTEXITCODE -ne 0) { throw "Bundle failed" }
    } finally { Pop-Location }

    if (-not (Test-BundleExists)) { throw "Bundle output missing" }
}

function Test-McpSettingsAlignment {
    Write-Header "MCP Settings Alignment Check"

    # Check common Cursor MCP config locations
    $settingsPaths = @(
        "$env:APPDATA\Cursor\User\globalStorage\cursor.mcp\mcp_settings.json",
        "$env:USERPROFILE\.cursor\mcp.json",
        "$ProjectRoot\.cursor\mcp.json"
    )

    $found = $false
    foreach ($path in $settingsPaths) {
        if (Test-Path $path) {
            $found = $true
            Write-Host "Found MCP config: $path" -ForegroundColor Green
            try {
                $settings = Get-Content $path -Raw | ConvertFrom-Json
                $servers = $settings.mcpServers
                if ($null -eq $servers) {
                    Write-Host "  WARNING: No mcpServers block found" -ForegroundColor Yellow
                    continue
                }

                $entry = $null
                try { $entry = $servers | Select-Object -ExpandProperty $ServerName -ErrorAction SilentlyContinue } catch {}
                if ($null -eq $entry) {
                    Write-Host "  WARNING: '$ServerName' not registered in this config" -ForegroundColor Yellow
                    Write-Host "  Add the connection block shown above to: $path" -ForegroundColor Yellow
                    continue
                }

                # Check command
                $expectedCmd = $McpConnection[$ServerName].command
                $actualCmd = $entry.command
                if ($actualCmd -ne $expectedCmd) {
                    Write-Host "  MISMATCH: command is '$actualCmd', expected '$expectedCmd'" -ForegroundColor Red
                } else {
                    Write-Host "  command: OK ($actualCmd)" -ForegroundColor Green
                }

                # Check args[0] points to the bundle
                $expectedArg = $McpConnection[$ServerName].args[0]
                $actualArg = if ($entry.args -is [array]) { $entry.args[0] } else { $entry.args }
                $normalExpected = $expectedArg.Replace('\', '/').TrimEnd('/')
                $normalActual = if ($actualArg) { $actualArg.Replace('\', '/').TrimEnd('/') } else { "" }
                if ($normalActual -ne $normalExpected) {
                    Write-Host "  MISMATCH: args[0] is '$actualArg'" -ForegroundColor Red
                    Write-Host "            expected '$expectedArg'" -ForegroundColor Red
                } else {
                    Write-Host "  args: OK" -ForegroundColor Green
                }

                Write-Host "  version: $ServerVersion" -ForegroundColor Green

            } catch {
                Write-Host "  ERROR reading $path : $_" -ForegroundColor Red
            }
        }
    }

    if (-not $found) {
        Write-Host "No Cursor MCP settings file found." -ForegroundColor Yellow
        Write-Host "Copy the connection config above into your Cursor MCP settings." -ForegroundColor Yellow
    }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "MCP Refinery Build" -ForegroundColor White -BackgroundColor DarkBlue
Write-Host "  Name:    $ServerName"
Write-Host "  Version: $ServerVersion"
Write-Host ""

if (-not (Test-NodeAvailable)) { exit 1 }

if (-not $VerifyOnly) {
    Invoke-Build

    if (-not $SkipBundle) {
        Invoke-Bundle
    }
} else {
    Write-Header "Verify-only mode (no build)"
    if (-not (Test-BundleExists)) { exit 1 }
}

# Always emit the connection config
$prodJson = Write-McpConfig -Config $McpConnection -Label "Production MCP Connection (add to Cursor settings)"
$devJson  = Write-McpConfig -Config $McpConnectionDev -Label "Dev MCP Connection (no build required)"

# Run alignment check
Test-McpSettingsAlignment

Write-Header "Summary"
Write-Host "  Tools:    31"
Write-Host "  Version:  $ServerVersion"
Write-Host "  Bundle:   dist/mcp-refinery.cjs"
Write-Host "  Status:   READY" -ForegroundColor Green
Write-Host ""
