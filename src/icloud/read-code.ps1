param([Parameter(Mandatory=$true)][int]$HelperProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
# Only inspect the helper started for this connection, never other iCloud/browser windows.
$processCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $HelperProcessId)
$deadline = [DateTime]::UtcNow.AddSeconds(15)
while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Get-Process -Id $HelperProcessId -ErrorAction SilentlyContinue)) { exit 1 }
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $processCondition)
    foreach ($window in $windows) {
        foreach ($element in $window.FindAll([System.Windows.Automation.TreeScope]::Subtree, [System.Windows.Automation.Condition]::TrueCondition)) {
            if ($element.Current.AutomationId -eq '1001') {
                $value = $element.Current.Name -replace '[^0-9]', ''
                if ($value -match '^\d{6}$') { [Console]::Out.Write($value); exit 0 }
            }
        }
    }
    Start-Sleep -Milliseconds 150
}
exit 1
