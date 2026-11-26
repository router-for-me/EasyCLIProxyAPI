- Se tiver dúvidas ou sugestões sobre o aplicativo, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o mais rápido possível.

## Novidades

- Adicionada a atualização manual de credenciais OAuth nos detalhes da credencial e um diálogo de gerenciamento em lote. Selecione as credenciais filtradas para atualizá-las, ativá-las, desativá-las ou excluí-las, com o resultado de cada operação.
- Adicionada a atualização, em todo o servidor, de todas as credenciais elegíveis, independentemente do filtro atual.
- Adicionada uma seção recolhida de Políticas de requisições nas configurações da credencial, para novas tentativas e regras de tratamento de erros por credencial, com uma opção para restaurar as configurações herdadas.
- Adicionada uma configuração da credencial xAI para alternar entre a API oficial e o chat-proxy do Grok CLI.

## Melhorias

- Adicionado o filtro Problemas à lista de credenciais, e a busca passou a incluir observações e prefixos de modelo.
- Unificado o reconhecimento de cota de plugins entre o gerenciamento de credenciais e as páginas de cota, incluindo janelas de cota, horários de redefinição, planos e resumos fornecidos pelo provedor, como saldos.
- Adicionadas a atualização individual e a atualização em lote da cota de plugins, compatibilidade com núcleos antigos que omitem IDs de plugins e consultas simultâneas de plugins compartilhadas. Os provedores integrados mantêm prioridade nas consultas de cota que já existiam.
- Preservado o layout atual da lista de credenciais, com as novas ações nos detalhes, nas configurações e no diálogo de gerenciamento em lote.

## Correções

- Corrigida a exclusão de credenciais de plugins da página Consulta de cotas. Credenciais Gemini e outras com cota fornecida por plugin agora podem aparecer e consultar cotas.
- Incluídos os índices das credenciais nas solicitações de ativar e desativar, para distinguir credenciais com o mesmo nome de arquivo.
- Ampliados os tempos limite das solicitações de atualização de credenciais, para reduzir falhas prematuras durante a atualização em lote.

## Notas de uso

- Atualizar credenciais atualiza as credenciais de autenticação; não redefine as cotas. Atualizar todas as credenciais pode levar vários minutos.
- O login OAuth comum do Gemini, por si só, não oferece consulta de cotas. A disponibilidade depende do suporte a cotas do backend e dos plugins.
