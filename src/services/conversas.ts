import { 
  collection, 
  doc, 
  setDoc, 
  getDocs, 
  deleteDoc, 
  updateDoc, 
  query, 
  orderBy, 
  serverTimestamp 
} from "firebase/firestore";
import { db, auth } from "../firebase";
import { ChatSession, ChatMessage } from "../types";

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

// Helper para remover campos `undefined` que o Firestore rejeita
function sanitizeForFirestore<T>(data: T): T {
  return JSON.parse(JSON.stringify(data));
}

/**
 * Salva ou atualiza uma sessão completa de conversa no Firestore para o usuário específico.
 * Caminho: users/{uid}/conversas/{sessaoId}
 * Garantia de privacidade e isolamento total por usuário.
 */
export async function salvarSessaoFirestore(uid: string, sessao: ChatSession): Promise<void> {
  if (!uid || !sessao?.id) return;
  // Só sincroniza diretamente se houver sessão ativa do Firebase Auth compatível
  if (!auth.currentUser || auth.currentUser.uid !== uid) return;

  try {
    const docRef = doc(db, "users", uid, "conversas", sessao.id);
    const cleanSession = sanitizeForFirestore({
      id: sessao.id,
      title: sessao.title || "Nova Conversa",
      messages: sessao.messages || [],
      // Array de mensagens padronizado para o gatilho automático da Cloud Function (indexarMensagensNovas)
      mensagens: (sessao.messages || []).map(m => ({
        role: m.sender === "user" ? "user" : "assistant",
        content: m.text || ""
      })),
      timestamp: sessao.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      atualizadoEm: serverTimestamp()
    });

    await setDoc(docRef, cleanSession, { merge: true });
  } catch (err) {
    console.error(`Erro ao salvar sessão ${sessao.id} no Firestore para o usuário ${uid}:`, err);
  }
}

/**
 * Carrega todas as sessões privadas do usuário específico a partir do Firestore.
 * Caminho: users/{uid}/conversas
 */
export async function carregarSessoesFirestore(uid: string): Promise<ChatSession[]> {
  if (!uid) return [];
  // Só busca diretamente se houver sessão ativa do Firebase Auth compatível
  if (!auth.currentUser || auth.currentUser.uid !== uid) return [];

  try {
    const colRef = collection(db, "users", uid, "conversas");
    // Tenta ordenar por atualizadoEm decrescente
    let snapshot;
    try {
      const q = query(colRef, orderBy("atualizadoEm", "desc"));
      snapshot = await getDocs(q);
    } catch {
      // Fallback sem ordenação caso índice ainda esteja sendo construído
      snapshot = await getDocs(colRef);
    }

    if (snapshot.empty) return [];

    const sessoes: ChatSession[] = [];
    snapshot.forEach((d) => {
      const data = d.data();
      sessoes.push({
        id: data.id || d.id,
        title: data.title || "Conversa",
        messages: Array.isArray(data.messages) ? data.messages : [],
        timestamp: data.timestamp || "",
        criadoEm: data.criadoEm,
        atualizadoEm: data.atualizadoEm
      });
    });

    return sessoes;
  } catch (err) {
    console.warn(`Aviso ao carregar sessões do usuário ${uid} no Firestore:`, err);
    return [];
  }
}

/**
 * Remove uma sessão privada do usuário específico no Firestore.
 */
export async function excluirSessaoFirestore(uid: string, sessaoId: string): Promise<void> {
  if (!uid || !sessaoId) return;
  if (!auth.currentUser || auth.currentUser.uid !== uid) return;

  try {
    const docRef = doc(db, "users", uid, "conversas", sessaoId);
    await deleteDoc(docRef);
  } catch (err) {
    console.error(`Erro ao excluir sessão ${sessaoId} no Firestore para o usuário ${uid}:`, err);
  }
}

/**
 * Renomeia o título de uma sessão privada do usuário específico no Firestore.
 */
export async function renomearSessaoFirestore(uid: string, sessaoId: string, novoTitulo: string): Promise<void> {
  if (!uid || !sessaoId) return;
  if (!auth.currentUser || auth.currentUser.uid !== uid) return;

  try {
    const docRef = doc(db, "users", uid, "conversas", sessaoId);
    await updateDoc(docRef, {
      title: novoTitulo,
      atualizadoEm: serverTimestamp()
    });
  } catch (err) {
    console.error(`Erro ao renomear sessão ${sessaoId} no Firestore:`, err);
  }
}

// Funções legadas mantidas para compatibilidade retroativa
export async function salvarConversa(
  uid: string,
  mensagens: { role: string; content: string }[]
) {
  if (!uid) return null;
  try {
    const ref = collection(db, "users", uid, "conversas");
    const docRef = doc(ref);
    await setDoc(docRef, {
      mensagens,
      criadoEm: serverTimestamp(),
      atualizadoEm: serverTimestamp(),
    });
    return docRef.id;
  } catch (err) {
    console.error("Erro ao salvar conversa legada no Firestore:", err);
    return null;
  }
}

export async function carregarConversas(uid: string): Promise<ConversaDoc[]> {
  if (!uid) return [];
  try {
    const ref = collection(db, "users", uid, "conversas");
    const q = query(ref, orderBy("criadoEm", "desc"));
    const snapshot = await getDocs(q);
    return snapshot.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    })) as ConversaDoc[];
  } catch (err) {
    console.warn("Aviso ao carregar conversas do Firestore:", err);
    return [];
  }
}
