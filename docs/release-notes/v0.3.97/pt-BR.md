- Se tiver dúvidas ou sugestões sobre o software, entre em contato pelo [grupo no QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues), e responderemos o mais rápido possível.

## Correções

- **O assistente de atualização do macOS não é mais encerrado**: ao fechar o aplicativo para iniciar uma atualização no macOS, o assistente de atualização agora é executado em seu próprio grupo de processos, evitando que a limpeza do sistema ao encerrar a interface o derrube; assim, a atualização termina e o aplicativo reinicia normalmente.
- **Atualizações somente do aplicativo no macOS mantêm o núcleo em execução**: quando apenas o aplicativo precisa ser atualizado, o processo do núcleo em execução não é mais encerrado e continua atendendo após a atualização. O comportamento normal de encerramento permanece inalterado.
