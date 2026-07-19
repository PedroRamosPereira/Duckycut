#define MyAppName "Duckycut"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Duckycut"
#define MyAppId "{{A8FB1E92-19B5-4F7D-B6B8-D0C4C0700010}"
#define FFmpegUrl "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
#define NodeUrl "https://nodejs.org/dist/v22.12.0/node-v22.12.0-win-x64.zip"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={userappdata}\Adobe\CEP\extensions\com.duckycut.panel
DisableDirPage=yes
DisableProgramGroupPage=yes
OutputDir=..\dist\installer
OutputBaseFilename=DuckycutSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
UninstallDisplayName={#MyAppName}

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\dist\release-payload\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "scripts\enable-cep-debug.ps1"; DestDir: "{app}\installer\scripts"; Flags: ignoreversion
Source: "scripts\check-dependencies.ps1"; DestDir: "{app}\installer\scripts"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "SOFTWARE\Adobe\CSXS.9"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "SOFTWARE\Adobe\CSXS.10"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "SOFTWARE\Adobe\CSXS.11"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "SOFTWARE\Adobe\CSXS.12"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "SOFTWARE\Adobe\CSXS.13"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue

[UninstallDelete]
Type: filesandordirs; Name: "{app}\bin"

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\scripts\enable-cep-debug.ps1"""; Flags: runhidden waituntilterminated

[Code]
var
  DependencyReport: String;
  DownloadPage: TDownloadWizardPage;
  NeedFFmpeg, NeedNode: Boolean;
  DownloadWarning: String;

function ReadReportFile(Path: String): String;
var
  Lines: TArrayOfString;
  I: Integer;
begin
  Result := '';
  if LoadStringsFromFile(Path, Lines) then
  begin
    for I := 0 to GetArrayLength(Lines) - 1 do
    begin
      if Result <> '' then
        Result := Result + #13#10;
      Result := Result + Lines[I];
    end;
  end;
end;

function PsSingleQuote(Value: String): String;
begin
  Result := Value;
  StringChangeEx(Result, '''', '''''', True);
end;

function RemoveExistingDevelopmentJunction(): String;
var
  ResultCode: Integer;
  TargetPath: String;
  Command: String;
begin
  Result := '';
  TargetPath := ExpandConstant('{app}');
  Command :=
    '$p = ''' + PsSingleQuote(TargetPath) + '''; ' +
    'if (Test-Path -LiteralPath $p) { ' +
    '  $item = Get-Item -LiteralPath $p -Force; ' +
    '  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { ' +
    '    Remove-Item -LiteralPath $p -Force; ' +
    '  } ' +
    '}';

  if not Exec(
    'powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -Command "' + Command + '"',
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  ) then
  begin
    Result := 'Nao foi possivel verificar a instalacao de desenvolvimento existente do Duckycut.';
    Exit;
  end;

  if ResultCode <> 0 then
  begin
    Result := 'Nao foi possivel remover o junction/symlink de desenvolvimento existente em ' + TargetPath + '. Feche o Premiere e remova essa pasta antes de instalar.';
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := RemoveExistingDevelopmentJunction();
end;

function IsToolOnPath(const ToolName: String): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec('cmd.exe', '/c where.exe ' + ToolName + ' >nul 2>&1', '',
    SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

procedure InitializeWizard;
begin
  DownloadPage := CreateDownloadPage(SetupMessage(msgWizardPreparing),
    'Baixando FFmpeg e Node.js para o Duckycut...', nil);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = wpReady then
  begin
    NeedFFmpeg := not IsToolOnPath('ffmpeg');
    NeedNode := not IsToolOnPath('node');
    if NeedFFmpeg or NeedNode then
    begin
      DownloadPage.Clear;
      if NeedFFmpeg then
        DownloadPage.Add('{#FFmpegUrl}', 'ffmpeg.zip', '');
      if NeedNode then
        DownloadPage.Add('{#NodeUrl}', 'node.zip', '');
      DownloadPage.Show;
      try
        try
          DownloadPage.Download;
        except
          DownloadWarning :=
            'Nao foi possivel baixar FFmpeg/Node.js (sem internet?). ' +
            'A instalacao continuou; instale manualmente e coloque no PATH.';
        end;
      finally
        DownloadPage.Hide;
      end;
    end;
  end;
end;

function ExtractToolFromZip(const ZipName, ExeName: String): Boolean;
var
  ResultCode: Integer;
  Command: String;
begin
  Command :=
    '$zip = ''' + PsSingleQuote(ExpandConstant('{tmp}\' + ZipName)) + '''; ' +
    '$dest = ''' + PsSingleQuote(ExpandConstant('{tmp}\extract_' + ZipName)) + '''; ' +
    '$bin = ''' + PsSingleQuote(ExpandConstant('{app}\bin')) + '''; ' +
    'Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force; ' +
    '$exe = Get-ChildItem -LiteralPath $dest -Recurse -Filter ''' + ExeName + ''' | Select-Object -First 1; ' +
    'if (-not $exe) { exit 1 }; ' +
    'New-Item -ItemType Directory -Force -Path $bin | Out-Null; ' +
    'Copy-Item -LiteralPath $exe.FullName -Destination (Join-Path $bin ''' + ExeName + ''') -Force';

  Result := Exec('powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -Command "' + Command + '"', '',
    SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  ReportPath: String;
begin
  if CurStep = ssPostInstall then
  begin
    if NeedFFmpeg and FileExists(ExpandConstant('{tmp}\ffmpeg.zip')) then
      if not ExtractToolFromZip('ffmpeg.zip', 'ffmpeg.exe') then
        DownloadWarning := DownloadWarning + #13#10 +
          'FFmpeg foi baixado mas nao pode ser extraido para a pasta bin do Duckycut.';
    if NeedNode and FileExists(ExpandConstant('{tmp}\node.zip')) then
      if not ExtractToolFromZip('node.zip', 'node.exe') then
        DownloadWarning := DownloadWarning + #13#10 +
          'Node.js foi baixado mas nao pode ser extraido para a pasta bin do Duckycut.';
    ReportPath := ExpandConstant('{tmp}\duckycut-dependency-report.txt');
    Exec(
      'powershell.exe',
      '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\installer\scripts\check-dependencies.ps1') + '" -InstallDir "' + ExpandConstant('{app}') + '" -ReportPath "' + ReportPath + '"',
      '',
      SW_HIDE,
      ewWaitUntilTerminated,
      ResultCode
    );
    DependencyReport := ReadReportFile(ReportPath);
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
var
  FinalReport: String;
begin
  if CurPageID = wpFinished then
  begin
    FinalReport := DependencyReport;
    if DownloadWarning <> '' then
      FinalReport := Trim(DownloadWarning + #13#10#13#10 + FinalReport);
    if FinalReport <> '' then
      MsgBox(FinalReport, mbInformation, MB_OK);
  end;
end;
