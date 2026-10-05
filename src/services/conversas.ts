import { apiFetch } from "./api";
import { ChatSession } from "../types";

export interface MensagemItem {
  role: string;
  content: string;
  timestamp?: string;
}

export interface ConversaDoc {
  id?: string;
  mensagens: MensagemItem[];
  criadoEm?: any;
  atualizadoEm?: any;
}

/**
 * Salva ou atualiza uma sessão completa de conversa via API do servidor.
 */
export async function salvarSessaoFirestore(uid: string, sessao: ChatSession): Promise<void> {
  if (!sessao?.id) return;
  try {
    const res = await apiFetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sessao)
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn(`[salvarSessaoFirestore] Servidor respondeu status ${res.status}:`, errText);
    }
  } catch (err: any) {
    console.warn(`[salvarSessaoFirestore] Falha ao sincronizar sessão ${sessao.id} via API:`, err?.message || err);
  }
}

/**
 * Carrega todas as sessões privadas do usuário específico via API do servidor.
 */
export async function carregarSessoesFirestore(uid: string): Promise<ChatSession[]> {
  try {
    const res = await apiFetch("/api/conversations");
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch (err) {
    console.warn("Aviso ao carregar sessões via API:", err);
    return [];
  }
}

/**
 * Remove uma sessão privada do usuário específico via API do servidor.
 */
export async function excluirSessaoFirestore(uid: string, sessaoId: string): Promise<void> {
  if (!sessaoId) return;
  try {
    await apiFetch(`/api/conversations/${sessaoId}`, {
      method: "DELETE"
    });
  } catch (err: any) {
    console.warn(`[excluirSessaoFirestore] Falha ao excluir sessão ${sessaoId} via API:`, err?.message || err);
  }
}

/**
 * Renomeia o título de uma sessão privada do usuário específico via API do servidor.
 */
export async function renomearSessaoFirestore(uid: string, sessaoId: string, novoTitulo: string): Promise<void> {
  if (!sessaoId) return;
  try {
    await apiFetch(`/api/conversations/${sessaoId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: novoTitulo })
    });
  } catch (err: any) {
    console.warn(`[renomearSessaoFirestore] Falha ao renomear sessão ${sessaoId} via API:`, err?.message || err);
  }
}

// Funções legadas mantidas para compatibilidade retroativa
export async function salvarConversa(
  uid: string,
  mensagens: { role: string; content: string }[]
) {
  const sessId = `conv_${Date.now()}`;
  await salvarSessaoFirestore(uid, {
    id: sessId,
    title: "Conversa",
    messages: mensagens.map((m, i) => ({
      id: `msg_${i}`,
      sender: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
      text: m.content,
      timestamp: new Date().toISOString()
    })),
    timestamp: new Date().toLocaleTimeString()
  });
  return sessId;
}

export async function carregarConversas(uid: string): Promise<ConversaDoc[]> {
  const sessions = await carregarSessoesFirestore(uid);
  return sessions.map(s => ({
    id: s.id,
    mensagens: (s.messages || []).map(m => ({
      role: m.sender === "user" ? "user" : "assistant",
      content: m.text
    })),
    criadoEm: s.criadoEm,
    atualizadoEm: s.atualizadoEm
  }));
}

