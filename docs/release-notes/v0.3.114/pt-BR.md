Se tiver dúvidas ou sugestões sobre o software, entre em contato pelo [grupo no QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues), e responderemos o mais rápido possível.

## Novidades

- **Importar temas personalizados**: escolha um arquivo ZIP ou uma pasta de tema no seletor de temas. Substituir uma pasta de tema existente exige confirmação.
- **Editar prompts de sistema para agentes compatíveis**: personalize o prompt padrão ou defina substituições por modelo para o ZCode e outros agentes compatíveis. A reescrita de prompts é bloqueada quando o núcleo usa TLS para não rebaixar a conexão para HTTP simples; substituições existentes ainda podem ser removidas.
- **Configurações de suspensão do Antigravity**: o aplicativo de desktop agora inclui o núcleo 8.0.78 e expõe o intervalo de pausa protetora para suspensões por violação dos termos de serviço. Suspensões ativas exibem um link de contestação quando disponível.

## Melhorias

- **Atualizações automáticas fazem parte do cartão Aplicativo de desktop**: os itens de aplicativo e núcleo ficam ocultos até o seletor ser ativado, e uma dica curta explica os downloads em segundo plano e a instalação na próxima inicialização. As atualizações do núcleo continuam configuráveis mesmo quando as atualizações automáticas do aplicativo não estão disponíveis. O comportamento na inicialização permanece inalterado.
- **Acompanhe versões puladas**: ao verificar uma atualização estável, o aplicativo exibe as notas disponíveis das versões puladas junto com as notas mais recentes.
- **Veja de onde vieram e para onde foram as solicitações**: o Roteamento ao vivo agrupa os caminhos registrados por cliente, modelo e credencial e permite fixar uma solicitação concluída recente para inspeção. A Afinidade de sessão também ganhou a opção “Nunca revincular” para manter uma sessão estabelecida na sua credencial original.
- **Revise e edite preços de modelos com mais facilidade**: cartões pesquisáveis mostram preços manuais, sincronizados e sem preço, além de quantas solicitações têm cobertura de preços. Um painel lateral edita tarifas por milhão de tokens, e a sincronização de preços permite escolher quais modelos atualizar.
- **Veja por que um agente não pode conectar**: a ação de conexão desativada agora explica os impedimentos, como mapeamentos de modelos ausentes ou plataforma sem suporte.

## Correções

- **O histórico de suspensão de credenciais sobrevive a reinicializações**: suspensões anteriores do Antigravity podem ser diferenciadas das ativas, e detalhes extensos são exibidos separadamente em vez de sobrecarregar o selo de status.
