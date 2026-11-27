- Se você tiver dúvidas ou sugestões sobre o aplicativo, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelas [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o quanto antes.

## Melhorias e correções

- Melhorias na exibição de logotipos e ícones de plugins: a lista de plugins instalados, a loja de plugins e a página de login OAuth agora mostram os logotipos fornecidos pelos plugins. Também foi corrigido o caso em que credenciais de terceiros sem ícone próprio recaíam indevidamente no ícone do Gemini (#556).
- Melhorias na correspondência de modelos nos registros de uso: solicitações de modelos com sufixos de nível de raciocínio (como -high ou -low), versões baseadas em data ou identificadores -build deixam de ser marcadas por engano como substituição de modelo (#551).
- Reversão segura das atualizações do aplicativo: as edições portáteis agora esperam o novo núcleo do proxy iniciar com sucesso e ficar pronto antes de remover o backup da versão anterior. Se o novo núcleo não iniciar, a atualização reverte com segurança para manter o aplicativo utilizável (#555).
- Proteção da sincronização de configuração: ao importar ou ler um arquivo mínimo de configuração do núcleo que omite auth-dir ou api-keys, o diretório de credenciais e a lista anotada de chaves de API configurados no aplicativo de desktop são preservados automaticamente, em vez de serem apagados por engano (#553).
- Correções de configuração e de sessão do agente Codex: adicionadas as opções de tamanho da janela de contexto e de esforço de raciocínio para modelos OAuth. Corrigido o problema em que trocar de provedor impedia o Codex Desktop de sincronizar e exibir corretamente as sessões históricas (#552, #554).
