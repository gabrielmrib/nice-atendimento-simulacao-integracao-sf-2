# Especificação — Transbordo de WhatsApp de campanhas para atendente NICE CXone via barramento Betta Tech

| | |
|---|---|
| **Status** | Proposta para validação (v0.1) |
| **Data** | 11/11/2026 |
| **Escopo** | Arquitetura alvo + simulador (este repositório) |
| **Envolvidos** | Time Salesforce, Betta Tech (barramento), NICE CXone, owner da conta WhatsApp Business (Meta) |

---

## 1. Problema

A empresa usa um número de WhatsApp **apenas para disparos promocionais em massa**. Quando um cliente responde à campanha com uma dúvida, não há quem atenda nesse número.

**Objetivo:** permitir que o cliente peça ajuda **no mesmo número da campanha** e seja atendido por um **atendente humano na NICE CXone**, com a Betta Tech como barramento e a Salesforce decidindo o roteamento.

### Restrições
1. **Não há licenças Salesforce para atendentes**: ninguém atende pelo Service Console.
2. Todo o atendimento humano acontece na **NICE CXone**, sempre passando pela **Betta Tech**.
3. O número deve ser o **mesmo** usado nas campanhas.

---

## 2. O que foi verificado (fatos que direcionam a solução)

Itens marcados com 🔬 foram testados diretamente na sandbox `dev0` via API. Os demais vêm da documentação, listada nas Referências.

| # | Fato | Impacto |
|---|---|---|
| F1 🔬 | `MessagingSession.Status` vem com `updateable = false` e não tem nenhum registro em FieldPermissions. É controlado pela plataforma e só muda quando um **AgentWork é aceito por um usuário Salesforce** no Omni-Channel. | Um sistema externo **não consegue "ativar"** uma sessão. O `PATCH Status=Active` do simulador sempre falha (`INVALID_FIELD_FOR_INSERT_UPDATE`). |
| F2 🔬 | A ação `sendConversationMessages` é *"Sends a messaging component to users in enhanced Messaging channels like WhatsApp"*. Entradas obrigatórias: `messageDefinitionName`, `messagingEndUserIds`, `requestType=SendNotificationMessages`, `allowedSessionStatus`, `isEnforceMessagingChannelConsent`. | É a ação de **disparo de notificação/campanha** com template. **Não** serve para um atendente responder em texto livre numa conversa. |
| F3 🔬 | A sandbox tem dois canais `MessagingChannel` do tipo **WhatsApp** (Enhanced, inativos) e um canal Web (EmbeddedMessaging). | Os disparos provavelmente usam o **WhatsApp nativo da Salesforce**, que é hoje o dono do número na Meta. |
| F4 🔬 | A fila "Fila External Betta" usa `QueueRoutingConfig` com `RoutingModel = ExternalRouting`. | O External Routing **terceiriza a decisão** de roteamento, mas o trabalho ainda precisa ser entregue (`AgentWork`) a um **usuário Salesforce**. |
| F5 | O Partner Contact Center Messaging (antigo *Bring Your Own Channel for CCaaS*) faz o caminho oposto: o canal e o roteamento ficam no parceiro, e o **atendente fica na Salesforce**. As mensagens do atendente saem por Pub/Sub para o parceiro entregar. | Também exige atendente licenciado na Salesforce, então **não atende** à restrição 1. |
| F6 | Não foi encontrada nenhuma API pública para um **atendente externo, sem licença**, enviar mensagens numa sessão Enhanced WhatsApp da Salesforce. | Com o número "dentro" da Salesforce, a NICE **não tem como responder** de forma suportada. |
| F7 | **Meta, novo modelo de contas WhatsApp:** *"A business phone number can be associated with multiple Messaging accounts."* Cada parceiro tem sua própria Messaging Account (templates, billing e webhooks separados). GA em **23/09/2026**, liberado para todas as empresas até meados de out/2026. | Abre a possibilidade de **dois parceiros no mesmo número**: Salesforce para campanhas, Betta para atendimento. |
| F8 | A documentação da Meta **não explica** como uma mensagem *recebida* do cliente é entregue quando há vários parceiros no número: se vai para todos os webhooks, se existe dono da conversa ou handover. Ela só garante que *"Existing conversations are uninterrupted when new partners are added"*. Templates **não** são compartilhados entre Messaging Accounts. Throughput e limite de mensagens são **compartilhados**. | **Ponto crítico a validar com a Meta ou o BSP** antes de adotar a Opção A. |
| F9 | Na documentação da NICE (CXone Agent for Salesforce), o WhatsApp suporta **resposta** a clientes, mas **não** WhatsApp **proativo**. As integrações nativas NICE↔Salesforce partem do princípio de que o agente usa o console da Salesforce. | Confirma que a integração "de prateleira" não resolve este cenário. O caminho é a Betta usar a integração de canal que já tem com a NICE. |

### Conclusão
**Enquanto o número estiver conectado só à Salesforce, não há caminho suportado para um atendente NICE sem licença responder.** A solução precisa que a **Betta também receba e envie mensagens do número diretamente na Meta**. A Salesforce continua sendo **o cérebro**: guarda o contexto da campanha e do cliente, decide o roteamento e registra a conversa. Ela deixa de ser o **transporte** das mensagens de atendimento.

---

## 3. Opções avaliadas

| Opção | Como funciona | Mesmo número | Sem licença de atendente | Suportado | Veredito |
|---|---|---|---|---|---|
| **A. Multi-parceiro Meta** | O número fica com 2 Messaging Accounts: **Salesforce** (campanhas) e **Betta** (atendimento). A Betta recebe a resposta do cliente, consulta a Salesforce para rotear e conversa via NICE. | ✅ | ✅ | ⚠️ Depende de F8 | **Recomendada, condicionada à validação de F8** |
| **B. Betta dona única do número** | O número migra para a Betta (Cloud API). As campanhas disparadas pela Salesforce passam a sair via API da Betta, não pelo WhatsApp nativo. A Salesforce segue decidindo o roteamento e registrando. | ✅ | ✅ | ✅ | **Plano B**: totalmente viável, mas exige refazer o disparo das campanhas |
| C. Partner Contact Center Messaging | Canal no parceiro, atendente na Salesforce. | ✅ | ❌ | ✅ | Descartada (restrição 1) |
| D. "Agente-proxy" na Salesforce | 1 usuário licenciado recebe todas as sessões (auto-aceite) e um componente no console repassa as mensagens para a NICE. | ✅ | ⚠️ | ❌ | **Descartada**: frágil (precisa de navegador aberto) e com alto risco de violar o licenciamento (um usuário servindo vários humanos) |
| E. Webhook HTTP + `PATCH`/`sendConversationMessages` (simulador atual) | — | — | — | ❌ (F1, F2) | Descartada: tecnicamente impossível |

---

## 4. Arquitetura alvo (Opções A e B — o fluxo de atendimento é o mesmo)

```
                 (campanhas — inalterado na Opção A)
 Salesforce ──── sendConversationMessages ────► Meta WhatsApp ───► Cliente
     ▲  │                                          ▲      │
     │  │ Pub/Sub: CampaignContext__e               │      │ resposta do cliente
     │  ▼                                          │      ▼
     │  Betta Tech (barramento)  ◄── webhook ──────┘  (Messaging Account Betta)
     │    │   ▲
     │    │   └── envio de mensagens do atendente (Cloud API)
     │    ▼
     │  NICE CXone (canal digital da Betta) ◄──► Atendente
     │
     └── REST: decisão de roteamento (Flow) + registro da conversa
```

### 4.1 Responsabilidades

| Componente | Responsabilidade |
|---|---|
| **Salesforce** | (1) Dispara as campanhas, como hoje. (2) Publica o **contexto da campanha** por cliente (Pub/Sub). (3) Expõe a **decisão de roteamento** como um Flow autolançado chamado via REST: recebe telefone e texto, devolve fila/skill da NICE, dados do cliente e campanha de origem. (4) Recebe o **registro da conversa** (início, transcrição e fim) para histórico do cliente. |
| **Betta Tech** | (1) Recebe os webhooks da Meta da sua Messaging Account. (2) Identifica se é a resposta de um cliente impactado por campanha. (3) Chama a decisão de roteamento na Salesforce. (4) Abre o contato no canal digital da NICE com a fila/skill e o contexto. (5) Repassa as mensagens nos dois sentidos (Meta ↔ NICE). (6) Controla a **janela de 24h** e, fora dela, usa template aprovado na **sua** Messaging Account (F8: templates não são compartilhados). (7) Envia os eventos de conversa para a Salesforce. |
| **NICE CXone** | Fila, ACD e desktop do atendente. Recebe os contatos pelo canal digital da Betta, que já é usado no atendimento atual. |
| **Meta** | Número único com 2 Messaging Accounts (Opção A) ou 1 Messaging Account da Betta (Opção B). |

### 4.2 Sequência — cliente responde à campanha e é atendido

1. A Salesforce dispara a campanha (`sendConversationMessages`) e publica `CampaignContext__e` (telefone, campanha, ID do cliente, validade).
2. A Betta consome `CampaignContext__e` via **Pub/Sub API** e guarda o contexto por telefone, com TTL.
3. O cliente responde no WhatsApp. A Meta entrega o webhook à Betta (**ver F8**).
4. A Betta chama a Salesforce em `POST /services/data/vXX.X/actions/custom/flow/Rotear_Atendimento_WhatsApp` com `{ telefone, mensagem, campanhaId? }`.
5. O Flow devolve `{ acao: "ATENDIMENTO_HUMANO" | "IGNORAR" | "BOT", filaNice, skill, cliente: {...}, campanha: {...} }`.
6. A Betta abre o contato na NICE com essa fila/skill e o contexto, e envia a primeira mensagem do cliente.
7. As mensagens seguem **Cliente ↔ Meta ↔ Betta ↔ NICE**. A Salesforce **não** fica no caminho de cada mensagem.
8. A cada evento relevante (abertura, mensagem, encerramento), a Betta registra na Salesforce, por REST em lote ou publicando `NiceConversationEvent__e`.
9. No encerramento, o Flow da Salesforce consolida a transcrição no registro do cliente (Task/objeto customizado).

### 4.3 Contratos

**`CampaignContext__e`** (Platform Event, Salesforce → Betta via Pub/Sub)

| Campo | Tipo | Descrição |
|---|---|---|
| `Phone__c` | Text(20) | Telefone E.164 do destinatário |
| `CampaignId__c` | Text(18) | Campanha de origem |
| `CustomerId__c` | Text(18) | Account/Contact/Lead |
| `ExpiresAt__c` | DateTime | Fim da elegibilidade para transbordo |
| `Payload__c` | Long Text | JSON livre (CPF mascarado, produto, etc.) |

**`NiceConversationEvent__e`** (Platform Event, Betta → Salesforce; publicado pela Betta via Pub/Sub ou REST)

| Campo | Tipo | Descrição |
|---|---|---|
| `Action__c` | Text(40) | `OPEN_CONVERSATION`, `SEND_MESSAGE`, `AGENT_MESSAGE`, `CLOSE_CONVERSATION` |
| `ConversationKey__c` | Text(80) | ID do contato na NICE/Betta |
| `Phone__c` | Text(20) | Telefone do cliente |
| `Message__c` | Long Text | Texto (opcional) |
| `Payload__c` | Long Text | JSON (agente, fila, tags, motivo de encerramento) |

> O simulador atual já assina `/event/NICE_Conversation_Event__e` via Pub/Sub. Na nova arquitetura, esse evento passa a ser o **registro** da conversa, e não o gatilho para a NICE responder.

**Flow `Rotear_Atendimento_WhatsApp`** (autolançado, chamado via REST pela Betta)
- Entrada: `telefone` (Text), `mensagem` (Text), `campanhaId` (Text, opcional)
- Saída: `acao`, `filaNice`, `skill`, `clienteJson`
- Autenticação: OAuth 2.0 Client Credentials (External Client App, usuário de integração com acesso só ao Flow e aos objetos necessários).

---

## 5. Pontos críticos a validar (bloqueiam a decisão A × B)

| # | Pergunta | Com quem |
|---|---|---|
| V1 | No modelo multi-Messaging Account, **para qual parceiro vai o webhook de uma mensagem recebida?** Para todos? Existe dono da conversa ou handover? (F8) | Meta / BSP / Salesforce |
| V2 | Se ambos receberem: dá para **desligar o processamento de entrada** no canal Enhanced WhatsApp da Salesforce (canal só de saída), para não abrir uma MessagingSession em paralelo? | Salesforce |
| V3 | O canal Enhanced WhatsApp da Salesforce já está no novo modelo de contas, e **a Salesforce aceita outro parceiro no mesmo número**? | Salesforce / Meta |
| V4 | A Betta é (ou pode ser) **Tech Provider/BSP** com Messaging Account própria na Meta? | Betta |
| V5 | Qual API a Betta usa hoje para criar contatos digitais na NICE (canal customizado do Digital Engagement)? Ela suporta abrir contato com fila/skill e contexto? | Betta / NICE |
| V6 | Os disparos em massa saem mesmo do Enhanced WhatsApp da Service Cloud ou de outra ferramenta (ex.: Marketing Cloud)? (F3 sugere Service Cloud) | Time de campanhas |
| V7 | Throughput e limite de mensagens são **compartilhados** entre os parceiros (F8). Uma campanha grande vai disputar capacidade com o atendimento? | Meta / time de campanhas |

**Decisão:** se V1–V3 forem favoráveis, segue a **Opção A**. Caso contrário, a **Opção B**, com as campanhas passando a ser disparadas pela Salesforce *através* da API da Betta (o Flow ou Marketing Cloud chama a Betta, que envia o template).

---

## 6. Escopo do simulador (este repositório)

O simulador passa a representar **Betta + NICE**, e o canal de entrada passa a ser um **WhatsApp simulado**. Hoje a entrada é o MIAW Web, que não representa o cenário real.

| Item | Situação atual | Mudança |
|---|---|---|
| Entrada do cliente | Omni Flow do canal Web → webhook/Pub/Sub | Novo `POST /api/meta/webhook` no **formato do webhook do WhatsApp Cloud API**, mais uma tela "Celular do cliente" para simular as mensagens |
| Roteamento | Route Work para fila External Routing | Chamada REST ao Flow `Rotear_Atendimento_WhatsApp` (decisão da Salesforce) |
| Contexto de campanha | — | Assinar `/event/CampaignContext__e` via Pub/Sub (reaproveita o cliente Pub/Sub já implementado) |
| Aceite (`/api/agent/accept`) | `PATCH MessagingSession.Status` (impossível, F1) | Só local (estado NICE) + evento `OPEN_CONVERSATION` para a Salesforce |
| Resposta (`/api/agent/reply`) | `sendConversationMessages` (uso incorreto, F2) | Envio para a "Meta simulada" (aparece no celular do cliente) + evento `AGENT_MESSAGE` para a Salesforce |
| Encerramento (`/api/agent/close`) | `PATCH Status=Ended` (impossível) | Local + evento `CLOSE_CONVERSATION` |
| Janela de 24h | — | Bloquear texto livre fora da janela e exigir template |
| Front NICE (3 colunas) | Mantido | Mantido; a ficha passa a mostrar a campanha de origem |

### Critérios de aceite do simulador
1. Uma mensagem simulada do cliente para um telefone com `CampaignContext__e` recebido cria um card na fila NICE com os dados da campanha.
2. A fila/skill exibida é a devolvida pelo Flow da Salesforce.
3. A resposta do atendente aparece no "celular do cliente" e gera `AGENT_MESSAGE` na Salesforce.
4. O encerramento gera `CLOSE_CONVERSATION`, e a Salesforce registra a transcrição.
5. Nenhuma chamada tenta alterar `MessagingSession.Status` nem usa `sendConversationMessages` para resposta.

---

## 7. Riscos

| Risco | Mitigação |
|---|---|
| V1 desfavorável (webhook só para um parceiro) | Opção B |
| Dupla resposta (Salesforce e Betta tratando a mesma mensagem) | V2: canal Salesforce só de saída; desligar o Omni Flow de entrada desse canal |
| Templates de atendimento precisam existir na Messaging Account da Betta | Cadastrar e aprovar templates de retomada de conversa na conta da Betta |
| Capacidade compartilhada do número | Agendar campanhas grandes fora do pico de atendimento; monitorar limite |
| Recurso da Meta ainda em rollout (*"subject to change"*) | Fazer piloto com um número de teste antes do número de produção |
| LGPD: dados do cliente trafegando entre Salesforce, Betta e NICE | Minimizar o payload (CPF mascarado), definir TTL do contexto, registrar base legal |

---

## Referências

**Verificado na sandbox (API REST, 10–11/11/2026):** describe de `MessagingSession`, `AgentWork` e da ação `sendConversationMessages`; consultas a `MessagingChannel`, `QueueRoutingConfig`, `PendingServiceRouting`, `PresenceUserConfig`, `FieldPermissions`.

**Meta**
- [Updates to WhatsApp Business accounts (account model evolution)](https://developers.facebook.com/documentation/business-messaging/whatsapp/account-model-evolution/)
- [Managing messaging accounts](https://developers.facebook.com/documentation/business-messaging/whatsapp/account-model-evolution/messaging/)
- [Client phone numbers (Solution Providers)](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/manage-phone-numbers)
- [WhatsApp Multiple Providers: What Changes in September (BotSense, secundária)](https://botsense.io/blog/whatsapp-multiple-providers-account-model-change/)

**Salesforce**
- [Send Conversation Messages Actions](https://developer.salesforce.com/docs/atlas.en-us.api_action.meta/api_action/actions_obj_send_conversation_messages.htm)
- [Create AgentWork Records for External Routing](https://developer.salesforce.com/docs/atlas.en-us.omni_channel_dev.meta/omni_channel_dev/omnichannel_external_routing_create_agentwork.htm)
- [Integrate Your Routing Implementation (External Routing)](https://developer.salesforce.com/docs/atlas.en-us.omni_channel_dev.meta/omni_channel_dev/omnichannel_external_routing_integrate.htm)
- [Bring Your Own Channel for CCaaS — Outbound Event Reference](https://developer.salesforce.com/docs/service/messaging-byoc-ccaas/references/byoc-ccaas-outbound-event-reference/outbound-event-reference.html)
- [Enable Bring Your Own Channel for CCaaS](https://developer.salesforce.com/docs/service/messaging-byoc-ccaas/guide/enable-messaging-byoc-ccaas.html)
- [Compare BYOC for Messaging × BYOC for CCaaS](https://help.salesforce.com/s/articleView?language=en_US&id=service.byoc_compare_capabilities.htm&type=5)
- [Interaction Service API](https://developer.salesforce.com/docs/service/interaction-service-api/overview)
- [Considerations for WhatsApp Channels](https://help.salesforce.com/s/articleView?id=service.messaging_whatsapp_considerations.htm&language=en_US&type=5)

**NICE**
- [Digital Channels in Salesforce Agent](https://help.nicecxone.com/content/agent/agentapplicationadministration/agentforsalesforce/digital/digitalchannels.htm)
- [Unified Routing for Salesforce Digital Channels](https://help.nicecxone.com/content/agent/agentforscv/sales%20force%20digital%20chat.htm)
- [Banco do Brasil — WhatsApp com NICE CXone (case)](https://resources.nice.com/wp-content/uploads/2025/09/Banco-do-Brasil-Case-Study.pdf)
