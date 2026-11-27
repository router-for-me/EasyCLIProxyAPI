- Se você tiver dúvidas ou sugestões sobre o software, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelas [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o quanto antes.

## Melhorias

- **Um único conjunto de regras para provedores e credenciais**: as exclusões de modelos não são mais contabilizadas por arquivo de credencial. As regras no nível do provedor e no nível da credencial são tratadas no mesmo salvamento e não se sobrescrevem mais.
- **O salvamento pode sincronizar com todas as credenciais de um provedor**: salvar exclusões no nível do provedor grava-as em todos os arquivos de credencial desse provedor, e o diálogo avisa que este salvamento vai sincronizar, para que não seja mais preciso editar os arquivos um a um.
- **Modelos excluídos por uma regra de provedor ficam claramente identificados**: as entradas bloqueadas por regras de provedor mostram a regra que correspondeu, então fica evidente se é preciso ajustar a regra da credencial ou a do provedor.
