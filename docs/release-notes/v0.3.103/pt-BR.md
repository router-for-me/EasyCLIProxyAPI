- Se tiver dúvidas ou sugestões sobre o software, entre em contato pelo [grupo no QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues), e responderemos o mais rápido possível.

## Melhorias

- **Detecção e inicialização do Codex CLI**: reutiliza o executável e a versão validados em cada operação de detecção ou inicialização, evitando verificações repetidas de versão e mantendo a inicialização alinhada à CLI detectada.

## Correções

- **Seleção do Codex CLI**: prioriza o executável selecionado manualmente, depois `CODEX_CLI_PATH` e, por fim, o PATH e as opções alternativas de instalação da CLI existentes. Pastas privadas da CLI do Desktop não são mais verificadas automaticamente nem podem sobrescrever a instalação de linha de comando.
- **Caminhos inválidos e inicializadores lentos**: relata caminhos explícitos inutilizáveis da CLI em vez de trocar silenciosamente de instalação. No Unix, limpa os processos filhos da verificação de versão para que processos descendentes do inicializador não façam a detecção aguardar além do tempo limite.
