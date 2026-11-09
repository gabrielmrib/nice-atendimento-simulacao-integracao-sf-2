/**
 * SERVIDOR UNIFICADO - GATEWAY BETTA & NICE CONSOLE (Node.js)
 * Backend REST + WebSockets + Servidor HTTP Estático
 */


const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Servir os arquivos do Frontend da pasta public/
app.use(express.static(path.join(__dirname, 'public')));

// Servidor HTTP + WebSockets na mesma porta
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configurações da Org Salesforce
const SF_CONFIG = {
    domain: process.env.SF_DOMAIN || 'https://seu-dominio.my.salesforce.com',
    clientId: process.env.SF_CLIENT_ID || 'SEU_CLIENT_ID',
    clientSecret: process.env.SF_CLIENT_SECRET || 'SEU_CLIENT_SECRET',
    apiVersion: 'v61.0'
};

// Armazenamento em Memória
const activeSessions = new Map();

// --- 1. WEBSOCKET (Comunicação em Tempo Real com o Front) ---
wss.on('connection', (ws) => {
    console.log('[WebSocket] Consola NICE CXone conectada.');

    // Envia o estado atual das sessões para o front recém-conectado
    ws.send(JSON.stringify({
        type: 'INIT_STATE',
        sessions: Array.from(activeSessions.values())
    }));
});

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// --- 2. ENDPOINTS DE ENTRADA (Salesforce / Flow ➔ Gateway Betta) ---

// Abertura e Atualização de Conversas (Contrato Betta)
app.post('/api/customer/events', (req, res) => {
    try {
        const body = req.body;
        console.log("[Inbound SF] Evento recebido:", JSON.stringify(body));

        const action = body.action;
        const sessionId = body.identifier; // MessagingSessionId (0Mw...)

        if (action === 'OPEN_CONVERSATION') {
            const history = [];

            // Extrai histórico prévio se enviado no payload
            if (body.parameters?.contact?.history) {
                body.parameters.contact.history.forEach(item => {
                    if (item.sender === 'user') {
                        const txt = typeof item.message === 'string' ? item.message : item.message?.text;
                        if (txt) history.push({ sender: 'user', text: txt });
                    } else if (item.sender === 'bot') {
                        let txt = '';
                        if (Array.isArray(item.message)) {
                            txt = item.message[0]?.default?.text || '';
                        } else if (typeof item.message === 'string') {
                            txt = item.message;
                        }
                        if (txt) history.push({ sender: 'bot', text: txt });
                    }
                });
            }

            const sessionData = {
                identifier: sessionId,
                conversationId: body.conversationId || sessionId,
                status: 'QUEUED',
                contact: {
                    name: body.parameters?.contact?.name || 'Cliente WhatsApp',
                    phone: body.parameters?.contact?.phone || 'Não informado',
                    cpf: body.parameters?.contact?.cpf || body.parameters?.extraInfo?.CPF || 'Não informado',
                    email: body.parameters?.contact?.email || 'Não informado',
                    canalOperacao: body.parameters?.extraInfo?.CanalOperacao || 'Geral'
                },
                history: history
            };

            activeSessions.set(sessionId, sessionData);
            broadcast({ type: 'NEW_CONVERSATION', session: sessionData });

            return res.status(200).json({ requestId: body.requestId || 'req_123', message: 'OK' });
        }

        if (action === 'SEND_MESSAGE') {
            const session = activeSessions.get(sessionId);
            if (session) {
                const newMsgs = body.parameters?.messages || [];
                newMsgs.forEach(m => session.history.push({ sender: 'user', text: m }));
                broadcast({ type: 'NEW_USER_MESSAGE', sessionId, messages: newMsgs });
            }
            return res.status(200).json({ requestId: body.requestId || 'req_123', message: 'OK' });
        }

        if (action === 'CLOSE_CONVERSATION') {
            const session = activeSessions.get(sessionId);
            if (session) {
                session.status = 'CLOSED';
                broadcast({ type: 'CONVERSATION_CLOSED', sessionId });
            }
            return res.status(200).json({ requestId: body.requestId || 'req_123', message: 'OK' });
        }

        res.status(200).json({ message: 'Ação não mapeada ignorada.' });
    } catch (err) {
        console.error("Erro no processamento:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- 3. ENDPOINTS DE SAÍDA (Front NICE ➔ Gateway ➔ Salesforce API) ---

// Resposta do Atendente Humano
app.post('/api/agent/reply', async (req, res) => {
    const { sessionId, messageText } = req.body;

    try {
        console.log(`[Outbound SF] Enviando resposta do atendente para a sessão: ${sessionId}`);

        // 1. Obter OAuth Token
        const token = await getSalesforceToken();

        // 2. Disparar API de Ações de Mensageria da Salesforce
        const actionUrl = `${SF_CONFIG.domain}/services/data/${SF_CONFIG.apiVersion}/actions/standard/sendConversationMessages`;

        const sfRes = await fetch(actionUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                inputs: [{
                    conversationId: sessionId,
                    message: messageText
                }]
            })
        });

        if (!sfRes.ok) {
            const errBody = await sfRes.text();
            throw new Error(`Erro na API Salesforce: ${errBody}`);
        }

        // Atualiza repositório local e notifica telas
        const session = activeSessions.get(sessionId);
        if (session) {
            session.history.push({ sender: 'agent', text: messageText });
            broadcast({ type: 'AGENT_REPLIED', sessionId, text: messageText });
        }

        res.status(200).json({ success: true });
    } catch (error) {
        console.error("Erro no envio do atendente:", error);
        res.status(500).json({ error: error.message });
    }
});

// Aceite da conversa pelo Atendente
app.post('/api/agent/accept', (req, res) => {
    const { sessionId } = req.body;
    const session = activeSessions.get(sessionId);
    if (session) {
        session.status = 'ACTIVE';
        broadcast({ type: 'CONVERSATION_ACCEPTED', sessionId });
    }
    res.status(200).json({ success: true });
});

// Encerramento de atendimento pelo Atendente
app.post('/api/agent/close', (req, res) => {
    const { sessionId } = req.body;
    const session = activeSessions.get(sessionId);
    if (session) {
        session.status = 'CLOSED';
        broadcast({ type: 'CONVERSATION_CLOSED', sessionId });
    }
    res.status(200).json({ success: true });
});

// Autenticação OAuth2 Client Credentials
async function getSalesforceToken() {
    const tokenUrl = `${SF_CONFIG.domain}/services/oauth2/token`;
    const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: SF_CONFIG.clientId,
        client_secret: SF_CONFIG.clientSecret
    });

    const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Falha OAuth Salesforce: ${text}`);
    }

    const data = await res.json();
    return data.access_token;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando em: http://localhost:${PORT}`);
});

