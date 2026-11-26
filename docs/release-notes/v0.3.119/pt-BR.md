## Seleção de instância CPA e histórico de uso

- Troque para uma instância CPA externa verificada pela barra lateral e continue usando as mesmas páginas de gerenciamento. Roteamento, chaves de clientes e configurações avançadas passam a valer para o servidor selecionado; se a conexão falhar, o aplicativo não volta sozinho para o CPA integrado.
- A coleta de uso acompanha a instância selecionada. Cada URL externa tem o próprio histórico e as próprias configurações de preço, separados do uso do CPA integrado. Trocar a chave de gerenciamento não muda mais o histórico exibido.

## Acesso à API ACP

- Um relay nativo opcional permite continuar respostas (Responses) e enviar resultados de ferramentas do cliente na sessão ACP original. Ele precisa ser compilado e instalado manualmente e não vem incluído nem ativado nos pacotes do aplicativo. A integração foi verificada no Linux x64.
- Por padrão, as instruções de sistema continuam usando o modo de anexar da CLI. Um perfil opcional as envia uma única vez como contexto comum do primeiro turno. O compartilhamento de contas também é opcional; as continuações ficam na conta original.
