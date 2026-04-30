# Duckycut

Extensao CEP para Adobe Premiere Pro que detecta silencio com FFmpeg e aplica cortes na timeline do Premiere. Inspirado no fireCut.

## Requisitos

- Adobe Premiere Pro com suporte a CEP (`PPRO 14+`).
- Adobe Media Encoder instalado para renderizar o mixdown WAV da sequencia.
- FFmpeg disponivel no `PATH`.
- Node.js para instalar a extensao em modo desenvolvimento e rodar testes.

## Instalar Em Desenvolvimento

```bash
npm run install-extension
```

No Windows, habilite extensoes CEP sem assinatura criando `PlayerDebugMode=1` em `HKEY_CURRENT_USER\SOFTWARE\Adobe\CSXS.11`, reinicie o Premiere e abra `Window > Extensions > Duckycut`.

## Uso Basico

1. Abra uma sequencia no Premiere.
2. Selecione as tracks de audio que entram na analise.
3. Clique `Auto Detect` para calibrar volume.
4. Clique `Analyze` para detectar silencios.
5. Clique `Apply Cuts` para aplicar os cortes in-place quando `Delete Silence` estiver ativo.

## Testes

```bash
npm test
```

Os testes automatizados cobrem matematica de timecode, zeroPoint e cut zones. Smoke tests reais ainda precisam rodar no Premiere, porque CEP, QE DOM e AME dependem do aplicativo Adobe.

## Smoke Test Manual Minimo

Validar quatro sequencias no Premiere:

| Seq | FPS | Drop-frame | ZeroPoint | Esperado |
|-----|-----|------------|-----------|----------|
| A | 25 | n/a | `00:00:00:00` | cortes com erro <= 1 frame |
| B | 29.97 | nao | `00:00:00:00` | timecode NDF com `:` |
| C | 29.97 | sim | `00:00:00:00` | sem drift por minuto, timecode com `;` |
| D | 29.97 | sim | `01:00:00:00` | razor no offset de 1h, nao em 0h |
