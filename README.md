# Duckycut

Extensao CEP para Adobe Premiere Pro que detecta silencio com FFmpeg e aplica cortes na timeline do Premiere. Inspirado no fireCut.

## Requisitos

- Adobe Premiere Pro com suporte a CEP (`PPRO 14+`).
- Preset WAV disponivel no Premiere/MediaCore para renderizar o mixdown WAV da sequencia.
- FFmpeg disponivel no `PATH`.
- Node.js disponivel no `PATH` para o fallback externo do VAD, instalar em modo desenvolvimento e rodar testes.
- Windows para o instalador `.exe` gerado com Inno Setup.

## Instalar via .exe no Windows

Baixe ou gere `dist/installer/DuckycutSetup.exe` e avance no instalador. Ele copia a extensao CEP para:

```text
%APPDATA%\Adobe\CEP\extensions\com.duckycut.panel
```

O instalador usa copia real dos arquivos, sem junction ou symlink. Ele tambem habilita extensoes CEP unsigned nas chaves `HKCU\SOFTWARE\Adobe\CSXS.9` ate `CSXS.13`, configurando `PlayerDebugMode=1`.

Se ja existir um junction/symlink criado por `npm run install-extension`, o instalador remove esse link antes de copiar os arquivos reais. Isso evita o erro do Windows `CreateFile falhou; codigo 448` durante a instalacao.

Ao final, o instalador executa uma checagem local e informa se algo externo esta faltando:

- FFmpeg no `PATH`.
- Node.js no `PATH`.
- pasta CEP em `%APPDATA%\Adobe\CEP\extensions`.
- arquivos obrigatorios do Duckycut no destino instalado.
- dependencia `onnxruntime-node` no payload instalado.

FFmpeg e Node.js nao sao instalados automaticamente nesta primeira versao. Se algum deles faltar, instale manualmente, reinicie o Premiere e abra `Window > Extensions > Duckycut`.

## Gerar o instalador

Prepare o payload:

```bash
npm run release:prepare
```

Gerar o `.exe`:

```powershell
npm run release:installer
```

Esse comando cria `dist/release-payload` e chama o compilador do Inno Setup (`ISCC.exe`). Se o Inno Setup nao estiver instalado, o script para com uma mensagem clara. Instale com:

```powershell
winget install JRSoftware.InnoSetup
```

Depois rode `npm run release:installer` novamente. O arquivo final esperado e:

```text
dist/installer/DuckycutSetup.exe
```

## Instalar Em Desenvolvimento

```bash
npm run install-extension
```

Esse fluxo continua criando um junction/symlink para facilitar desenvolvimento local. Para instalacao de usuario final, use o `.exe`, porque ele copia os arquivos para a pasta CEP.

No Windows, habilite extensoes CEP sem assinatura criando `PlayerDebugMode=1` em `HKEY_CURRENT_USER\SOFTWARE\Adobe\CSXS.11`, reinicie o Premiere e abra `Window > Extensions > Duckycut`. O instalador `.exe` ja faz isso para CSXS 9, 10, 11, 12 e 13.

## Uso Basico

1. Abra uma sequencia no Premiere.
2. Selecione as tracks de áudio que entram na análise.
3. Clique `Analyze` para renderizar um WAV pelo Premiere.
4. Ajuste as configurações manuais na tela seguinte.
5. Clique `Apply Cuts`; nesse momento o FFmpeg detecta silêncios com a configuração atual e, em seguida, aplica os cortes in-place.

O `Analyze` usa `exportAsMediaDirect()` como caminho principal: antes do render, o host tenta mutar as tracks nao selecionadas e desmutar as selecionadas; depois sempre restaura os mutes originais. Em `Full Sequence`, o export usa `workAreaType=0`. Em `Range: In-Out`, usa `workAreaType=1`. O `silencedetect` roda depois, no clique de `Apply Cuts`, usando o WAV ja renderizado e os sliders atuais.

## Testes

```bash
npm test
```

Para validar apenas o payload de release:

```bash
npm run release:prepare
```

Os testes automatizados cobrem matematica de timecode, zeroPoint, cut zones e o caminho de export direto via Premiere. Smoke tests reais ainda precisam rodar no Premiere, porque CEP, QE DOM e `exportAsMediaDirect` dependem do aplicativo Adobe.

## Troubleshooting

- `FFmpeg was not found on PATH`: instale FFmpeg e confirme `ffmpeg -version` em um novo terminal.
- `Node.js was not found on PATH`: instale Node.js LTS e confirme `node -v` em um novo terminal.
- Duckycut nao aparece em `Window > Extensions`: reinicie o Premiere depois da instalacao e confirme que a pasta `%APPDATA%\Adobe\CEP\extensions\com.duckycut.panel` existe.
- `CreateFile falhou; codigo 448`: gere novamente o instalador com a versao atual. O instalador agora remove o junction de desenvolvimento antes de copiar a instalacao real.
- VAD falha com dependencia nativa ausente: gere o instalador depois de rodar `npm install`, para que `node_modules/onnxruntime-node` entre no payload.
- Inno Setup ausente ao gerar o instalador: instale com `winget install JRSoftware.InnoSetup`.

## Smoke Test Manual Minimo

Validar quatro sequencias no Premiere:

| Seq | FPS | Drop-frame | ZeroPoint | Esperado |
|-----|-----|------------|-----------|----------|
| A | 25 | n/a | `00:00:00:00` | cortes com erro <= 1 frame |
| B | 29.97 | nao | `00:00:00:00` | timecode NDF com `:` |
| C | 29.97 | sim | `00:00:00:00` | sem drift por minuto, timecode com `;` |
| D | 29.97 | sim | `01:00:00:00` | razor no offset de 1h, nao em 0h |
