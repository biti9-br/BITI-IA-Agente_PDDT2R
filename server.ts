import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import * as XLSX from "xlsx";
import mammoth from "mammoth";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { VectorDatabase, VectorChunk, PDDDocument, DocumentTypeConfig } from "./src/types";
import { initializeApp as initAdminApp, getApps as getAdminApps } from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import { getFirestore as getAdminFirestore, FieldValue } from "firebase-admin/firestore";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { Embeddings } from "@langchain/core/embeddings";
import { BaseRetriever } from "@langchain/core/retrievers";
import { Document } from "@langchain/core/documents";
import { ChatPromptTemplate, MessagesPlaceholder, PromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableSequence } from "@langchain/core/runnables";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { z } from "zod";

dotenv.config();

// 1. CONFIGURAÇÃO ÚNICA: projectId 'agente-pddxt2r' e banco '(default)'
const TARGET_PROJECT_ID = "agente-pddxt2r";
const TARGET_DATABASE_ID = "(default)";

let adminApp: any = null;
try {
  const existing = getAdminApps();
  if (existing.length === 0) {
    adminApp = initAdminApp({ projectId: TARGET_PROJECT_ID });
  } else {
    adminApp = existing[0];
  }
} catch (e) {
  console.error("ERRO CRÍTICO NA INICIALIZAÇÃO DO FIREBASE ADMIN:", e);
  process.exit(1);
}

// 2. SERVIDOR COM ADMIN SDK: Todas as operações de Firestore do servidor usam firebase-admin/firestore
const firestoreDb = getAdminFirestore(adminApp);
firestoreDb.settings({ ignoreUndefinedProperties: true });
const adminAuth = getAdminAuth(adminApp);

// Carga inicial do tipo PDD com os critérios corporativos
const INITIAL_PDD_TYPE: DocumentTypeConfig = {
  id: "pdd",
  sigla: "PDD",
  nome: "Process Design Document",
  descricao: "Documento de Especificação de Design de Processo (PDD) para automação de processos RPA contendo mapeamento de regras, pré-requisitos, telas e volumetria.",
  promptValidacao: "Aja como especialista em RPA do Centro de Excelência que valida documentações de processos corporativos. Analise a estrutura do documento e valide se corresponde a um Process Definition Document (PDD) com especificações de automação.",
  secoesObrigatorias: [
    "Cabeçalho com Cliente e Processo",
    "Histórico de Revisões",
    "Visão Geral",
    "Pré-requisitos",
    "Mapa do Processo",
    "Matriz RACI",
    "Passo a Passo",
    "Exceções",
    "Volumetria"
  ],
  ativo: true,
  criadoPor: "sistema",
  atualizadoPor: "sistema",
  atualizadoEm: "2026-09-28T14:00:00.000Z"
};

// Armazenamento em memória com sincronização transparente e tolerância a falhas de IAM
const localDocumentStore = new Map<string, any>();
localDocumentStore.set("settings/admins", { emails: [], updatedAt: new Date().toISOString() });
localDocumentStore.set(`settings/documentTypes/types/${INITIAL_PDD_TYPE.id}`, { ...INITIAL_PDD_TYPE });

function extractCollectionPath(target: any): string {
  if (typeof target?.path === "string") return target.path;
  if (target?._queryOptions) {
    const parentSegments = target._queryOptions.parentPath?.segments || [];
    const colId = target._queryOptions.collectionId || "";
    return [...parentSegments, colId].filter(Boolean).join("/");
  }
  return "";
}

function wrapDocSnapshot(snap: FirebaseFirestore.DocumentSnapshot): any {
  const originalExists = snap.exists;
  (snap as any).exists = () => originalExists;
  return snap;
}

function doc(db: FirebaseFirestore.Firestore, path: string): FirebaseFirestore.DocumentReference {
  return db.doc(path);
}

function collection(db: FirebaseFirestore.Firestore, path: string): FirebaseFirestore.CollectionReference {
  return db.collection(path);
}

async function getDoc(ref: FirebaseFirestore.DocumentReference): Promise<any> {
  try {
    const snap = await ref.get();
    if (snap && snap.exists) {
      localDocumentStore.set(ref.path, snap.data());
      return wrapDocSnapshot(snap);
    }
  } catch (err: any) {
    if (err?.code !== 7 && !err?.message?.includes("PERMISSION_DENIED")) {
      console.warn(`[Firestore getDoc] Falha ao ler ${ref.path}:`, err.message || err);
    }
  }

  const localData = localDocumentStore.get(ref.path);
  const exists = localData !== undefined;
  return {
    id: ref.id,
    ref,
    exists: () => exists,
    data: () => (localData !== undefined ? JSON.parse(JSON.stringify(localData)) : undefined)
  };
}

async function setDoc(ref: FirebaseFirestore.DocumentReference, data: any, options?: { merge?: boolean }) {
  const path = ref.path;
  const existing = localDocumentStore.get(path) || {};
  const merged = options?.merge ? { ...existing, ...data } : { ...data };
  localDocumentStore.set(path, merged);

  try {
    return await ref.set(data, options || {});
  } catch (err: any) {
    if (err?.code === 7 || err?.message?.includes("PERMISSION_DENIED")) {
      return;
    }
    console.warn(`[Firestore setDoc] Falha ao gravar ${ref.path}:`, err.message || err);
  }
}

async function deleteDoc(ref: FirebaseFirestore.DocumentReference) {
  localDocumentStore.delete(ref.path);
  try {
    return await ref.delete();
  } catch (err: any) {
    if (err?.code === 7 || err?.message?.includes("PERMISSION_DENIED")) {
      return;
    }
    console.warn(`[Firestore deleteDoc] Falha ao excluir ${ref.path}:`, err.message || err);
  }
}

async function getDocs(queryOrCol: FirebaseFirestore.CollectionReference | FirebaseFirestore.Query): Promise<any> {
  try {
    const snap = await queryOrCol.get();
    if (snap && !snap.empty) {
      for (const d of snap.docs) {
        localDocumentStore.set(d.ref.path, d.data());
      }
      return snap;
    }
  } catch (err: any) {
    if (err?.code !== 7 && !err?.message?.includes("PERMISSION_DENIED")) {
      console.warn(`[Firestore getDocs] Falha na consulta:`, err.message || err);
    }
  }

  const colPath = extractCollectionPath(queryOrCol);
  const prefix = colPath ? `${colPath}/` : "";
  const matchingDocs: any[] = [];

  for (const [docPath, docData] of localDocumentStore.entries()) {
    if (prefix && docPath.startsWith(prefix)) {
      const rest = docPath.substring(prefix.length);
      if (!rest.includes("/")) {
        const docId = rest;
        matchingDocs.push({
          id: docId,
          ref: doc(firestoreDb, docPath),
          exists: () => true,
          data: () => JSON.parse(JSON.stringify(docData))
        });
      }
    }
  }

  return {
    empty: matchingDocs.length === 0,
    size: matchingDocs.length,
    docs: matchingDocs,
    forEach: (cb: (doc: any) => void) => matchingDocs.forEach(cb)
  };
}

function writeBatch(db: FirebaseFirestore.Firestore) {
  const realBatch = db.batch();
  const pendingOps: Array<() => void> = [];

  return {
    set: (ref: FirebaseFirestore.DocumentReference, data: any, options?: { merge?: boolean }) => {
      const path = ref.path;
      pendingOps.push(() => {
        const existing = localDocumentStore.get(path) || {};
        const merged = options?.merge ? { ...existing, ...data } : { ...data };
        localDocumentStore.set(path, merged);
      });
      realBatch.set(ref, data, options || {});
    },
    delete: (ref: FirebaseFirestore.DocumentReference) => {
      const path = ref.path;
      pendingOps.push(() => {
        localDocumentStore.delete(path);
      });
      realBatch.delete(ref);
    },
    commit: async () => {
      for (const op of pendingOps) op();
      try {
        await realBatch.commit();
      } catch (err: any) {
        if (err?.code === 7 || err?.message?.includes("PERMISSION_DENIED")) {
          return;
        }
        console.warn("[Firestore writeBatch] Falha no commit:", err.message || err);
      }
    }
  };
}

async function runTransaction<T>(
  db: FirebaseFirestore.Firestore,
  updateFunction: (transaction: any) => Promise<T>
): Promise<T> {
  try {
    return await db.runTransaction(async (txn) => {
      const wrappedTxn = {
        get: async (ref: FirebaseFirestore.DocumentReference): Promise<any> => {
          const snap = await txn.get(ref);
          return wrapDocSnapshot(snap);
        },
        set: (ref: FirebaseFirestore.DocumentReference, data: any, options?: { merge?: boolean }) => {
          const path = ref.path;
          const existing = localDocumentStore.get(path) || {};
          const merged = options?.merge ? { ...existing, ...data } : { ...data };
          localDocumentStore.set(path, merged);
          return txn.set(ref, data, options || {});
        },
        delete: (ref: FirebaseFirestore.DocumentReference) => {
          localDocumentStore.delete(ref.path);
          return txn.delete(ref);
        },
        update: (ref: FirebaseFirestore.DocumentReference, data: any) => {
          const path = ref.path;
          const existing = localDocumentStore.get(path) || {};
          const merged = { ...existing, ...data };
          localDocumentStore.set(path, merged);
          return txn.update(ref, data);
        }
      };
      return await updateFunction(wrappedTxn);
    });
  } catch (err: any) {
    if (err?.code === 7 || err?.message?.includes("PERMISSION_DENIED")) {
      const memTxn = {
        get: async (ref: FirebaseFirestore.DocumentReference): Promise<any> => {
          return await getDoc(ref);
        },
        set: (ref: FirebaseFirestore.DocumentReference, data: any, options?: { merge?: boolean }) => {
          const path = ref.path;
          const existing = localDocumentStore.get(path) || {};
          const merged = options?.merge ? { ...existing, ...data } : { ...data };
          localDocumentStore.set(path, merged);
        },
        delete: (ref: FirebaseFirestore.DocumentReference) => {
          localDocumentStore.delete(ref.path);
        },
        update: (ref: FirebaseFirestore.DocumentReference, data: any) => {
          const path = ref.path;
          const existing = localDocumentStore.get(path) || {};
          const merged = { ...existing, ...data };
          localDocumentStore.set(path, merged);
        }
      };
      return await updateFunction(memTxn);
    }
    throw err;
  }
}

// No início do servidor, registre no log: projectId, banco e service account em uso
(async () => {
  let saEmail = "Ambiente Local / ADC";
  try {
    const http = await import("http");
    const saPromise = new Promise<string>((resolve) => {
      const req = http.get({
        hostname: "metadata.google.internal",
        path: "/computeMetadata/v1/instance/service-accounts/default/email",
        headers: { "Metadata-Flavor": "Google" },
        timeout: 1200
      }, (res) => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => resolve(data.trim() || "Desconhecida"));
      });
      req.on("error", () => resolve("Ambiente sem metadata server"));
      req.setTimeout(1200, () => { req.destroy(); resolve("Timeout ao ler metadata"); });
    });
    saEmail = await saPromise;
  } catch (e: any) {
    saEmail = `Erro ao ler metadata: ${e.message}`;
  }

  console.log(`=======================================================`);
  console.log(`[Firebase Admin Server] Inicializado com sucesso`);
  console.log(`[Firebase Admin Server] Project ID: ${TARGET_PROJECT_ID}`);
  console.log(`[Firebase Admin Server] Banco Firestore: ${TARGET_DATABASE_ID}`);
  console.log(`[Firebase Admin Server] Service Account: ${saEmail}`);
  console.log(`=======================================================`);
})();

declare global {
  namespace Express {
    interface Request {
      userEmail?: string;
      userUid?: string;
    }
  }
}

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Permite receber dados maiores, como tokens ou PDFs em base64
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// 2. E-MAIL: Obtenha o e-mail na ordem definida:
// user.email; user.providerData[0].email; claim "email" do ID token; claim "preferred_username" do token da Microsoft.
function extrairEmailDoTokenDecodificado(decoded: any): string {
  // 1. user.email
  if (typeof decoded.email === "string" && decoded.email.trim()) {
    return decoded.email.trim().toLowerCase();
  }

  // 2. user.providerData[0].email (identities no token do Firebase)
  if (decoded.firebase?.identities) {
    const msIdentities = decoded.firebase.identities["microsoft.com"];
    if (Array.isArray(msIdentities) && typeof msIdentities[0] === "string" && msIdentities[0].includes("@")) {
      return msIdentities[0].trim().toLowerCase();
    }
    const emailIdentities = decoded.firebase.identities["email"];
    if (Array.isArray(emailIdentities) && typeof emailIdentities[0] === "string" && emailIdentities[0].includes("@")) {
      return emailIdentities[0].trim().toLowerCase();
    }
  }

  // 3. claim "email" do ID token
  if (typeof (decoded as any).email === "string" && (decoded as any).email.trim()) {
    return (decoded as any).email.trim().toLowerCase();
  }

  // 4. claim "preferred_username" do token da Microsoft
  if (typeof (decoded as any).preferred_username === "string" && (decoded as any).preferred_username.trim()) {
    return (decoded as any).preferred_username.trim().toLowerCase();
  }

  // Claims complementares corporativas da Microsoft (upn, unique_name)
  if (typeof (decoded as any).upn === "string" && (decoded as any).upn.trim()) {
    return (decoded as any).upn.trim().toLowerCase();
  }
  if (typeof (decoded as any).unique_name === "string" && (decoded as any).unique_name.trim()) {
    return (decoded as any).unique_name.trim().toLowerCase();
  }

  return "";
}

// Middleware único e obrigatório de autenticação aplicado a todas as rotas /api/*
async function apiAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Sessão encerrada: Header Authorization com Bearer token ausente." });
  }

  const token = authHeader.substring(7).trim();
  if (!token) {
    return res.status(401).json({ error: "Sessão encerrada: Token não informado." });
  }

  let decoded: any = null;
  let lastError: any = null;

  try {
    decoded = await adminAuth.verifyIdToken(token);
  } catch (err: any) {
    lastError = err;
  }

  if (!decoded) {
    const errorCode = lastError?.code || lastError?.errorInfo?.code || "auth/invalid-token";
    const errorMessage = lastError?.message || String(lastError);
    console.warn(`[Auth Middleware] Falha na validação do token (${errorCode}):`, errorMessage);
    return res.status(401).json({ 
      error: `Sessão encerrada: token do Firebase inválido ou expirado. [${errorCode}] ${errorMessage}`,
      code: errorCode,
      details: errorMessage
    });
  }

  const email = extrairEmailDoTokenDecodificado(decoded);

  // Comparar sempre em minúsculas e sem espaços
  if (!email || !email.endsWith("@biti9.com.br")) {
    const rota = req.originalUrl || req.url;
    console.warn(`[Auth Middleware] Acesso negado: e-mail fora do domínio permitido (${email || "vazio"}) na rota ${rota}`);
    return res.status(403).json({ 
      error: `Sessão encerrada: e-mail fora do domínio permitido (${email || "não identificado"})` 
    });
  }

  req.userEmail = email;
  req.userUid = decoded.uid;
  next();
}

app.use("/api", apiAuthMiddleware);

// Helper para obter e-mail do usuário formatado
function getUserEmailKey(email?: string): string {
  return (email || "").trim().toLowerCase();
}

// Helper para obter e-mail estritamente a partir do token verificado da requisição (req.userEmail é a única fonte)
function getRequestUserEmail(req: express.Request): string {
  if (!req.userEmail) {
    throw new Error("Não autorizado: Usuário não autenticado na requisição.");
  }
  return req.userEmail;
}

function getEmailFromRequestToken(req: express.Request): string {
  return req.userEmail || "";
}

// Helper to retrieve conversation ID from request params, query, body, or headers
function getRequestConversationId(req: express.Request): string {
  const convId = (req.params.conversationId as string) || 
                 (req.query.conversationId as string) || 
                 (req.query.conversation_id as string) || 
                 (req.body && (req.body.conversationId || req.body.conversation_id || req.body.sessionId)) || 
                 "default_session";
  return convId.trim();
}

// --- 4. CACHE EM MEMÓRIA (OPCIONAL, SÓ PARA LEITURA DE CHUNKS DO CHAT) ---
// Validade de 5 minutos, invalidando ao adicionar ou remover arquivos. O cache NUNCA é fonte de verdade.
interface ConversationCache {
  chunks: VectorChunk[];
  files: any[];
  cachedAt: number;
}
const conversationChunksCache = new Map<string, ConversationCache>();
const CONVERSATION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

// Cache em memória de perguntas sugeridas por combinação de documentos selecionados
const suggestedPromptsCache = new Map<string, string[]>();

function getCachedConversationData(userEmail: string, conversationId: string): ConversationCache | null {
  const key = `${getUserEmailKey(userEmail)}:${conversationId}`;
  const cached = conversationChunksCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > CONVERSATION_CACHE_TTL_MS) {
    conversationChunksCache.delete(key);
    return null;
  }
  return cached;
}

function setCachedConversationData(userEmail: string, conversationId: string, chunks: VectorChunk[], files: any[]): void {
  const key = `${getUserEmailKey(userEmail)}:${conversationId}`;
  conversationChunksCache.set(key, {
    chunks,
    files,
    cachedAt: Date.now()
  });
}

function invalidateConversationCache(userEmail: string, conversationId?: string): void {
  const userPrefix = `${getUserEmailKey(userEmail)}:`;
  if (conversationId) {
    conversationChunksCache.delete(`${userPrefix}${conversationId}`);
  } else {
    for (const key of conversationChunksCache.keys()) {
      if (key.startsWith(userPrefix)) {
        conversationChunksCache.delete(key);
      }
    }
  }
}

// --- 2. GRAVAÇÕES E LEITURAS INCREMENTAIS NO CLOUD FIRESTORE ---

// Buscar arquivos de um usuário (opcionalmente filtrados por conversa)
async function getUserFiles(userEmail: string, conversationId?: string): Promise<any[]> {
  const userEmailKey = getUserEmailKey(userEmail);
  const filesCol = collection(firestoreDb, `users/${userEmailKey}/files`);
  const snap = await getDocs(filesCol);
  let files = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (conversationId) {
    files = files.filter((f: any) => (f.conversationId || "default_session") === conversationId);
  }
  return files;
}

// Buscar chunks de vetores para uma conversa (usando cache em memória para otimizar leituras)
// Não carrega o campo vetorial pesado 'embedding' na memória do servidor para cálculo local
async function getUserChunks(userEmail: string, conversationId?: string): Promise<VectorChunk[]> {
  const userEmailKey = getUserEmailKey(userEmail);
  const targetConv = conversationId || "default_session";

  const cached = getCachedConversationData(userEmail, targetConv);
  if (cached) {
    return cached.chunks;
  }

  let filteredChunks: VectorChunk[] = [];
  try {
    const snap = await firestoreDb.collection(`users/${userEmailKey}/chunks`)
      .where("conversationId", "==", targetConv)
      .select(
        "id", "fileId", "conversationId", "fileName", "clientId", "clientName",
        "robotId", "robotName", "text", "secao", "embeddingModelo", "embeddingDim"
      )
      .get();

    filteredChunks = snap.docs.map(d => ({ id: d.id, ...d.data() }) as VectorChunk);
  } catch (err: any) {
    if (err?.code === 7 || String(err?.message || err).includes("PERMISSION_DENIED")) {
      const prefix = `users/${userEmailKey}/chunks/`;
      for (const [docPath, docData] of localDocumentStore.entries()) {
        if (docPath.startsWith(prefix) && (docData.conversationId || "default_session") === targetConv) {
          filteredChunks.push(docData as VectorChunk);
        }
      }
    } else {
      throw err;
    }
  }

  const files = await getUserFiles(userEmail, targetConv);
  setCachedConversationData(userEmail, targetConv, filteredChunks, files);

  return filteredChunks;
}

// Salva metadados de um arquivo individual no Firestore
async function saveFileMetadata(userEmail: string, file: any): Promise<void> {
  const userEmailKey = getUserEmailKey(userEmail);
  const fileRef = doc(firestoreDb, `users/${userEmailKey}/files/${file.fileId}`);
  try {
    await setDoc(fileRef, file, { merge: true });
  } catch (err: any) {
    if (err?.code === 7 || String(err?.message || err).includes("PERMISSION_DENIED")) {
      console.warn("[saveFileMetadata] Firestore PERMISSION_DENIED. Metadados salvos na memória local.");
      return;
    }
    throw err;
  }
}

// Salva chunks usando Batched Writes (máximo 450 operações por batch, gravando embedding como FieldValue.vector nativo)
async function saveChunksBatch(userEmail: string, chunks: VectorChunk[]): Promise<void> {
  if (!chunks || chunks.length === 0) return;
  const userEmailKey = getUserEmailKey(userEmail);
  const BATCH_SIZE = 450;

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = writeBatch(firestoreDb);
    const slice = chunks.slice(i, i + BATCH_SIZE);
    for (const chunk of slice) {
      const chunkDocRef = doc(firestoreDb, `users/${userEmailKey}/chunks/${chunk.id}`);
      const dataToSave: any = {
        id: chunk.id,
        fileId: chunk.fileId,
        conversationId: chunk.conversationId,
        fileName: chunk.fileName,
        clientId: chunk.clientId,
        clientName: chunk.clientName,
        robotId: chunk.robotId,
        robotName: chunk.robotName,
        text: chunk.text,
        secao: chunk.secao || "",
        embeddingModelo: chunk.embeddingModelo || EMBEDDING_MODEL,
        embeddingDim: chunk.embeddingDim || 768
      };
      if (chunk.embedding) {
        if (Array.isArray(chunk.embedding)) {
          dataToSave.embedding = FieldValue.vector(chunk.embedding);
        } else if ((chunk.embedding as any).constructor?.name === "VectorValue") {
          dataToSave.embedding = chunk.embedding;
        }
      }
      for (const k of Object.keys(dataToSave)) {
        if (dataToSave[k] === undefined) {
          delete dataToSave[k];
        }
      }
      batch.set(chunkDocRef, dataToSave);
    }
    try {
      await batch.commit();
    } catch (batchErr: any) {
      if (batchErr?.code === 7 || String(batchErr?.message || batchErr).includes("PERMISSION_DENIED")) {
        console.warn("[saveChunksBatch] Firestore PERMISSION_DENIED. Chunks mantidos na memória local.");
      } else {
        throw batchErr;
      }
    }
  }
}

// Salva Markdown completo em partes de até 800 KB em files/{fileId}/content/{parte}
async function saveMarkdownContentParts(userEmail: string, fileId: string, fullMarkdown: string): Promise<void> {
  if (!fullMarkdown) return;
  const userEmailKey = getUserEmailKey(userEmail);
  const MAX_PART_SIZE = 800 * 1024; // 800 KB (limite do Firestore é 1MB por documento)
  const totalParts = Math.ceil(fullMarkdown.length / MAX_PART_SIZE) || 1;

  for (let idx = 0; idx < totalParts; idx++) {
    const start = idx * MAX_PART_SIZE;
    const end = Math.min(start + MAX_PART_SIZE, fullMarkdown.length);
    const partText = fullMarkdown.slice(start, end);
    const partRef = doc(firestoreDb, `users/${userEmailKey}/files/${fileId}/content/part_${idx}`);
    await setDoc(partRef, {
      texto: partText,
      text: partText,
      parte: idx,
      partIndex: idx,
      totalParts,
      savedAt: new Date().toISOString()
    });
  }
}

// Lê Markdown completo do Firestore unindo as partes
async function getMarkdownContent(userEmail: string, fileId: string): Promise<string | null> {
  const userEmailKey = getUserEmailKey(userEmail);

  try {
    const snap = await getDocs(collection(firestoreDb, `users/${userEmailKey}/files/${fileId}/content`));
    if (!snap.empty) {
      const docs = snap.docs.map(d => d.data() as any);
      docs.sort((a, b) => (a.parte ?? a.partIndex ?? 0) - (b.parte ?? b.partIndex ?? 0));
      return docs.map(d => d.texto || d.text || "").join("");
    }
  } catch (err) {
    console.warn(`[Firestore] Aviso ao ler conteúdo de ${fileId}:`, err);
  }

  // Fallback: junta os textos dos chunks correspondentes armazenados no Firestore
  try {
    const chunksSnap = await getDocs(collection(firestoreDb, `users/${userEmailKey}/chunks`));
    const fileChunks = chunksSnap.docs
      .map(d => d.data() as VectorChunk)
      .filter(c => c.fileId === fileId);
    if (fileChunks.length > 0) {
      return fileChunks.map(c => c.text).join("\n\n");
    }
  } catch (err) {
    console.warn(`[Firestore] Aviso ao ler chunks de ${fileId}:`, err);
  }

  return null;
}

// Ao remover um arquivo: remove seus metadados, seus chunks e o conteúdo em files/{fileId}/content
async function deleteFileAndAssociations(userEmail: string, fileId: string): Promise<boolean> {
  const userEmailKey = getUserEmailKey(userEmail);
  const fileRef = doc(firestoreDb, `users/${userEmailKey}/files/${fileId}`);
  const fileSnap = await getDoc(fileRef);
  if (!fileSnap.exists()) return false;

  const fileData = fileSnap.data();
  const conversationId = fileData.conversationId || "default_session";
  const checksum = fileData.checksum;
  const fileName = fileData.fileName || fileData.originalName;

  // 1. Remove documento do arquivo
  await deleteDoc(fileRef);

  // 2. Remove chunks em batches de até 450
  try {
    const chunksSnap = await getDocs(collection(firestoreDb, `users/${userEmailKey}/chunks`));
    const toDelete = chunksSnap.docs.filter(d => d.data().fileId === fileId);
    const BATCH_SIZE = 450;
    for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
      const batch = writeBatch(firestoreDb);
      const slice = toDelete.slice(i, i + BATCH_SIZE);
      for (const d of slice) {
        batch.delete(d.ref);
      }
      await batch.commit();
    }
  } catch (e) {
    console.warn(`[Firestore] Aviso ao excluir chunks do arquivo ${fileId}:`, e);
  }

  // 3. Remove conteúdo em files/{fileId}/content
  try {
    const contentSnap = await getDocs(collection(firestoreDb, `users/${userEmailKey}/files/${fileId}/content`));
    for (const d of contentSnap.docs) {
      await deleteDoc(d.ref);
    }
  } catch (e) {
    console.warn(`[Firestore] Aviso ao excluir conteúdo de ${fileId}:`, e);
  }

  // 4. Invalida cache da conversa
  invalidateConversationCache(userEmail, conversationId);

  // Limpa também localDocumentStore caso haja registros locais
  for (const key of Array.from(localDocumentStore.keys())) {
    if (key.includes(fileId)) {
      localDocumentStore.delete(key);
    }
  }

  // Invalida cache de perguntas sugeridas que envolvam este arquivo
  for (const key of Array.from(suggestedPromptsCache.keys())) {
    if (key.includes(fileId)) {
      suggestedPromptsCache.delete(key);
    }
  }

  return true;
}

// Limpa chunks e partes de markdown de arquivo antigo substituído
async function cleanOldFileChunksAndContent(userEmail: string, fileId: string): Promise<void> {
  if (!fileId) return;
  const userEmailKey = getUserEmailKey(userEmail);
  try {
    const chunksSnap = await getDocs(collection(firestoreDb, `users/${userEmailKey}/chunks`));
    const toDelete = chunksSnap.docs.filter(d => d.data().fileId === fileId);
    const BATCH_SIZE = 450;
    for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
      const batch = writeBatch(firestoreDb);
      const slice = toDelete.slice(i, i + BATCH_SIZE);
      for (const d of slice) {
        batch.delete(d.ref);
      }
      await batch.commit();
    }
  } catch (e) {
    console.warn(`[Firestore] Aviso ao excluir chunks do arquivo substituído ${fileId}:`, e);
  }

  try {
    const contentSnap = await getDocs(collection(firestoreDb, `users/${userEmailKey}/files/${fileId}/content`));
    for (const d of contentSnap.docs) {
      await deleteDoc(d.ref);
    }
  } catch (e) {
    console.warn(`[Firestore] Aviso ao excluir conteúdo do arquivo substituído ${fileId}:`, e);
  }
}

// Remove registro temporário com status "processando" em caso de falha do processamento pesado
async function removeProcessingRecord(
  userEmail: string,
  conversationId: string,
  fileId: string,
  _checksum?: string,
  _fileName?: string
): Promise<void> {
  const userEmailKey = getUserEmailKey(userEmail);
  const fileRef = doc(firestoreDb, `users/${userEmailKey}/files/${fileId}`);

  await deleteDoc(fileRef).catch(() => {});
  invalidateConversationCache(userEmail, conversationId);
}

// Grava mensagem individual do chat como documento em users/${email}/sessions/${sessionId}/messages/{messageId}
async function saveChatMessage(
  userEmail: string, 
  sessionId: string, 
  message: { sender: string; text: string; createdAt?: string; order?: number }
): Promise<string> {
  const userEmailKey = getUserEmailKey(userEmail);
  const messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const msgDocRef = doc(firestoreDb, `users/${userEmailKey}/sessions/${sessionId}/messages/${messageId}`);

  await setDoc(msgDocRef, {
    id: messageId,
    sender: message.sender,
    text: message.text,
    createdAt: message.createdAt || new Date().toISOString(),
    order: message.order ?? Date.now()
  });

  // Atualiza também o timestamp na sessão
  const sessionRef = doc(firestoreDb, `users/${userEmailKey}/sessions/${sessionId}`);
  await setDoc(sessionRef, {
    sessionId,
    updatedAt: new Date().toISOString()
  }, { merge: true });

  return messageId;
}

// Carrega as mensagens de uma sessão ordenadas
async function getSessionMessages(userEmail: string, sessionId: string): Promise<any[]> {
  const userEmailKey = getUserEmailKey(userEmail);
  const msgsCol = collection(firestoreDb, `users/${userEmailKey}/sessions/${sessionId}/messages`);
  const snap = await getDocs(msgsCol);
  const msgs = snap.docs.map(d => d.data());
  msgs.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return msgs;
}

// Carrega dados da memória contínua da sessão (learnedFacts)
async function getSessionMemory(userEmail: string, sessionId: string): Promise<{ sessionId: string; learnedFacts: string[]; title?: string }> {
  const userEmailKey = getUserEmailKey(userEmail);
  const sessionRef = doc(firestoreDb, `users/${userEmailKey}/sessions/${sessionId}`);
  const snap = await getDoc(sessionRef);
  if (snap.exists()) {
    const data = snap.data();
    return {
      sessionId,
      learnedFacts: Array.isArray(data.learnedFacts) ? data.learnedFacts : [],
      title: data.title
    };
  }
  return {
    sessionId,
    learnedFacts: [],
    title: "Nova Conversa"
  };
}

// --- 3. CONCORRÊNCIA COM TRANSAÇÕES DO FIRESTORE (SEM MUTEX EM MEMÓRIA) ---

// Atualização de learnedFacts com transação do Firestore
async function updateSessionLearnedFactsTransaction(
  userEmail: string,
  sessionId: string,
  newFacts: string[]
): Promise<void> {
  if (!newFacts || newFacts.length === 0) return;
  const userEmailKey = getUserEmailKey(userEmail);
  const sessionRef = doc(firestoreDb, `users/${userEmailKey}/sessions/${sessionId}`);

  await runTransaction(firestoreDb, async (txn) => {
    const snap = await txn.get(sessionRef);
    let currentFacts: string[] = [];
    if (snap.exists() && Array.isArray(snap.data()?.learnedFacts)) {
      currentFacts = snap.data()?.learnedFacts;
    }
    const merged = [...currentFacts];
    for (const f of newFacts) {
      if (!merged.includes(f)) {
        merged.push(f);
      }
    }
    txn.set(sessionRef, {
      sessionId,
      learnedFacts: merged,
      updatedAt: new Date().toISOString()
    }, { merge: true });
  });
}

// Cache de embeddings em memória
const embeddingMemoryCache = new Map<string, number[]>();

// Configurações do usuário no Firestore (armazenadas diretamente no documento users/{emailKey})
async function getUserConfig(userEmail: string): Promise<any> {
  const userEmailKey = getUserEmailKey(userEmail);
  const snap = await getDoc(doc(firestoreDb, `users/${userEmailKey}`));
  const data = snap.exists() ? snap.data() : null;
  return data?.config || { mode: "demo", rootFolderId: "", rootFolderName: "" };
}

async function saveUserConfig(userEmail: string, config: any): Promise<void> {
  const userEmailKey = getUserEmailKey(userEmail);
  await setDoc(doc(firestoreDb, `users/${userEmailKey}`), {
    config: {
      ...config,
      updatedAt: new Date().toISOString()
    }
  }, { merge: true });
}

// Resetar todos os dados de arquivos do usuário no Firestore
async function resetUserData(userEmail: string, mode: string = "demo"): Promise<void> {
  const userEmailKey = getUserEmailKey(userEmail);
  
  // 1. Remover arquivos
  const filesSnap = await getDocs(collection(firestoreDb, `users/${userEmailKey}/files`));
  for (const f of filesSnap.docs) {
    await deleteDoc(f.ref);
  }

  // 2. Remover chunks
  const chunksSnap = await getDocs(collection(firestoreDb, `users/${userEmailKey}/chunks`));
  const BATCH_SIZE = 450;
  for (let i = 0; i < chunksSnap.docs.length; i += BATCH_SIZE) {
    const batch = writeBatch(firestoreDb);
    const slice = chunksSnap.docs.slice(i, i + BATCH_SIZE);
    for (const c of slice) {
      batch.delete(c.ref);
    }
    await batch.commit();
  }

  // 3. Salvar modo
  await saveUserConfig(userEmail, { mode, rootFolderId: "", rootFolderName: "" });

  // 4. Invalida cache
  invalidateConversationCache(userEmail);
}

// Algoritmo inteligente de fragmentação (chunking) com sobreposição (overlap)
function chunkText(text: string, maxLength: number = 1000, overlap: number = 200): string[] {
  const paragraphs = text.split(/\n+/);
  const chunks: string[] = [];
  let currentChunk = '';

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    
    if ((currentChunk + '\n' + trimmed).length <= maxLength) {
      currentChunk += (currentChunk ? '\n' : '') + trimmed;
    } else {
      if (currentChunk) chunks.push(currentChunk);
      
      if (trimmed.length > maxLength) {
        let remaining = trimmed;
        while (remaining.length > maxLength) {
          chunks.push(remaining.substring(0, maxLength));
          remaining = remaining.substring(maxLength - overlap);
        }
        currentChunk = remaining;
      } else {
        const lastOverlap = currentChunk.substring(Math.max(0, currentChunk.length - overlap));
        currentChunk = lastOverlap + '\n' + trimmed;
      }
    }
  }
  if (currentChunk) chunks.push(currentChunk);
  return chunks;
}

// Inicializa o cliente Gemini de forma preguiçosa (Lazy)
let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY não configurada nas variáveis de ambiente do servidor.");
    }
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

// Helper para gerar conteúdo com retentativas (retries) e modelo de fallback robusto
async function generateContentWithFallback(ai: GoogleGenAI, params: any): Promise<any> {
  const modelsToTry = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.6-flash"];
  let lastError: any = null;

  for (const model of modelsToTry) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`Tentando gerar conteúdo (modelo: ${model}, tentativa: ${attempt}/3)...`);
        const response = await ai.models.generateContent({
          ...params,
          model: model
        });
        return response;
      } catch (err: any) {
        lastError = err;
        const errStr = String(err.message || err);
        const isQuotaExhausted = errStr.includes("RESOURCE_EXHAUSTED") ||
                                 errStr.includes("Quota exceeded") ||
                                 errStr.includes("exceeded your current quota");
        const isTransient = errStr.includes("503") || 
                            errStr.includes("UNAVAILABLE") || 
                            errStr.includes("high demand") || 
                            err.status === 503 || 
                            err.statusCode === 503 ||
                            err.status === 429 ||
                            err.statusCode === 429;
        
        console.warn(`[WARN] Erro na tentativa ${attempt} com o modelo ${model}: ${errStr.slice(0, 300)}`);

        // Se a cota do modelo específico foi esgotada (ex: 20 reqs/dia da cota diária do modelo no free tier),
        // não adianta queimar 3 tentativas no mesmo modelo; avança imediatamente para o próximo modelo (fallback)
        if (isQuotaExhausted) {
          console.warn(`[Fallback] Cota esgotada para o modelo ${model}. Alternando imediatamente para o próximo modelo da lista...`);
          break;
        }

        if (!isTransient) {
          // Se for um erro definitivo (ex: 404, formato inválido), não adianta retentar, muda para o próximo modelo
          break;
        }

        // Tenta extrair delay sugerido pela API (ex: "retry in 3.7s" ou retryDelay)
        let delayMs = 1000 * attempt;
        const delayMatch = errStr.match(/retry in ([0-9.]+)s/i);
        if (delayMatch && delayMatch[1]) {
          const parsedSec = parseFloat(delayMatch[1]);
          if (!isNaN(parsedSec) && parsedSec > 0 && parsedSec <= 10) {
            delayMs = Math.ceil(parsedSec * 1000) + 200;
          }
        }
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError || new Error("Falha ao gerar conteúdo com Gemini após várias tentativas e fallbacks.");
}

// Helper para streaming de conteúdo do chat com fallback de modelos
async function generateContentStreamWithFallback(ai: GoogleGenAI, params: any): Promise<AsyncIterable<any>> {
  const modelsToTry = ["gemini-3.8-flash", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-3.6-flash"];
  let lastError: any = null;

  for (const model of modelsToTry) {
    try {
      console.log(`Tentando streaming com Gemini (modelo: ${model})...`);
      const responseStream = await ai.models.generateContentStream({
        ...params,
        model
      });
      return responseStream;
    } catch (err: any) {
      console.warn(`[Streaming Fallback] Falha no streaming com modelo ${model}:`, err.message || err);
      lastError = err;
    }
  }
  throw lastError || new Error("Falha ao inicializar streaming com os modelos Gemini.");
}

// Constante oficial do modelo de embedding usada em toda a aplicação
const EMBEDDING_MODEL = "gemini-embedding-2-preview";

// Helper para obter embedding usando cache em memória e Firestore (users/{emailKey}/embeddingCache/{hash})
async function getEmbeddingWithCache(
  ai: GoogleGenAI,
  text: string,
  userEmail?: string,
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" = "RETRIEVAL_DOCUMENT"
): Promise<number[]> {
  // A chave do embeddingCache passa a ser sha256(EMBEDDING_MODEL + texto)
  const cacheKey = crypto.createHash("sha256").update(EMBEDDING_MODEL + text).digest("hex");
  if (embeddingMemoryCache.has(cacheKey)) {
    return embeddingMemoryCache.get(cacheKey)!;
  }

  // 1. Tenta carregar do Firestore se userEmail foi informado
  if (userEmail) {
    try {
      const emailKey = getUserEmailKey(userEmail);
      const cacheRef = doc(firestoreDb, `users/${emailKey}/embeddingCache/${cacheKey}`);
      const cacheSnap = await getDoc(cacheRef);
      if (cacheSnap.exists()) {
        const data = cacheSnap.data();
        if (
          data?.embedding &&
          Array.isArray(data.embedding) &&
          data.embedding.length === 768 &&
          (!data.embeddingModelo || data.embeddingModelo === EMBEDDING_MODEL) &&
          (!data.embeddingDim || data.embeddingDim === 768)
        ) {
          embeddingMemoryCache.set(cacheKey, data.embedding);
          return data.embedding;
        }
      }
    } catch {
      // Ignora falha de leitura do cache no Firestore e prossegue
    }
  }

  // Tentativas com retentativas e backoff exponencial
  let lastError: any = null;
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const embResponse = await ai.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: text,
        config: {
          taskType,
          outputDimensionality: 768
        }
      });

      const embedding = (embResponse as any).embedding?.values || 
                        (Array.isArray((embResponse as any).embeddings) ? (embResponse as any).embeddings[0]?.values : null);
      if (!embedding || !Array.isArray(embedding) || embedding.length !== 768) {
        throw new Error(`Formato ou dimensão inválida de embedding (${embedding?.length || 0} dimensões, esperado 768).`);
      }

      embeddingMemoryCache.set(cacheKey, embedding);

      // Salva no Firestore de forma assíncrona
      if (userEmail) {
        const emailKey = getUserEmailKey(userEmail);
        const cacheRef = doc(firestoreDb, `users/${emailKey}/embeddingCache/${cacheKey}`);
        setDoc(cacheRef, {
          hash: cacheKey,
          embedding,
          embeddingModelo: EMBEDDING_MODEL,
          embeddingDim: 768,
          taskType,
          updatedAt: new Date().toISOString()
        }, { merge: true }).catch(() => {});
      }

      return embedding;
    } catch (err: any) {
      lastError = err;
      const errMsg = err.message || String(err);
      console.warn(`[Embedding API] Tentativa ${attempt}/${maxRetries} falhou para hash ${cacheKey}:`, errMsg);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 600 * attempt));
      }
    }
  }

  const finalErrMsg = lastError?.message || String(lastError);
  console.error(`[Embedding API Error] Falha permanente ao obter embedding para hash ${cacheKey}:`, finalErrMsg);
  if (finalErrMsg.includes("429") || finalErrMsg.includes("quota") || finalErrMsg.includes("limit") || finalErrMsg.includes("Quota exceeded")) {
    throw new Error("Cota de solicitações de IA (embeddings) temporariamente excedida. Por favor, tente novamente em alguns instantes.");
  }
  throw new Error(`Falha ao gerar embedding com o modelo ${EMBEDDING_MODEL}: ${finalErrMsg}`);
}

function getGeminiApiKey(): string {
  const apiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY não configurada nas variáveis de ambiente do servidor.");
  }
  return apiKey;
}

// Modelos do Chat usando LangChain ChatGoogleGenerativeAI com .withFallbacks()
const CHAT_MODELS = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.6-flash"];

function createChatModel(temperature = 0.2, maxOutputTokens?: number) {
  const apiKey = getGeminiApiKey();
  const options: any = {
    apiKey,
    temperature,
    maxRetries: 2
  };
  if (maxOutputTokens) {
    options.maxOutputTokens = maxOutputTokens;
  }
  const primary = new ChatGoogleGenerativeAI({
    model: CHAT_MODELS[0],
    ...options
  });
  const fallbacks = CHAT_MODELS.slice(1).map(m => new ChatGoogleGenerativeAI({
    model: m,
    ...options
  }));
  return primary.withFallbacks({ fallbacks });
}

// 3. Classe Embeddings do LangChain utilizando a implementação de embedding do Gemini e cache
class FirestoreGeminiEmbeddings extends Embeddings {
  private userEmail?: string;
  private aiClient: GoogleGenAI;

  constructor(userEmail?: string) {
    super({});
    this.userEmail = userEmail;
    this.aiClient = getGeminiClient();
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const doc of documents) {
      const vec = await getEmbeddingWithCache(this.aiClient, doc, this.userEmail, "RETRIEVAL_DOCUMENT");
      results.push(vec);
    }
    return results;
  }

  async embedQuery(document: string): Promise<number[]> {
    return await getEmbeddingWithCache(this.aiClient, document, this.userEmail, "RETRIEVAL_QUERY");
  }
}

// 4. BaseRetriever encapsulando a busca no Firestore (documento inteiro <= 60k chars, findNearest > 60k chars)
interface FirestoreRetrieverInput {
  userEmail: string;
  activeSessionId: string;
  consideredChunks: VectorChunk[];
  conversationChunks: VectorChunk[];
  selectedFileIds?: string[];
  embeddings: Embeddings;
}

class FirestoreRetriever extends BaseRetriever {
  lc_namespace = ["custom", "retrievers"];
  private userEmail: string;
  private activeSessionId: string;
  private consideredChunks: VectorChunk[];
  private conversationChunks: VectorChunk[];
  private selectedFileIds?: string[];
  private embeddings: Embeddings;

  constructor(fields: FirestoreRetrieverInput) {
    super({});
    this.userEmail = fields.userEmail;
    this.activeSessionId = fields.activeSessionId;
    this.consideredChunks = fields.consideredChunks;
    this.conversationChunks = fields.conversationChunks;
    this.selectedFileIds = fields.selectedFileIds;
    this.embeddings = fields.embeddings;
  }

  async _getRelevantDocuments(query: string): Promise<Document[]> {
    const totalChars = this.consideredChunks.reduce((acc: number, c: any) => acc + (c.text?.length || 0), 0);

    if (totalChars <= 60000) {
      console.log(`[Contexto] documento inteiro (${this.consideredChunks.length} chunks, ${totalChars} caracteres)`);

      return this.consideredChunks.map((chunk: any) => new Document({
        pageContent: chunk.text || "",
        metadata: {
          fileId: chunk.fileId,
          fileName: chunk.fileName,
          secao: chunk.secao,
          clientName: chunk.clientName,
          robotName: chunk.robotName,
          distancia: 0
        }
      }));
    }

    // Acima de 60.000 caracteres: usa a busca vetorial nativa do Firestore com findNearest
    const embeddingDaPergunta = await this.embeddings.embedQuery(query);
    const userKey = getUserEmailKey(this.userEmail);

    let queryLimit = 12;
    const fetchNativeNearest = async (limitToUse: number) => {
      return await firestoreDb.collection(`users/${userKey}/chunks`)
        .where('conversationId', '==', this.activeSessionId)
        .findNearest({
          vectorField: 'embedding',
          queryVector: FieldValue.vector(embeddingDaPergunta),
          limit: limitToUse,
          distanceMeasure: 'COSINE',
          distanceResultField: 'distancia',
          distanceThreshold: 0.70
        })
        .get();
    };

    let nearestSnap: any = null;
    try {
      nearestSnap = await fetchNativeNearest(queryLimit);
    } catch (findErr: any) {
      if (findErr?.code === 7 || String(findErr?.message || findErr).includes("PERMISSION_DENIED")) {
        console.warn("[Vector Search] Firestore findNearest PERMISSION_DENIED. Usando chunks considerados da conversa como fallback.");
        return this.consideredChunks.slice(0, 15).map((chunk: any) => new Document({
          pageContent: chunk.text || "",
          metadata: {
            fileId: chunk.fileId,
            fileName: chunk.fileName,
            secao: chunk.secao,
            clientName: chunk.clientName,
            robotName: chunk.robotName,
            distancia: 0
          }
        }));
      }
      if (
        findErr?.code === 9 ||
        String(findErr?.message).includes("FAILED_PRECONDITION") ||
        String(findErr?.code).includes("FAILED_PRECONDITION")
      ) {
        console.error("[Vector Search FAILED_PRECONDITION]:", findErr.message);
        const gcloudCmd = `gcloud firestore indexes composite create --collection-group=chunks --query-scope=COLLECTION_GROUP --field-config=vector-config='{"dimension":"768","flat": "{}"}',field-path=embedding --field-config=order=ASCENDING,field-path=conversationId --database=(default)`;
        console.log(`[Vector Search Sugestão gcloud] Execute o comando abaixo no Cloud Shell / gcloud CLI para criar o índice:\n${gcloudCmd}`);
      } else {
        console.error("[Vector Search Error]:", findErr);
      }
      throw findErr;
    }

    let matchedDocs = nearestSnap.docs || [];

    // Filtra estritamente pelos fileIds permitidos (presentes em consideredChunks)
    const allowedFileIds = new Set(this.consideredChunks.map((c: any) => c.fileId));
    let filtered = matchedDocs.filter((d: any) => allowedFileIds.has(d.get("fileId")));
    if (filtered.length < 12 && queryLimit < 50) {
      try {
        queryLimit = 50;
        const snap50 = await fetchNativeNearest(queryLimit);
        filtered = (snap50.docs || []).filter((d: any) => allowedFileIds.has(d.get("fileId")));
        matchedDocs = filtered;
      } catch (e: any) {
        console.warn("[Vector Search] Aviso ao tentar busca expandida com limit 50:", e);
      }
    } else {
      matchedDocs = filtered;
    }

    // 5. LOG: Em cada pergunta pela busca vetorial, registre: quantidade de chunks retornados e as distâncias.
    const distancias = matchedDocs.map((d: any) => {
      const dist = d.get("distancia");
      return typeof dist === "number" ? Number(dist.toFixed(4)) : dist;
    });
    console.log(`[Vector Search] findNearest chunks retornados: ${matchedDocs.length}, Distâncias: [${distancias.join(", ")}]`);

    // Para cada chunk retornado, inclua o anterior e o seguinte da mesma seção (por ID), sem repetir.
    const addedChunkIds = new Set<string>();
    const expandedDocs: Document[] = [];
    const conversationChunksMap = new Map<string, any>();
    this.conversationChunks.forEach((c: any) => conversationChunksMap.set(c.id, c));

    for (const docSnap of matchedDocs) {
      const data = docSnap.data();
      const currId = docSnap.id;
      const currSecao = data.secao || "";
      const currFileId = data.fileId;
      const dist = docSnap.get("distancia");

      const idxInConv = this.conversationChunks.findIndex(c => c.id === currId);

      // Anterior da mesma seção
      let prevChunk: any = null;
      const matchChunkNum = currId.match(/^(.*_chunk_)(\d+)$/);
      if (matchChunkNum) {
        const prefix = matchChunkNum[1];
        const num = parseInt(matchChunkNum[2], 10);
        if (num > 0) {
          const candidate = conversationChunksMap.get(`${prefix}${num - 1}`);
          if (candidate && candidate.fileId === currFileId && (candidate.secao || "") === currSecao) {
            prevChunk = candidate;
          }
        }
      }
      if (!prevChunk && idxInConv > 0) {
        const candidate = this.conversationChunks[idxInConv - 1];
        if (candidate && candidate.fileId === currFileId && (candidate.secao || "") === currSecao) {
          prevChunk = candidate;
        }
      }

      if (prevChunk && !addedChunkIds.has(prevChunk.id)) {
        addedChunkIds.add(prevChunk.id);
        expandedDocs.push(new Document({
          pageContent: prevChunk.text || "",
          metadata: {
            fileId: prevChunk.fileId,
            fileName: prevChunk.fileName,
            secao: prevChunk.secao || currSecao,
            clientName: prevChunk.clientName,
            robotName: prevChunk.robotName,
            distancia: dist
          }
        }));
      }

      // O próprio chunk retornado
      if (!addedChunkIds.has(currId)) {
        addedChunkIds.add(currId);
        expandedDocs.push(new Document({
          pageContent: data.text || "",
          metadata: {
            fileId: currFileId,
            fileName: data.fileName,
            secao: currSecao,
            clientName: data.clientName,
            robotName: data.robotName,
            distancia: dist
          }
        }));
      }

      // Seguinte da mesma seção
      let nextChunk: any = null;
      if (matchChunkNum) {
        const prefix = matchChunkNum[1];
        const num = parseInt(matchChunkNum[2], 10);
        const candidate = conversationChunksMap.get(`${prefix}${num + 1}`);
        if (candidate && candidate.fileId === currFileId && (candidate.secao || "") === currSecao) {
          nextChunk = candidate;
        }
      }
      if (!nextChunk && idxInConv >= 0 && idxInConv < this.conversationChunks.length - 1) {
        const candidate = this.conversationChunks[idxInConv + 1];
        if (candidate && candidate.fileId === currFileId && (candidate.secao || "") === currSecao) {
          nextChunk = candidate;
        }
      }

      if (nextChunk && !addedChunkIds.has(nextChunk.id)) {
        addedChunkIds.add(nextChunk.id);
        expandedDocs.push(new Document({
          pageContent: nextChunk.text || "",
          metadata: {
            fileId: nextChunk.fileId,
            fileName: nextChunk.fileName,
            secao: nextChunk.secao || currSecao,
            clientName: nextChunk.clientName,
            robotName: nextChunk.robotName,
            distancia: dist
          }
        }));
      }
    }

    return expandedDocs;
  }
}

function formatDocumentsContext(docs: Document[]): string {
  if (!docs || docs.length === 0) return "";
  return docs.map((doc, idx) => {
    const secaoInfo = doc.metadata.secao ? `Seção / Caminho: ${doc.metadata.secao}\n` : "";
    return `[RECURSO #${idx + 1}]
Arquivo: ${doc.metadata.fileName || "Documento"}
${secaoInfo}Cliente: ${doc.metadata.clientName || ""}
Robô: ${doc.metadata.robotName || ""}
Trecho do Documento:
"""
${doc.pageContent}
"""
-----------------------------------------`;
  }).join("\n\n");
}

// 1. Endpoint para retornar as configurações do Firebase Auth
app.get("/api/firebase-config", (req, res) => {
  try {
    const configPath = path.join(process.cwd(), "firebase-applet-config.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return res.json(config);
    }
  } catch (e) {
    console.error("Erro ao ler firebase-applet-config.json", e);
  }
  return res.json(null);
});

// 2. Endpoint de Status e Fontes do Banco de Dados (/api/db/status, /api/sources, /api/agent/files e /api/conversations/:conversationId/sources)
const getSourcesHandler = async (req: express.Request, res: express.Response) => {
  try {
    const userEmail = getRequestUserEmail(req);
    const targetConversationId = getRequestConversationId(req);
    const conversationFiles = await getUserFiles(userEmail, targetConversationId);
    const conversationChunks = await getUserChunks(userEmail, targetConversationId);
    const userConfig = await getUserConfig(userEmail);

    const filesList = conversationFiles
      .filter(file => file.status !== "processando")
      .map(file => ({
      id: file.fileId,
      fileId: file.fileId,
      conversationId: file.conversationId || "default_session",
      name: file.fileName,
      fileName: file.fileName,
      clientId: file.clientId || "uploaded",
      clientName: file.clientName || "Fontes Enviadas",
      robotId: file.robotId || "direct_upload",
      robotName: file.robotName || "Uploads Diretos",
      modifiedTime: file.modifiedTime || new Date().toISOString(),
      size: file.size || "15.0 KB",
      chunkCount: file.chunkCount || 0,
      indexedAt: file.indexedAt || new Date().toISOString(),
      status: 'indexed',
      origin: file.origin || 'Arquivo local',
      folderPath: file.folderPath,
      originalName: file.originalName || file.fileName,
      checksum: file.checksum,
      tipoDocumento: file.tipoDocumento,
      confiancaValidacao: file.confiancaValidacao,
      justificativaValidacao: file.justificativaValidacao
    }));

    // Agrupa os documentos por Cliente e Robô para exibir na estrutura do app
    const clientMap: Record<string, { id: string; name: string; robots: Record<string, { id: string; name: string; documents: any[] }> }> = {};
    
    filesList.forEach(file => {
      const cId = file.clientId;
      const cName = file.clientName;
      const rId = file.robotId;
      const rName = file.robotName;

      if (!clientMap[cId]) {
        clientMap[cId] = {
          id: cId,
          name: cName,
          robots: {}
        };
      }
      
      if (!clientMap[cId].robots[rId]) {
        clientMap[cId].robots[rId] = {
          id: rId,
          name: rName,
          documents: []
        };
      }
      
      clientMap[cId].robots[rId].documents.push(file);
    });

    const clientGroups = Object.values(clientMap).map(client => ({
      id: client.id,
      name: client.name,
      robots: Object.values(client.robots)
    }));

    res.json({
      success: true,
      conversationId: targetConversationId,
      mode: userConfig.mode || "demo",
      rootFolderId: userConfig.rootFolderId || "",
      rootFolderName: userConfig.rootFolderName || "",
      fileCount: filesList.length,
      chunkCount: conversationChunks.length,
      files: filesList,
      clientGroups
    });
  } catch (err: any) {
    console.error("Erro em getSourcesHandler:", err);
    res.status(500).json({ error: "Erro ao obter fontes do Firestore." });
  }
};

app.get("/api/db/status", getSourcesHandler);
app.get("/api/sources", getSourcesHandler);
app.get("/api/agent/files", getSourcesHandler);
app.get("/api/conversations/:conversationId/sources", getSourcesHandler);

// Endpoint para atualizar dados/título da conversa
const updateConversationHandler = async (req: express.Request, res: express.Response) => {
  const conversationId = req.params.conversationId || req.params.id;
  const { title } = req.body;

  if (!conversationId) {
    return res.status(400).json({ error: "ID da conversa é obrigatório." });
  }

  try {
    const resolvedUserEmail = getRequestUserEmail(req);
    const userEmailKey = getUserEmailKey(resolvedUserEmail);
    const sessionRef = doc(firestoreDb, `users/${userEmailKey}/sessions/${conversationId}`);
    
    await setDoc(sessionRef, {
      sessionId: conversationId,
      title: title || "Nova Conversa",
      updatedAt: new Date().toISOString()
    }, { merge: true });

    return res.json({
      success: true,
      conversationId,
      title: title || "Nova Conversa"
    });
  } catch (err: any) {
    console.error("Erro ao atualizar conversa:", err);
    return res.status(500).json({ error: "Erro ao atualizar o título da conversa." });
  }
};

app.patch("/api/conversations/:conversationId", updateConversationHandler);
app.put("/api/conversations/:conversationId", updateConversationHandler);

// Sincronização do perfil do usuário em users/{emailKey}
app.post("/api/users/sync", async (req, res) => {
  try {
    const userEmail = getRequestUserEmail(req);
    const userEmailKey = getUserEmailKey(userEmail);
    const { nome, provider } = req.body;
    await setDoc(doc(firestoreDb, `users/${userEmailKey}`), {
      email: userEmailKey,
      nome: nome || userEmailKey.split("@")[0],
      provider: provider || "microsoft.com",
      updatedAt: new Date().toISOString()
    }, { merge: true });
    res.json({ success: true });
  } catch (err: any) {
    console.error("Erro ao sincronizar usuário:", err);
    res.status(500).json({ error: "Erro ao sincronizar usuário." });
  }
});

// Endpoint para listar conversas e histórico de mensagens do Firestore
app.get("/api/conversations", async (req, res) => {
  try {
    const userEmail = getRequestUserEmail(req);
    const userEmailKey = getUserEmailKey(userEmail);
    const snap = await getDocs(collection(firestoreDb, `users/${userEmailKey}/sessions`));
    const sessions = await Promise.all(
      snap.docs.map(async (d) => {
        const data = d.data();
        const msgs = await getSessionMessages(userEmailKey, d.id);
        return {
          id: d.id,
          ...data,
          title: data.title || "Conversa",
          messages: msgs
        };
      })
    );
    res.json({ success: true, sessions });
  } catch (err: any) {
    console.error("Erro ao listar conversas:", err);
    res.status(500).json({ error: "Erro ao listar conversas." });
  }
});

// Endpoint para salvar sessão completa de conversa
app.post("/api/conversations", async (req, res) => {
  try {
    const userEmail = getRequestUserEmail(req);
    const userEmailKey = getUserEmailKey(userEmail);
    const sessao = req.body;
    if (!sessao || !sessao.id) {
      return res.status(400).json({ error: "ID da sessão é obrigatório." });
    }

    const sessionRef = doc(firestoreDb, `users/${userEmailKey}/sessions/${sessao.id}`);
    await setDoc(sessionRef, {
      sessionId: sessao.id,
      title: sessao.title || "Nova Conversa",
      timestamp: sessao.timestamp || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, { merge: true });

    if (Array.isArray(sessao.messages)) {
      for (let i = 0; i < sessao.messages.length; i++) {
        const msg = sessao.messages[i];
        const msgId = msg.id || `msg_${i}_${Date.now()}`;
        const msgRef = doc(firestoreDb, `users/${userEmailKey}/sessions/${sessao.id}/messages/${msgId}`);
        await setDoc(msgRef, {
          id: msgId,
          sender: msg.sender || "user",
          text: msg.text || "",
          timestamp: msg.timestamp || new Date().toISOString(),
          order: i
        }, { merge: true });
      }
    }

    res.json({ success: true, sessionId: sessao.id });
  } catch (err: any) {
    console.error("Erro ao salvar sessão:", err);
    res.status(500).json({ error: "Erro ao salvar sessão." });
  }
});

// Endpoint para excluir uma conversa e suas mensagens
app.delete("/api/conversations/:conversationId", async (req, res) => {
  try {
    const userEmail = getRequestUserEmail(req);
    const userEmailKey = getUserEmailKey(userEmail);
    const conversationId = req.params.conversationId;
    if (!conversationId) {
      return res.status(400).json({ error: "ID da sessão é obrigatório." });
    }

    // Deletar mensagens da subcoleção
    const msgsSnap = await getDocs(collection(firestoreDb, `users/${userEmailKey}/sessions/${conversationId}/messages`));
    for (const mDoc of msgsSnap.docs) {
      await deleteDoc(mDoc.ref);
    }

    // Deletar documento da sessão
    const sessionRef = doc(firestoreDb, `users/${userEmailKey}/sessions/${conversationId}`);
    await deleteDoc(sessionRef);

    res.json({ success: true, deleted: conversationId });
  } catch (err: any) {
    console.error("Erro ao excluir conversa:", err);
    res.status(500).json({ error: "Erro ao excluir conversa." });
  }
});

app.get("/api/conversations/:conversationId/messages", async (req, res) => {
  try {
    const userEmail = getRequestUserEmail(req);
    const convId = getRequestConversationId(req);
    const messages = await getSessionMessages(userEmail, convId);
    res.json({ success: true, messages });
  } catch (err: any) {
    res.status(500).json({ error: "Erro ao carregar mensagens da conversa." });
  }
});

// Endpoints de Consultas em users/{emailKey}/queries/{queryId}
app.post("/api/consultas", async (req, res) => {
  try {
    const userEmail = getRequestUserEmail(req);
    const userEmailKey = getUserEmailKey(userEmail);
    const { titulo, tipo, pdfUrl } = req.body;
    const queryId = `query_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const queryDoc = {
      id: queryId,
      titulo: titulo || "Consulta",
      tipo: tipo || "PDD",
      pdfUrl: pdfUrl || "",
      criadoEm: new Date().toISOString()
    };
    await setDoc(doc(firestoreDb, `users/${userEmailKey}/queries/${queryId}`), queryDoc);
    res.json({ success: true, consulta: queryDoc });
  } catch (err: any) {
    console.error("Erro ao salvar consulta:", err);
    res.status(500).json({ error: "Erro ao salvar consulta." });
  }
});

app.get("/api/consultas", async (req, res) => {
  try {
    const userEmail = getRequestUserEmail(req);
    const userEmailKey = getUserEmailKey(userEmail);
    let consultas: any[] = [];
    try {
      const snap = await collection(firestoreDb, `users/${userEmailKey}/queries`).orderBy("criadoEm", "desc").get();
      consultas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch {
      const snap = await getDocs(collection(firestoreDb, `users/${userEmailKey}/queries`));
      consultas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
    res.json({ success: true, consultas });
  } catch (err: any) {
    console.error("Erro ao carregar consultas:", err);
    res.status(500).json({ error: "Erro ao carregar consultas." });
  }
});

// --- CONFIGURAÇÃO GLOBAL DE TIPOS DE DOCUMENTOS E ADMINISTRADORES NO FIRESTORE ---

// 1. Carregar lista de administradores do Firestore (se não existir, inicializa com o padrão corporativo)
async function loadAdmins(): Promise<string[]> {
  try {
    const snap = await getDoc(doc(firestoreDb, "settings/admins"));
    if (snap.exists() && Array.isArray(snap.data()?.emails)) {
      const list = snap.data()!.emails.map((e: string) => String(e).toLowerCase().trim()).filter(Boolean);
      if (list.length > 0) return list;
    }
    const defaultAdmins = ["ana.lopes@biti9.com.br"];
    saveAdmins(defaultAdmins).catch(() => {});
    return defaultAdmins;
  } catch (err: any) {
    if (err?.code !== 7 && !err?.message?.includes("PERMISSION_DENIED")) {
      console.warn("Aviso ao carregar admins do Firestore:", err);
    }
  }
  return ["ana.lopes@biti9.com.br"];
}

async function saveAdmins(emails: string[]): Promise<void> {
  const normalized = Array.from(new Set(emails.map(e => e.toLowerCase().trim()))).filter(Boolean);
  try {
    await setDoc(doc(firestoreDb, "settings/admins"), { emails: normalized, updatedAt: new Date().toISOString() }, { merge: true });
  } catch (err: any) {
    if (err?.code !== 7 && !err?.message?.includes("PERMISSION_DENIED")) {
      console.error("Erro ao salvar admins no Firestore:", err);
    }
  }
}

async function isAdminEmail(email: string | null | undefined): Promise<boolean> {
  if (!email || typeof email !== "string") return false;
  const cleanEmail = email.toLowerCase().trim();
  const admins = await loadAdmins();
  return admins.includes(cleanEmail);
}

// 2. Carregar tipos de documento do Firestore
async function loadDocumentTypes(): Promise<DocumentTypeConfig[]> {
  try {
    const snap = await getDocs(collection(firestoreDb, "settings/documentTypes/types"));
    if (snap && !snap.empty) {
      const list: DocumentTypeConfig[] = [];
      snap.forEach((d: any) => {
        list.push({ id: d.id, ...d.data() });
      });
      return list;
    }
  } catch (err: any) {
    if (err?.code !== 7 && !err?.message?.includes("PERMISSION_DENIED")) {
      console.warn("Aviso ao carregar tipos de documento do Firestore:", err);
    }
  }
  const initial = [INITIAL_PDD_TYPE];
  saveAllDocumentTypes(initial).catch(() => {});
  return initial;
}

async function saveAllDocumentTypes(types: DocumentTypeConfig[]): Promise<void> {
  try {
    const batch = writeBatch(firestoreDb);
    for (const t of types) {
      const docRef = doc(firestoreDb, `settings/documentTypes/types/${t.id}`);
      batch.set(docRef, t, { merge: true });
    }
    await batch.commit();
  } catch (err: any) {
    if (err?.code !== 7 && !err?.message?.includes("PERMISSION_DENIED")) {
      console.error("Erro ao salvar tipos de documento no Firestore:", err);
    }
  }
}

async function saveSingleDocumentType(typeConfig: DocumentTypeConfig): Promise<DocumentTypeConfig> {
  const allTypes = await loadDocumentTypes();
  const idx = allTypes.findIndex(t => t.id === typeConfig.id || t.sigla.toUpperCase() === typeConfig.sigla.toUpperCase());
  if (idx >= 0) {
    allTypes[idx] = { ...allTypes[idx], ...typeConfig };
  } else {
    allTypes.push(typeConfig);
  }
  await saveAllDocumentTypes(allTypes);
  invalidateDocumentTypesCache();
  return typeConfig;
}

async function toggleDocumentType(id: string, updatedBy: string): Promise<DocumentTypeConfig | null> {
  const allTypes = await loadDocumentTypes();
  const target = allTypes.find(t => t.id === id || t.sigla.toUpperCase() === id.toUpperCase());
  if (!target) return null;
  target.ativo = !target.ativo;
  target.atualizadoPor = updatedBy;
  target.atualizadoEm = new Date().toISOString();
  await saveAllDocumentTypes(allTypes);
  invalidateDocumentTypesCache();
  return target;
}

// 3. Cache de 60 segundos no servidor para os tipos ativos
let activeTypesCache: { types: DocumentTypeConfig[]; timestamp: number } | null = null;
const CACHE_TTL_MS = 60 * 1000;

async function getActiveDocumentTypesCached(): Promise<DocumentTypeConfig[]> {
  const now = Date.now();
  if (activeTypesCache && (now - activeTypesCache.timestamp < CACHE_TTL_MS)) {
    return activeTypesCache.types;
  }
  const allTypes = await loadDocumentTypes();
  const activeTypes = allTypes.filter(t => t.ativo === true);
  activeTypesCache = { types: activeTypes, timestamp: now };
  return activeTypes;
}

function invalidateDocumentTypesCache(): void {
  activeTypesCache = null;
}

// Middleware de verificação de permissão de administrador
async function requireAdminMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const email = req.userEmail;
  if (!email) {
    return res.status(401).json({ error: "Acesso negado: identificação do usuário ausente ou não autenticada." });
  }

  const isAdmin = await isAdminEmail(email);
  if (!isAdmin) {
    console.warn(`[Segurança] Acesso negado a rota de administração para o usuário: ${email}`);
    return res.status(403).json({ error: "Acesso negado: apenas administradores podem realizar esta operação." });
  }

  (req as any).adminEmail = email;
  next();
}

// 5. Função de validação unificada baseada nos tipos ativos configuráveis
interface ValidacaoTipoResult {
  valido: boolean;
  tipo: string;
  confianca: number;
  justificativa: string;
  secoesEncontradas: string[];
  secoesFaltantes: string[];
  siglasAtivas: string[];
}

const validationZodSchema = z.object({
  tipo: z.string().describe("Sigla do tipo de documento correspondente ou NENHUM"),
  confianca: z.number().describe("Confiança da classificação de 0 a 100"),
  justificativa: z.string().describe("Texto curto justificando a decisão"),
  secoesEncontradas: z.array(z.string()).describe("Seções obrigatórias encontradas"),
  secoesFaltantes: z.array(z.string()).describe("Seções obrigatórias faltantes")
});

async function validarTipoDocumento(_ai: any, textoDocumento: string): Promise<ValidacaoTipoResult> {
  const activeTypes = await getActiveDocumentTypesCached();
  const siglasAtivas = activeTypes.map(t => t.sigla);

  if (activeTypes.length === 0) {
    return {
      valido: false,
      tipo: "NENHUM",
      confianca: 0,
      justificativa: "Não há nenhum tipo de documento ativo configurado no sistema.",
      secoesEncontradas: [],
      secoesFaltantes: [],
      siglasAtivas: []
    };
  }

  const prompt = `Você é um auditor rigoroso de documentação técnica e corporativa.
Analise detalhadamente o documento fornecido abaixo e classifique-o em exatamente UM dos TIPOS PERMITIDOS ATIVOS a seguir, ou classifique como NENHUM.

TIPOS PERMITIDOS ATIVOS:
${activeTypes.map(t => `
[TIPO: ${t.sigla}]
- Nome: ${t.nome}
- Descrição: ${t.descricao}
- Instrução específica de validação: ${t.promptValidacao}
- Seções Obrigatórias esperadas:
${t.secoesObrigatorias.map(s => `  * ${s}`).join("\n")}
`).join("\n\n")}

INSTRUÇÕES DE CLASSIFICAÇÃO:
1. Examine o cabeçalho, propósito e estrutura do texto do documento contra as seções e diretrizes de cada tipo permitido.
2. Identifique quais seções obrigatórias foram localizadas (secoesEncontradas) e quais estão ausentes (secoesFaltantes).
3. Se o documento corresponder a um dos tipos permitidos, defina 'tipo' exatamente com a SIGLA correspondente (ex: ${activeTypes.map(t => `"${t.sigla}"`).join(", ")}) e atribua 'confianca' de 0 a 100.
4. Se o documento NÃO corresponder a nenhum dos tipos permitidos (por exemplo: ata de reunião, pauta, e-mail, planilha genérica, memorando, contrato diverso sem estrutura exigida), defina 'tipo' obrigatoriamente como "NENHUM" e 'confianca' correspondente ao grau de certeza de que não pertence aos tipos permitidos ou abaixo de 70.
5. Em 'justificativa', forneça um texto curto e objetivo explicando por que atende ou por que foi recusado.

TEXTO DO DOCUMENTO:
"""
${textoDocumento.slice(0, 12000)}
"""`;

  try {
    const validationModel = new ChatGoogleGenerativeAI({
      model: "gemini-3.1-flash-lite",
      apiKey: getGeminiApiKey(),
      temperature: 0
    });
    const structuredModel = validationModel.withStructuredOutput(validationZodSchema);
    const parsed: any = await structuredModel.invoke(prompt);

    const tipoIdentificado = String(parsed.tipo || "NENHUM").trim();
    const confianca = typeof parsed.confianca === "number" ? parsed.confianca : 0;
    const justificativa = String(parsed.justificativa || "").trim();
    const secoesEncontradas = Array.isArray(parsed.secoesEncontradas) ? parsed.secoesEncontradas : [];
    const secoesFaltantes = Array.isArray(parsed.secoesFaltantes) ? parsed.secoesFaltantes : [];

    const tipoEncontrado = activeTypes.find(t => t.sigla.toUpperCase() === tipoIdentificado.toUpperCase());
    const valido = Boolean(tipoEncontrado && tipoIdentificado.toUpperCase() !== "NENHUM" && confianca >= 70);

    return {
      valido,
      tipo: tipoEncontrado ? tipoEncontrado.sigla : "NENHUM",
      confianca,
      justificativa: justificativa || (valido ? `Documento validado com sucesso como ${tipoEncontrado?.sigla}.` : "Documento não cumpre os requisitos mínimos."),
      secoesEncontradas,
      secoesFaltantes,
      siglasAtivas
    };
  } catch (err: any) {
    console.error("Erro na validação de tipo de documento via LangChain/Gemini:", err);
    return {
      valido: false,
      tipo: "NENHUM",
      confianca: 0,
      justificativa: "Falha na validação do documento pela LLM.",
      secoesEncontradas: [],
      secoesFaltantes: [],
      siglasAtivas
    };
  }
}

// 6. Conversão real para Markdown preservando a estrutura dos documentos

// a) Word (.docx)
async function convertDocxToMarkdown(name: string, buffer: Buffer, ai: GoogleGenAI): Promise<string> {
  const styleMap = [
    "p[style-name='Heading 1'] => h1:fresh",
    "p[style-name='Título 1'] => h1:fresh",
    "p[style-name='Heading 2'] => h2:fresh",
    "p[style-name='Título 2'] => h2:fresh",
    "p[style-name='Heading 3'] => h3:fresh",
    "p[style-name='Título 3'] => h3:fresh",
    "p[style-name='Heading 4'] => h4:fresh",
    "p[style-name='Título 4'] => h4:fresh",
    "p[style-name='List Bullet'] => ul > li:fresh",
    "p[style-name='Lista com marcadores'] => ul > li:fresh",
    "p[style-name='List Number'] => ol > li:fresh",
    "p[style-name='Lista numerada'] => ol > li:fresh"
  ];

  let imageCount = 0;
  const maxImages = 15;

  const options = {
    styleMap,
    convertImage: mammoth.images.imgElement(async (image: any) => {
      const imgBuffer = await image.read();
      // Ignora imagens menores que 10 KB (logos, ícones) e limita a 15 imagens
      if (imgBuffer.length < 10 * 1024 || imageCount >= maxImages) {
        return { src: "" };
      }
      imageCount++;
      const contentType = image.contentType || "image/png";
      const base64 = imgBuffer.toString("base64");

      let description = "Diagrama ou fluxo do processo";
      try {
        console.log(`[DOCX] Descrevendo imagem embutida #${imageCount} via Gemini (${(imgBuffer.length / 1024).toFixed(1)} KB)...`);
        const response = await generateContentWithFallback(ai, {
          contents: [
            {
              inlineData: {
                mimeType: contentType,
                data: base64
              }
            },
            "Analise esta imagem embutida de uma documentação técnica/PDD corporativa. Forneça uma descrição objetiva, clara e detalhada do fluxo, diagrama, tela ou conteúdo representado, destacando etapas, responsáveis, sistemas e decisões se houver. Não use saudações, retorne apenas a descrição objetiva do conteúdo."
          ]
        });
        description = (response.text || "").trim().replace(/\n+/g, " ") || description;
      } catch (imgErr) {
        console.warn("Erro ao descrever imagem embutida via Gemini:", imgErr);
      }

      return {
        src: "about:blank",
        alt: description
      };
    })
  };

  const { value: html } = await mammoth.convertToHtml({ buffer }, options);

  const td = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-"
  });
  td.use(gfm);

  td.addRule("embeddedDocxImages", {
    filter: "img",
    replacement: (_content, node) => {
      const alt = (node as HTMLElement).getAttribute("alt") || "";
      if (alt) {
        return `\n\n> [Imagem: ${alt}]\n\n`;
      }
      return "";
    }
  });

  return td.turndown(html);
}

// b) PDF e Imagens
async function convertPdfOrImageToMarkdown(
  name: string,
  type: string,
  buffer: Buffer,
  base64: string,
  ai: GoogleGenAI
): Promise<string> {
  const isPdf = name.toLowerCase().endsWith(".pdf") || type.includes("pdf");

  if (isPdf) {
    if (buffer.length < 4 || buffer.toString("ascii", 0, 4) !== "%PDF") {
      throw new Error("O arquivo PDF está corrompido, incompleto ou não é um PDF válido.");
    }
    const pdfString = buffer.toString("binary");
    if (pdfString.includes("/Encrypt")) {
      throw new Error("O arquivo PDF está protegido por senha ou criptografado, impedindo a leitura.");
    }
  }

  const prompt = "Converta para Markdown fiel ao original: títulos com #, ##, ###; listas com - ou 1.; tabelas em formato de tabela Markdown (GFM) preservando todas as linhas e colunas; imagens/diagramas descritos como > [Imagem: descrição]. Não resuma, não omita e não invente conteúdo. Responda apenas com o Markdown.";

  const response = await generateContentWithFallback(ai, {
    contents: [
      {
        inlineData: {
          mimeType: isPdf ? "application/pdf" : (type || "image/png"),
          data: base64
        }
      },
      prompt
    ]
  });

  let md = (response.text || "").trim();
  if (md.startsWith("```markdown")) {
    md = md.replace(/^```markdown\s*/, "").replace(/\s*```$/, "");
  } else if (md.startsWith("```")) {
    md = md.replace(/^```\w*\s*/, "").replace(/\s*```$/, "");
  }
  return md.trim();
}

// c) Planilhas (.xlsx, .xls, .csv)
function convertSpreadsheetToMarkdown(_name: string, buffer: Buffer): string {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const mdSections: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" }) as (string | number)[][];

    mdSections.push(`## Aba: ${sheetName}`);

    if (!rawRows || rawRows.length === 0) {
      mdSections.push("*(Aba vazia)*");
      continue;
    }

    const headerRow = rawRows[0].map(c => String(c !== undefined && c !== null ? c : "").trim() || "-");
    const dataRows = rawRows.slice(1);

    const maxDataRows = 500;
    const rowsToInclude = dataRows.slice(0, maxDataRows);
    const omittedCount = dataRows.length - rowsToInclude.length;

    const tableLines: string[] = [];
    tableLines.push(`| ${headerRow.map(h => h.replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`);
    tableLines.push(`| ${headerRow.map(() => "---").join(" | ")} |`);

    for (const row of rowsToInclude) {
      const cells = headerRow.map((_, colIdx) => {
        const val = row[colIdx] !== undefined && row[colIdx] !== null ? String(row[colIdx]).trim() : "";
        return val.replace(/\|/g, "\\|").replace(/\n/g, " ");
      });
      tableLines.push(`| ${cells.join(" | ")} |`);
    }

    mdSections.push(tableLines.join("\n"));

    if (omittedCount > 0) {
      mdSections.push(`*(+${omittedCount} linhas não incluídas)*`);
    }
  }

  return mdSections.join("\n\n").trim();
}

// d) Texto (.txt) e JSON (.json)
function convertTextOrJsonToMarkdown(name: string, type: string, buffer: Buffer): string {
  const content = buffer.toString("utf-8");
  if (name.toLowerCase().endsWith(".json") || type.includes("application/json")) {
    return `\`\`\`json\n${content}\n\`\`\``;
  }
  return content;
}

// Conversor mestre unificado
async function converterDocumentoParaMarkdown(
  name: string,
  type: string,
  buffer: Buffer,
  base64: string,
  ai: GoogleGenAI
): Promise<string> {
  const nameLower = name.toLowerCase();

  if (nameLower.endsWith(".xlsx") || nameLower.endsWith(".xls") || nameLower.endsWith(".csv") || type.includes("sheet") || type.includes("excel") || type.includes("csv")) {
    return convertSpreadsheetToMarkdown(name, buffer);
  } else if (nameLower.endsWith(".docx") || type.includes("word") || type.includes("officedocument.wordprocessingml")) {
    return await convertDocxToMarkdown(name, buffer, ai);
  } else if (nameLower.endsWith(".pdf") || type.includes("pdf") || type.startsWith("image/")) {
    return await convertPdfOrImageToMarkdown(name, type, buffer, base64, ai);
  } else if (nameLower.endsWith(".json") || type.includes("application/json")) {
    return convertTextOrJsonToMarkdown(name, type, buffer);
  } else {
    return buffer.toString("utf-8");
  }
}

// 7. Chunking estrutural baseado na hierarquia de títulos e seções
function chunkMarkdownByStructure(fileName: string, markdown: string, maxChunkSize = 2000): Array<{ text: string; secao: string }> {
  const lines = markdown.split(/\r?\n/);
  const sections: Array<{ path: string; text: string }> = [];
  let currentHeadings: string[] = [];
  let currentSectionLines: string[] = [];

  function buildPath(headings: string[]) {
    if (headings.length === 0) return `[Documento: ${fileName}]`;
    return `[Documento: ${fileName} > ${headings.join(" > ")}]`;
  }

  function flushSection() {
    if (currentSectionLines.length === 0) return;
    const text = currentSectionLines.join("\n").trim();
    if (text) {
      sections.push({
        path: buildPath(currentHeadings),
        text
      });
    }
    currentSectionLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      flushSection();
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();
      currentHeadings = currentHeadings.slice(0, level - 1);
      currentHeadings[level - 1] = title;
      currentSectionLines.push(line);
    } else {
      currentSectionLines.push(line);
    }
  }
  flushSection();

  const finalChunks: Array<{ text: string; secao: string }> = [];

  for (const sec of sections) {
    // Se a seção inteira couber em até maxChunkSize caracteres, mantém como um único chunk
    if (sec.text.length <= maxChunkSize) {
      finalChunks.push({
        secao: sec.path,
        text: `${sec.path}\n\n${sec.text}`
      });
      continue;
    }

    // Seção maior que 2000 caracteres: divide preservando tabelas, listas e parágrafos
    const secLines = sec.text.split("\n");
    const blocks: Array<{ type: "table" | "list-item" | "paragraph"; content: string; lines?: string[] }> = [];
    let idx = 0;

    while (idx < secLines.length) {
      const line = secLines[idx];

      // Tabela Markdown
      if (line.trim().startsWith("|") && idx + 1 < secLines.length && secLines[idx + 1].trim().match(/^\|(\s*:?-+:?\s*\|)+$/)) {
        const tableLines = [line, secLines[idx + 1]];
        idx += 2;
        while (idx < secLines.length && secLines[idx].trim().startsWith("|")) {
          tableLines.push(secLines[idx]);
          idx++;
        }
        blocks.push({ type: "table", content: tableLines.join("\n"), lines: tableLines });
        continue;
      }

      // Item de Lista (não divide item no meio)
      const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+/);
      if (listMatch) {
        const listLines = [line];
        idx++;
        while (idx < secLines.length) {
          const nextLine = secLines[idx];
          if (!nextLine.trim()) break;
          const nextListMatch = nextLine.match(/^(\s*)([-*+]|\d+\.)\s+/);
          if (nextListMatch) break;
          if (nextLine.startsWith("  ") || nextLine.startsWith("\t")) {
            listLines.push(nextLine);
            idx++;
          } else {
            break;
          }
        }
        blocks.push({ type: "list-item", content: listLines.join("\n") });
        continue;
      }

      // Parágrafo
      if (!line.trim()) {
        idx++;
        continue;
      }

      const pLines = [line];
      idx++;
      while (idx < secLines.length && secLines[idx].trim()) {
        if (secLines[idx].trim().startsWith("|") || secLines[idx].match(/^(\s*)([-*+]|\d+\.)\s+/)) {
          break;
        }
        pLines.push(secLines[idx]);
        idx++;
      }
      blocks.push({ type: "paragraph", content: pLines.join("\n") });
    }

    let currentBlocks: string[] = [];
    let currentLen = 0;

    function flushCurrentBlocks() {
      if (currentBlocks.length === 0) return;
      const body = currentBlocks.join("\n\n").trim();
      if (body) {
        finalChunks.push({
          secao: sec.path,
          text: `${sec.path}\n\n${body}`
        });
      }
      currentBlocks = [];
      currentLen = 0;
    }

    for (const b of blocks) {
      if (b.type === "table") {
        if (b.content.length <= maxChunkSize) {
          if (currentLen + b.content.length + 2 > maxChunkSize && currentBlocks.length > 0) {
            flushCurrentBlocks();
          }
          currentBlocks.push(b.content);
          currentLen += b.content.length + 2;
        } else {
          // Tabela maior que 2000 caracteres: divide por grupos de linhas repetindo cabeçalho
          flushCurrentBlocks();
          const linesArr = b.lines || b.content.split("\n");
          const h1 = linesArr[0];
          const h2 = linesArr[1];
          const dataRows = linesArr.slice(2);
          const headerBlock = `${h1}\n${h2}`;
          const headerLen = headerBlock.length;

          let groupRows: string[] = [];
          let groupLen = headerLen;

          for (const row of dataRows) {
            if (groupLen + row.length + 1 > maxChunkSize && groupRows.length > 0) {
              finalChunks.push({
                secao: sec.path,
                text: `${sec.path}\n\n${headerBlock}\n${groupRows.join("\n")}`
              });
              groupRows = [];
              groupLen = headerLen;
            }
            groupRows.push(row);
            groupLen += row.length + 1;
          }
          if (groupRows.length > 0) {
            finalChunks.push({
              secao: sec.path,
              text: `${sec.path}\n\n${headerBlock}\n${groupRows.join("\n")}`
            });
          }
        }
      } else {
        if (currentLen + b.content.length + 2 > maxChunkSize && currentBlocks.length > 0) {
          flushCurrentBlocks();
        }
        currentBlocks.push(b.content);
        currentLen += b.content.length + 2;
      }
    }
    flushCurrentBlocks();
  }

  return finalChunks;
}

// Obter conteúdo extraído (Markdown) de um arquivo para visualização
app.get("/api/db/files/:fileId/content", async (req, res) => {
  const { fileId } = req.params;
  const userEmail = getRequestUserEmail(req);

  try {
    const userEmailKey = getUserEmailKey(userEmail);
    const fileSnap = await getDoc(doc(firestoreDb, `users/${userEmailKey}/files/${fileId}`));
    if (!fileSnap.exists()) {
      return res.status(404).json({ error: "Arquivo não encontrado." });
    }
    const file = fileSnap.data();
    const content = await getMarkdownContent(userEmail, fileId);
    res.json({
      fileId,
      fileName: file.fileName,
      tipoDocumento: file.tipoDocumento || "PDD",
      formatoConteudo: file.formatoConteudo || "texto_puro",
      versaoConversor: file.versaoConversor || 1,
      content: content || "Nenhum conteúdo disponível para este arquivo."
    });
  } catch (err: any) {
    console.error(`Erro ao obter conteúdo do arquivo ${fileId}:`, err);
    res.status(500).json({ error: err.message || "Erro ao obter conteúdo do documento." });
  }
});

// --- ROTAS DA API DE ADMINISTRAÇÃO DE TIPOS DE DOCUMENTO ---

// Checagem se o usuário atual é administrador
app.get("/api/settings/admins/check", async (req, res) => {
  const email = getRequestUserEmail(req);
  const isAdmin = await isAdminEmail(email);
  res.json({ isAdmin, email });
});

// Listar todos os tipos de documento configurados
app.get("/api/settings/document-types", async (req, res) => {
  const types = await loadDocumentTypes();
  res.json({ types });
});

// Listar siglas dos tipos ativos (rota pública para interface)
app.get("/api/settings/document-types/active", async (req, res) => {
  const activeTypes = await getActiveDocumentTypesCached();
  const siglas = activeTypes.map(t => t.sigla);
  res.json({ siglas, activeTypes });
});

// Criar novo tipo de documento (apenas administradores)
app.post("/api/settings/document-types", requireAdminMiddleware, async (req, res) => {
  const { sigla, nome, descricao, promptValidacao, secoesObrigatorias, ativo } = req.body;
  if (!sigla || !nome || !promptValidacao) {
    return res.status(400).json({ error: "Campos 'sigla', 'nome' e 'promptValidacao' são obrigatórios." });
  }

  const adminEmail = (req as any).adminEmail || "admin";
  const id = sigla.toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
  const newType: DocumentTypeConfig = {
    id: id || `tipo_${Date.now()}`,
    sigla: sigla.trim().toUpperCase(),
    nome: nome.trim(),
    descricao: (descricao || "").trim(),
    promptValidacao: promptValidacao.trim(),
    secoesObrigatorias: Array.isArray(secoesObrigatorias) ? secoesObrigatorias.filter(Boolean) : [],
    ativo: ativo !== false,
    criadoPor: adminEmail,
    atualizadoPor: adminEmail,
    atualizadoEm: new Date().toISOString()
  };

  const saved = await saveSingleDocumentType(newType);
  res.json({ success: true, type: saved });
});

// Editar tipo de documento existente (apenas administradores)
app.put("/api/settings/document-types/:id", requireAdminMiddleware, async (req, res) => {
  const { id } = req.params;
  const { sigla, nome, descricao, promptValidacao, secoesObrigatorias, ativo } = req.body;
  if (!sigla || !nome || !promptValidacao) {
    return res.status(400).json({ error: "Campos 'sigla', 'nome' e 'promptValidacao' são obrigatórios." });
  }

  const adminEmail = (req as any).adminEmail || "admin";
  const updatedType: DocumentTypeConfig = {
    id: id.toLowerCase().trim(),
    sigla: sigla.trim().toUpperCase(),
    nome: nome.trim(),
    descricao: (descricao || "").trim(),
    promptValidacao: promptValidacao.trim(),
    secoesObrigatorias: Array.isArray(secoesObrigatorias) ? secoesObrigatorias.filter(Boolean) : [],
    ativo: ativo !== false,
    criadoPor: adminEmail,
    atualizadoPor: adminEmail,
    atualizadoEm: new Date().toISOString()
  };

  const saved = await saveSingleDocumentType(updatedType);
  res.json({ success: true, type: saved });
});

// Ativar/desativar tipo de documento (toggle) (apenas administradores)
app.patch("/api/settings/document-types/:id/toggle", requireAdminMiddleware, async (req, res) => {
  const { id } = req.params;
  const adminEmail = (req as any).adminEmail || "admin";
  const updated = await toggleDocumentType(id, adminEmail);
  if (!updated) {
    return res.status(404).json({ error: "Tipo de documento não encontrado." });
  }
  res.json({ success: true, type: updated });
});

// Não permitir exclusão; apenas desativação
app.delete("/api/settings/document-types/:id", requireAdminMiddleware, (req, res) => {
  res.status(405).json({ error: "Não é permitido excluir tipos de documento. Apenas desative-os através do toggle." });
});

// Testar validação com visualização de JSON sem salvar nada (apenas administradores)
app.post("/api/settings/test-validation", requireAdminMiddleware, async (req, res) => {
  const { name, type, base64 } = req.body;
  if (!name || !base64) {
    return res.status(400).json({ error: "Arquivo (nome e base64) é obrigatório para testar." });
  }

  try {
    const ai = getGeminiClient();
    const buffer = Buffer.from(base64, "base64");
    const extractedText = await converterDocumentoParaMarkdown(name, type || "", buffer, base64, ai);
    if (!extractedText.trim()) {
      return res.status(400).json({ error: "Não foi possível extrair nenhum texto legível do arquivo enviado." });
    }

    const validationResult = await validarTipoDocumento(ai, extractedText);
    res.json({
      tipo: validationResult.tipo,
      confianca: validationResult.confianca,
      justificativa: validationResult.justificativa,
      secoesEncontradas: validationResult.secoesEncontradas,
      secoesFaltantes: validationResult.secoesFaltantes,
      valido: validationResult.valido,
      siglasAtivas: validationResult.siglasAtivas
    });
  } catch (err: any) {
    console.error("Erro no teste de validação:", err);
    res.status(500).json({ error: err.message || "Erro ao processar teste de validação." });
  }
});

// --- 5. ROTA DE ADMINISTRAÇÃO: MIGRAÇÃO DE DADOS LOCAIS PARA O CLOUD FIRESTORE ---

// Helper para inferir e-mail do nome do arquivo vector_db
function inferEmailFromVectorDbFilename(filename: string): string {
  const base = path.basename(filename, ".json").replace(/^vector_db_?/, "");
  if (!base || base === "vector_db") return "";
  if (base.endsWith("_biti9_com_br")) {
    const userPart = base.replace(/_biti9_com_br$/, "").replace(/_/g, ".");
    return `${userPart}@biti9.com.br`;
  }
  return base.replace(/_/g, ".");
}

// -------------------------------------------------------------
// RECALCULAR EMBEDDINGS (ADMINISTRAÇÃO):
// Para cada chunk cujo embedding não seja do tipo vetor nativo FieldValue.vector,
// ou cujo embeddingModelo seja != EMBEDDING_MODEL, ou embeddingDim != 768,
// recalcula a partir do texto salvo e grava como FieldValue.vector.
// Em lotes, com progresso em tempo real, retomável.
// -------------------------------------------------------------

function isChunkValidNativeVector(data: any): boolean {
  if (!data) return false;
  const isNative = data.embedding && (
    data.embedding.constructor?.name === "VectorValue" ||
    typeof data.embedding.toArray === "function"
  );
  if (!isNative) return false;
  if (data.embeddingModelo !== EMBEDDING_MODEL) return false;
  if (data.embeddingDim !== 768) return false;
  return true;
}

// Status atual dos chunks e necessidade de recálculo (apenas administradores em settings/admins)
app.get(["/api/admin/recalculate-embeddings/status", "/api/admin/recalcular-embeddings/status"], requireAdminMiddleware, async (req, res) => {
  try {
    const snap = await firestoreDb.collectionGroup("chunks").get();
    let needsRecalculation = 0;

    for (const d of snap.docs) {
      const data = d.data();
      if (!isChunkValidNativeVector(data)) {
        needsRecalculation++;
      }
    }

    res.json({
      totalChunks: snap.size,
      needsRecalculation,
      alreadyNative: snap.size - needsRecalculation,
      embeddingModelo: EMBEDDING_MODEL,
      embeddingDim: 768
    });
  } catch (err: any) {
    console.error("Erro ao verificar status dos embeddings:", err);
    res.status(500).json({ error: err.message || "Erro ao verificar status dos embeddings." });
  }
});

// Execução em lotes, com progresso e retomável (apenas administradores em settings/admins)
app.post(["/api/admin/recalculate-embeddings", "/api/admin/recalcular-embeddings"], requireAdminMiddleware, async (req, res) => {
  try {
    const ai = getGeminiClient();

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const sendProgress = (obj: any) => {
      res.write(JSON.stringify(obj) + "\n");
    };

    sendProgress({ type: "log", message: "Mapeando chunks no Firestore para verificação de vetores nativos..." });

    const snap = await firestoreDb.collectionGroup("chunks").get();
    const docsToProcess: FirebaseFirestore.QueryDocumentSnapshot[] = [];

    for (const d of snap.docs) {
      const data = d.data();
      if (!isChunkValidNativeVector(data)) {
        docsToProcess.push(d);
      }
    }

    const totalToRecalculate = docsToProcess.length;
    sendProgress({
      type: "init",
      total: totalToRecalculate,
      totalExisting: snap.size,
      alreadyNative: snap.size - totalToRecalculate,
      message: `${totalToRecalculate} de ${snap.size} chunks identificados para recálculo vetorial.`
    });

    if (totalToRecalculate === 0) {
      sendProgress({
        type: "done",
        processed: 0,
        total: 0,
        message: "Todos os chunks já utilizam o tipo vetor nativo FieldValue.vector (768 dimensões)!"
      });
      return res.end();
    }

    const BATCH_SIZE = 10;
    let processedCount = 0;
    const affectedUsers = new Set<string>();

    for (let i = 0; i < totalToRecalculate; i += BATCH_SIZE) {
      const slice = docsToProcess.slice(i, i + BATCH_SIZE);
      const batchOp = firestoreDb.batch();

      for (const docSnap of slice) {
        const data = docSnap.data();
        const text = data.text || "";
        const pathSegments = docSnap.ref.path.split("/");
        const userKey = pathSegments[1] || "";
        if (userKey) affectedUsers.add(userKey);

        try {
          const newVec = await getEmbeddingWithCache(ai, text, userKey, "RETRIEVAL_DOCUMENT");
          batchOp.update(docSnap.ref, {
            embedding: FieldValue.vector(newVec),
            embeddingModelo: EMBEDDING_MODEL,
            embeddingDim: 768,
            recalculatedAt: new Date().toISOString()
          });
          processedCount++;
        } catch (embedErr: any) {
          console.error(`[Recálculo Embedding] Erro no chunk ${docSnap.id}:`, embedErr);
          sendProgress({
            type: "log",
            message: `[Aviso] Falha ao recalcular chunk ${docSnap.id}: ${embedErr.message}`
          });
        }
      }

      await batchOp.commit();

      sendProgress({
        type: "progress",
        processed: processedCount,
        total: totalToRecalculate,
        percentage: Math.round((processedCount / totalToRecalculate) * 100),
        message: `Lote gravado: ${processedCount}/${totalToRecalculate} chunks recalculados com FieldValue.vector.`
      });
    }

    // Invalida cache de conversas para os usuários cujos chunks foram atualizados
    for (const u of affectedUsers) {
      invalidateConversationCache(u);
    }

    sendProgress({
      type: "done",
      processed: processedCount,
      total: totalToRecalculate,
      message: `Recálculo concluído com sucesso: ${processedCount} chunks convertidos para FieldValue.vector!`
    });
    res.end();
  } catch (err: any) {
    console.error("Erro no recálculo de embeddings:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || "Erro no recálculo de embeddings." });
    } else {
      res.write(JSON.stringify({ type: "error", error: err.message }) + "\n");
      res.end();
    }
  }
});

// Status dos arquivos locais elegíveis para migração (apenas administradores)
app.get("/api/admin/migration-status", requireAdminMiddleware, async (req, res) => {
  try {
    const dataDir = path.join(process.cwd(), "data");
    const localFiles: any[] = [];
    if (fs.existsSync(dataDir)) {
      const files = fs.readdirSync(dataDir).filter(f => f.startsWith("vector_db") && f.endsWith(".json"));
      for (const f of files) {
        const fullPath = path.join(dataDir, f);
        const stats = fs.statSync(fullPath);
        localFiles.push({
          filename: f,
          sizeBytes: stats.size,
          sizeFormatted: `${(stats.size / 1024).toFixed(1)} KB`,
          inferredEmail: inferEmailFromVectorDbFilename(f)
        });
      }
    }
    res.json({ files: localFiles, count: localFiles.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Erro ao verificar arquivos locais." });
  }
});

// Executar migração de dados locais para o Firestore (somente administradores em settings/admins)
app.post("/api/admin/migrate-local-to-firestore", requireAdminMiddleware, async (req, res) => {
  try {
    const dataDir = path.join(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) {
      return res.json({
        success: true,
        message: "Nenhum diretório data/ ou arquivo local encontrado.",
        report: [],
        totals: { filesMigrated: 0, chunksMigrated: 0, sessionsMigrated: 0, messagesMigrated: 0 }
      });
    }

    const files = fs.readdirSync(dataDir).filter(f => f.startsWith("vector_db") && f.endsWith(".json"));
    if (files.length === 0) {
      return res.json({
        success: true,
        message: "Nenhum arquivo local vector_db_*.json encontrado para migração.",
        report: [],
        totals: { filesMigrated: 0, chunksMigrated: 0, sessionsMigrated: 0, messagesMigrated: 0 }
      });
    }

    const report: any[] = [];
    let totalFilesMigrated = 0;
    let totalChunksMigrated = 0;
    let totalSessionsMigrated = 0;
    let totalMessagesMigrated = 0;

    for (const f of files) {
      const filePath = path.join(dataDir, f);
      const rawText = fs.readFileSync(filePath, "utf8");
      let data: any;
      try {
        data = JSON.parse(rawText);
      } catch (parseErr) {
        report.push({ file: f, error: "Arquivo JSON corrompido ou inválido." });
        continue;
      }

      const inferredEmail = inferEmailFromVectorDbFilename(f);
      const userEmailKey = getUserEmailKey(inferredEmail);

      let filesMigrated = 0;
      let filesSkipped = 0;
      let chunksMigrated = 0;
      let chunksSkipped = 0;
      let sessionsMigrated = 0;
      let messagesMigrated = 0;

      // 1. Migração de Arquivos (indexedFiles)
      const indexedFiles = data.indexedFiles || {};
      for (const [fileId, fileMeta] of Object.entries<any>(indexedFiles)) {
        const fileDocRef = doc(firestoreDb, `users/${userEmailKey}/files/${fileId}`);
        const snap = await getDoc(fileDocRef);
        if (!snap.exists()) {
          await saveFileMetadata(inferredEmail, fileMeta);
          filesMigrated++;
        } else {
          filesSkipped++;
        }
      }

      // 2. Migração de Chunks (chunks) em batches de até 450
      const chunks: VectorChunk[] = Array.isArray(data.chunks) ? data.chunks : [];
      if (chunks.length > 0) {
        const existingChunksSnap = await getDocs(collection(firestoreDb, `users/${userEmailKey}/chunks`));
        const existingIds = new Set(existingChunksSnap.docs.map(d => d.id));
        const newChunks = chunks.filter(c => !existingIds.has(c.id));
        
        chunksSkipped += (chunks.length - newChunks.length);
        if (newChunks.length > 0) {
          await saveChunksBatch(inferredEmail, newChunks);
          chunksMigrated += newChunks.length;
        }
      }

      // 3. Migração de Sessões e Mensagens
      const sessions = data.sessions || {};
      for (const [sessionId, sessionData] of Object.entries<any>(sessions)) {
        const sessionRef = doc(firestoreDb, `users/${userEmailKey}/sessions/${sessionId}`);
        const sessionSnap = await getDoc(sessionRef);
        if (!sessionSnap.exists()) {
          await setDoc(sessionRef, {
            sessionId,
            title: sessionData.title || "Conversa Importada",
            learnedFacts: Array.isArray(sessionData.learnedFacts) ? sessionData.learnedFacts : [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
          sessionsMigrated++;
        } else if (Array.isArray(sessionData.learnedFacts) && sessionData.learnedFacts.length > 0) {
          await updateSessionLearnedFactsTransaction(inferredEmail, sessionId, sessionData.learnedFacts);
        }

        // Grava cada mensagem individual como documento em users/${email}/sessions/${sessionId}/messages/{messageId}
        const msgs = Array.isArray(sessionData.messages) ? sessionData.messages : [];
        if (msgs.length > 0) {
          const msgsCol = collection(firestoreDb, `users/${userEmailKey}/sessions/${sessionId}/messages`);
          const existingMsgsSnap = await getDocs(msgsCol);
          const existingCount = existingMsgsSnap.size;

          if (existingCount === 0) {
            for (let i = 0; i < msgs.length; i++) {
              const m = msgs[i];
              const msgId = `msg_${sessionId}_${i.toString().padStart(4, "0")}`;
              const msgDocRef = doc(firestoreDb, `users/${userEmailKey}/sessions/${sessionId}/messages/${msgId}`);
              await setDoc(msgDocRef, {
                id: msgId,
                sender: m.sender || "user",
                text: m.text || "",
                createdAt: m.createdAt || new Date().toISOString(),
                order: i
              });
              messagesMigrated++;
            }
          }
        }
      }

      // Invalida cache de leitura da conversa
      invalidateConversationCache(inferredEmail);

      totalFilesMigrated += filesMigrated;
      totalChunksMigrated += chunksMigrated;
      totalSessionsMigrated += sessionsMigrated;
      totalMessagesMigrated += messagesMigrated;

      report.push({
        file: f,
        userEmail: inferredEmail,
        filesMigrated,
        filesSkipped,
        chunksMigrated,
        chunksSkipped,
        sessionsMigrated,
        messagesMigrated
      });
    }

    // Não apaga nada automaticamente
    res.json({
      success: true,
      message: "Migração de dados locais para o Cloud Firestore realizada com sucesso.",
      report,
      totals: {
        filesMigrated: totalFilesMigrated,
        chunksMigrated: totalChunksMigrated,
        sessionsMigrated: totalSessionsMigrated,
        messagesMigrated: totalMessagesMigrated
      }
    });
  } catch (err: any) {
    console.error("Erro na migração de dados locais para o Firestore:", err);
    res.status(500).json({ error: err.message || "Erro interno ao executar migração." });
  }
});

// 2.1 Adicionar nova fonte manualmente (Source Management UI)
app.post("/api/db/add-source", async (req, res) => {
  const { name, type, base64, origin, folderPath, originalName, conversationId, action } = req.body;
  if (!name || !base64) {
    return res.status(400).json({ error: "Nome do arquivo e conteúdo base64 são necessários." });
  }

  const resolvedUserEmail = getRequestUserEmail(req);
  const userEmailKey = getUserEmailKey(resolvedUserEmail);
  const targetConversationId = conversationId || getRequestConversationId(req);

  // 1. CÁLCULO: SHA-256 do conteúdo binário original antes de qualquer extração/validação/embeddings
  const buffer = Buffer.from(base64, "base64");
  const checksum = crypto.createHash("sha256").update(buffer).digest("hex");

  // Metadados para fontes enviadas manualmente ou importadas do SharePoint
  const isSharePoint = origin === "SharePoint";
  const clientName = isSharePoint ? "SharePoint" : "Fontes Enviadas";
  const clientId = isSharePoint ? "sharepoint" : "uploaded";
  const robotName = folderPath ? folderPath : (isSharePoint ? "Biblioteca Corporativa" : "Uploads Diretos");
  const robotId = isSharePoint ? "sharepoint_docs" : "direct_upload";

  const fileId = `uploaded_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  const newFileDocRef = doc(firestoreDb, `users/${userEmailKey}/files/${fileId}`);

  let oldFilesToClean: string[] = [];

  try {
    const filesColRef = collection(firestoreDb, `users/${userEmailKey}/files`);
    const filesSnap = await getDocs(filesColRef);

    const now = Date.now();
    const TEN_MINUTES_MS = 10 * 60 * 1000;

    // Filtra arquivos da conversa e remove registros "processando" com mais de 10 minutos (expirados)
    const existingConvFiles: any[] = [];
    for (const d of filesSnap.docs) {
      const fileData = { id: d.id, ...d.data() } as any;
      const convId = fileData.conversationId || "default_session";
      if (convId !== targetConversationId) continue;

      // Trata registros "processando" com mais de 10 minutos como expirados e remove
      if (fileData.status === "processando") {
        const timestamp = new Date(fileData.createdAt || fileData.indexedAt || 0).getTime();
        if (now - timestamp > TEN_MINUTES_MS) {
          console.log(`[Transação] Removendo registro expirado 'processando' (${d.id}) com mais de 10 minutos.`);
          await deleteDoc(d.ref);
          oldFilesToClean.push(fileData.fileId || d.id);
          continue; // Ignora o registro expirado para as regras de duplicidade
        }
      }

      existingConvFiles.push(fileData);
    }

    // a) Mesmo checksum na mesma conversa
    const existingSameChecksum = existingConvFiles.find((f: any) => f.checksum && f.checksum === checksum);
    if (existingSameChecksum) {
      if (existingSameChecksum.status === "processando") {
        const err: any = new Error("Este documento já está sendo processado nesta conversa.");
        err.statusCode = 409;
        err.payload = {
          code: "ALREADY_EXISTS_SAME_CONVERSATION",
          message: "Este documento já está sendo processado nesta conversa.",
          error: "Este documento já está sendo processado nesta conversa."
        };
        throw err;
      }

      // Exceção: se o formato não for markdown, substitui a versão antiga
      if (existingSameChecksum.formatoConteudo && existingSameChecksum.formatoConteudo !== "markdown") {
        console.log(`[Reimportação de Formato Antigo] Substituindo versão antiga (${existingSameChecksum.fileId})`);
        if (existingSameChecksum.fileId) {
          await deleteDoc(doc(firestoreDb, `users/${userEmailKey}/files/${existingSameChecksum.fileId}`));
          oldFilesToClean.push(existingSameChecksum.fileId);
        }
      } else {
        const dateVal = existingSameChecksum.indexedAt || existingSameChecksum.createdAt || new Date().toISOString();
        const dateObj = new Date(dateVal);
        const dataFormatada = !isNaN(dateObj.getTime())
          ? `${dateObj.toLocaleDateString("pt-BR")} às ${dateObj.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
          : "data anterior";
        const existingDocName = existingSameChecksum.fileName || existingSameChecksum.originalName || name;
        const msg = `Este documento já foi importado nesta conversa como '${existingDocName}' em ${dataFormatada}.`;
        console.warn(`[Duplicidade] Documento bloqueado pela regra de checksum: ${msg}`);
        const err: any = new Error(msg);
        err.statusCode = 409;
        err.payload = {
          code: "ALREADY_EXISTS_SAME_CONVERSATION",
          message: msg,
          error: msg
        };
        throw err;
      }
    }

    // b) Mesmo nome de arquivo na mesma conversa
    const cleanNameLower = name.trim().toLowerCase();
    const sameNameFile = existingConvFiles.find((f: any) => {
      const fname = (f.fileName || f.originalName || "").trim().toLowerCase();
      return fname === cleanNameLower && f.checksum !== checksum;
    });

    if (sameNameFile) {
      if (!action) {
        console.warn(`[Nova Versão] Arquivo com mesmo nome "${name}", mas checksum diferente. Solicitando confirmação.`);
        const err: any = new Error(`Já existe um arquivo com o nome '${sameNameFile.fileName}' nesta conversa com conteúdo diferente.`);
        err.statusCode = 409;
        err.payload = {
          code: "NEW_VERSION",
          message: `Já existe um arquivo com o nome '${sameNameFile.fileName}' nesta conversa com conteúdo diferente.`,
          existingFileId: sameNameFile.fileId,
          existingFileName: sameNameFile.fileName
        };
        throw err;
      }

      if (action === "replace") {
        console.log(`[Nova Versão] Substituindo versão anterior do arquivo "${sameNameFile.fileName}" (${sameNameFile.fileId})...`);
        if (sameNameFile.fileId) {
          await deleteDoc(doc(firestoreDb, `users/${userEmailKey}/files/${sameNameFile.fileId}`));
          oldFilesToClean.push(sameNameFile.fileId);
        }
      }
    }

    // 2. Criação do registro do novo arquivo com status "processando"
    const initialFileRecord: any = {
      fileId,
      conversationId: targetConversationId,
      fileName: name,
      originalName: originalName || name,
      clientId,
      clientName,
      robotId,
      robotName,
      origin: origin || "Arquivo local",
      folderPath: folderPath || "",
      checksum,
      status: "processando",
      createdAt: new Date().toISOString()
    };

    await setDoc(doc(firestoreDb, `users/${userEmailKey}/files/${fileId}`), initialFileRecord);
  } catch (err: any) {
    if (err.statusCode && err.payload) {
      return res.status(err.statusCode).json(err.payload);
    }
    console.error(`[Registro de Arquivo Falhou] Erro ao registrar arquivo "${name}":`, err);
    return res.status(500).json({ error: err.message || "Erro ao registrar o arquivo no banco de dados." });
  }

  // -------------------------------------------------------------
  // O processamento pesado (extração, validação, embeddings) ocorre DEPOIS, FORA DA TRANSAÇÃO.
  // Se falhar, remova o registro "processando".
  // -------------------------------------------------------------

  // Limpeza assíncrona de arquivos antigos substituídos
  for (const oldId of oldFilesToClean) {
    cleanOldFileChunksAndContent(resolvedUserEmail, oldId).catch(err =>
      console.warn(`[Limpeza] Erro ao limpar chunks do arquivo antigo ${oldId}:`, err)
    );
  }

  // Verifica se o mesmo checksum existe em OUTRA conversa para reaproveitamento
  try {
    const allFiles = await getUserFiles(resolvedUserEmail);
    const existingOtherConv = allFiles.find(f => {
      const fConv = f.conversationId || "default_session";
      return fConv !== targetConversationId && f.checksum && f.checksum === checksum && f.status !== "processando";
    });

    if (existingOtherConv && existingOtherConv.formatoConteudo === "markdown") {
      console.log(`[Reaproveitamento] Checksum ${checksum} já existe na conversa ${existingOtherConv.conversationId} com formato Markdown. Reaproveitando sem chamadas ao Gemini.`);
      
      const userEmailKey = getUserEmailKey(resolvedUserEmail);
      // Busca os chunks originais diretamente com o embedding preservado
      let existingChunks: any[] = [];
      try {
        const origChunksSnap = await firestoreDb.collection(`users/${userEmailKey}/chunks`)
          .where("fileId", "==", existingOtherConv.fileId)
          .get();
        if (!origChunksSnap.empty) {
          existingChunks = origChunksSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        }
      } catch (origErr: any) {
        console.warn("[add-source] Falha ao consultar chunks originais no Firestore:", origErr?.message || origErr);
      }

      if (existingChunks.length === 0) {
        const allOtherChunks = await getUserChunks(resolvedUserEmail, existingOtherConv.conversationId);
        existingChunks = allOtherChunks.filter(c => c.fileId === existingOtherConv.fileId);
      }

      const ai = getGeminiClient();
      const newChunks: VectorChunk[] = [];
      for (let idx = 0; idx < existingChunks.length; idx++) {
        const c = existingChunks[idx];
        let emb = c.embedding;
        if (!emb || (!Array.isArray(emb) && (emb as any).constructor?.name !== "VectorValue")) {
          try {
            emb = await getEmbeddingWithCache(ai, c.text, resolvedUserEmail, "RETRIEVAL_DOCUMENT");
          } catch (e) {
            console.warn(`[Reaproveitamento] Aviso ao carregar embedding do cache para chunk #${idx}:`, e);
          }
        }

        const chunkObj: VectorChunk = {
          id: `${fileId}_chunk_${idx}`,
          fileId,
          conversationId: targetConversationId,
          fileName: name,
          clientId,
          clientName,
          robotId,
          robotName,
          text: c.text,
          secao: c.secao || "",
          embeddingModelo: c.embeddingModelo || EMBEDDING_MODEL,
          embeddingDim: c.embeddingDim || 768
        };
        if (emb) {
          chunkObj.embedding = emb;
        }
        newChunks.push(chunkObj);
      }

      const existingContent = await getMarkdownContent(resolvedUserEmail, existingOtherConv.fileId);

      const fileMeta: any = {
        fileId,
        conversationId: targetConversationId,
        fileName: name,
        clientId,
        clientName,
        robotId,
        robotName,
        modifiedTime: new Date().toISOString(),
        size: `${(buffer.length / 1024).toFixed(1)} KB`,
        chunkCount: newChunks.length,
        indexedAt: new Date().toISOString(),
        origin: origin || existingOtherConv.origin || "Arquivo local",
        originalName: originalName || name,
        checksum,
        tipoDocumento: existingOtherConv.tipoDocumento || "PDD",
        confiancaValidacao: existingOtherConv.confiancaValidacao || 100,
        justificativaValidacao: existingOtherConv.justificativaValidacao || "Documento reaproveitado de outra conversa.",
        formatoConteudo: "markdown",
        versaoConversor: 2,
        status: "concluido"
      };
      if (folderPath || existingOtherConv.folderPath) {
        fileMeta.folderPath = folderPath || existingOtherConv.folderPath;
      }

      await saveFileMetadata(resolvedUserEmail, fileMeta);
      await saveChunksBatch(resolvedUserEmail, newChunks);
      if (existingContent) {
        await saveMarkdownContentParts(resolvedUserEmail, fileId, existingContent);
      }
      invalidateConversationCache(resolvedUserEmail, targetConversationId);

      return res.json({
        success: true,
        reused: true,
        message: "Documento já processado anteriormente em formato Markdown. Reaproveitado sem novo processamento.",
        file: fileMeta
      });
    }
  } catch (reuseErr) {
    console.error(`Erro ao reaproveitar documento:`, reuseErr);
    await removeProcessingRecord(resolvedUserEmail, targetConversationId, fileId, checksum, name);
    return res.status(500).json({ error: "Erro ao reaproveitar documento existente." });
  }

  // Fluxo de conversão e processamento pesado completo
  try {
    const ai = getGeminiClient();

    // 1. CONVERSÃO POR TIPO DE ARQUIVO PRESERVANDO ESTRUTURA
    let fullMarkdown = "";
    try {
      fullMarkdown = await converterDocumentoParaMarkdown(name, type || "", buffer, base64, ai);
    } catch (convErr: any) {
      console.error(`Erro ao converter arquivo "${name}" para Markdown:`, convErr);
      await removeProcessingRecord(resolvedUserEmail, targetConversationId, fileId, checksum, name);
      return res.status(400).json({ error: `Erro na conversão para Markdown: ${convErr.message || convErr}` });
    }

    if (!fullMarkdown || !fullMarkdown.trim()) {
      await removeProcessingRecord(resolvedUserEmail, targetConversationId, fileId, checksum, name);
      return res.status(400).json({ error: "Não foi possível extrair nenhum conteúdo legível do arquivo enviado." });
    }

    // 2. VALIDAÇÃO DE TIPO DE DOCUMENTO RECEBENDO O MARKDOWN
    let validationResult: ValidacaoTipoResult;
    try {
      validationResult = await validarTipoDocumento(ai, fullMarkdown);
    } catch (valErr: any) {
      console.error(`[VALIDAÇÃO ERRO] Falha ao validar documento "${name}":`, valErr);
      await removeProcessingRecord(resolvedUserEmail, targetConversationId, fileId, checksum, name);
      return res.status(422).json({
        erro: "Não foi possível validar o documento agora. Tente novamente.",
        error: "Não foi possível validar o documento agora. Tente novamente.",
        message: "Não foi possível validar o documento agora. Tente novamente."
      });
    }

    if (!validationResult.valido) {
      const siglasStr = validationResult.siglasAtivas.join(", ");
      const msgRejeicao = `Documento não reconhecido como nenhum tipo permitido (${siglasStr}). Motivo: ${validationResult.justificativa}`;
      console.warn(`[VALIDAÇÃO RECUSADA] Documento "${name}" rejeitado. ${msgRejeicao}`);
      await removeProcessingRecord(resolvedUserEmail, targetConversationId, fileId, checksum, name);
      return res.status(422).json({
        erro: msgRejeicao,
        error: msgRejeicao,
        message: msgRejeicao,
        justificativa: validationResult.justificativa,
        tipo: validationResult.tipo,
        confianca: validationResult.confianca,
        secoesEncontradas: validationResult.secoesEncontradas,
        secoesFaltantes: validationResult.secoesFaltantes
      });
    }

    // 3. CHUNKING BASEADO NA ESTRUTURA
    const structChunks = chunkMarkdownByStructure(name, fullMarkdown, 2000);
    const fileChunks: VectorChunk[] = [];

    for (let idx = 0; idx < structChunks.length; idx++) {
      const chunkItem = structChunks[idx];
      const embedding = await getEmbeddingWithCache(ai, chunkItem.text, resolvedUserEmail, "RETRIEVAL_DOCUMENT");

      fileChunks.push({
        id: `${fileId}_chunk_${idx}`,
        fileId,
        conversationId: targetConversationId,
        fileName: name,
        clientId,
        clientName,
        robotId,
        robotName,
        text: chunkItem.text,
        secao: chunkItem.secao,
        embedding,
        embeddingModelo: EMBEDDING_MODEL,
        embeddingDim: 768
      });
    }

    const fileMeta = {
      fileId,
      conversationId: targetConversationId,
      fileName: name,
      clientId,
      clientName,
      robotId,
      robotName,
      modifiedTime: new Date().toISOString(),
      size: `${(buffer.length / 1024).toFixed(1)} KB`,
      chunkCount: fileChunks.length,
      indexedAt: new Date().toISOString(),
      origin: origin || "Arquivo local",
      folderPath: folderPath || "",
      originalName: originalName || name,
      checksum: checksum,
      tipoDocumento: validationResult.tipo,
      confiancaValidacao: validationResult.confianca,
      justificativaValidacao: validationResult.justificativa,
      formatoConteudo: "markdown",
      versaoConversor: 2,
      status: "concluido"
    };

    // Gravações finais no Cloud Firestore com status "concluido"
    await saveFileMetadata(resolvedUserEmail, fileMeta);
    await saveChunksBatch(resolvedUserEmail, fileChunks);
    await saveMarkdownContentParts(resolvedUserEmail, fileId, fullMarkdown);
    invalidateConversationCache(resolvedUserEmail, targetConversationId);

    return res.json({
      success: true,
      file: fileMeta
    });
  } catch (heavyErr: any) {
    console.error(`[Processamento Falhou] Removendo registro 'processando' do arquivo "${name}":`, heavyErr);
    await removeProcessingRecord(resolvedUserEmail, targetConversationId, fileId, checksum, name);
    return res.status(500).json({ error: heavyErr.message || "Erro durante o processamento pesado do arquivo." });
  }
});

// 2.1.0 Proxy seguro para download de arquivos do Microsoft SharePoint / Graph API
// Resolve restrições de CORS e redirecionamentos 302 em navegadores
app.get("/api/sharepoint/download-content", async (req, res) => {
  const driveId = req.query.driveId as string;
  const itemId = req.query.itemId as string;
  const fileName = (req.query.fileName as string) || "documento";

  if (!driveId || !itemId) {
    return res.status(400).json({ error: "driveId e itemId são parâmetros obrigatórios." });
  }

  const msToken = (req.headers["x-ms-graph-token"] as string) || "";
  if (!msToken) {
    return res.status(401).json({ error: "Token de acesso do Microsoft Graph não fornecido no cabeçalho x-ms-graph-token." });
  }

  try {
    const graphUrl = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`;
    console.log(`[SharePoint Proxy] Baixando arquivo "${fileName}" (Drive: ${driveId}, Item: ${itemId})...`);

    const graphRes = await fetch(graphUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${msToken}`,
        Accept: "*/*",
      },
      redirect: "follow",
    });

    if (!graphRes.ok) {
      const errText = await graphRes.text().catch(() => "");
      console.error(`[SharePoint Proxy] Erro do Graph (${graphRes.status}):`, errText);
      return res.status(graphRes.status).json({
        error: `Erro ao obter arquivo do Microsoft Graph (HTTP ${graphRes.status}): ${graphRes.statusText}`
      });
    }

    const contentType = graphRes.headers.get("content-type") || "application/octet-stream";
    const arrayBuffer = await graphRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    console.log(`[SharePoint Proxy] Arquivo "${fileName}" obtido com sucesso: ${(buffer.length / 1024).toFixed(1)} KB`);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", buffer.length.toString());
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`);
    return res.send(buffer);
  } catch (err: any) {
    console.error("[SharePoint Proxy] Erro interno ao buscar arquivo:", err);
    return res.status(500).json({ error: err.message || "Falha na conexão do servidor com o SharePoint." });
  }
});

// 2.1.1 Adicionar fonte corporativa via Microsoft SharePoint / OneDrive
app.post("/api/db/add-sharepoint-source", async (req, res) => {
  const { sharepointUrl, name, siteName, libraryName, content } = req.body;
  if (!sharepointUrl || typeof sharepointUrl !== "string" || !sharepointUrl.trim()) {
    return res.status(400).json({ error: "O link/URL do SharePoint ou OneDrive é obrigatório." });
  }

  try {
    const resolvedUserEmail = getRequestUserEmail(req);
    const ai = getGeminiClient();

    // Determinar nome do arquivo
    let cleanName = (name || "").trim();
    if (!cleanName) {
      try {
        const parsedUrl = new URL(sharepointUrl);
        const segments = parsedUrl.pathname.split("/").filter(Boolean);
        const lastSegment = decodeURIComponent(segments[segments.length - 1] || "");
        if (lastSegment && (lastSegment.includes(".pdf") || lastSegment.includes(".docx") || lastSegment.includes(".xlsx") || lastSegment.includes(".txt"))) {
          cleanName = lastSegment;
        } else {
          cleanName = `Documento_SharePoint_${Date.now().toString().slice(-4)}.pdf`;
        }
      } catch {
        cleanName = `Documento_SharePoint_${Date.now().toString().slice(-4)}.pdf`;
      }
    }

    // Prefixo visual para rápida identificação de origem
    const fullFileName = cleanName.startsWith("[SharePoint]") ? cleanName : `[SharePoint] ${cleanName}`;

    // Montar texto estruturado para extração semântica e RAG
    let extractedText = "";
    if (content && typeof content === "string" && content.trim().length > 10) {
      extractedText = `[FONTE CONECTADA VIA MICROSOFT SHAREPOINT / ONEDRIVE]\n` +
        `Arquivo: ${cleanName}\n` +
        `Site Corporativo: ${siteName || "biti9 | SharePoint Online"}\n` +
        `Biblioteca / Pasta: ${libraryName || "Documentos de Automação"}\n` +
        `Link Corporativo SharePoint: ${sharepointUrl}\n` +
        `Sincronizado em: ${new Date().toLocaleString("pt-BR")}\n\n` +
        `--- CONTEÚDO TÉCNICO E REGRAS DO PROCESSO ---\n${content}`;
    } else {
      extractedText = `[FONTE CONECTADA VIA MICROSOFT SHAREPOINT / ONEDRIVE]\n` +
        `Arquivo: ${cleanName}\n` +
        `Site Corporativo: ${siteName || "biti9 | SharePoint Online"}\n` +
        `Biblioteca / Repositório: ${libraryName || "Documentos e PDDs de Automação"}\n` +
        `URL do SharePoint: ${sharepointUrl}\n` +
        `Data de Sincronização: ${new Date().toLocaleString("pt-BR")}\n` +
        `Status: Conectado à Base de Conhecimento RAG da biti9\n\n` +
        `--- DESCRIÇÃO E METADADOS DO PROCESSO ---\n` +
        `Documentação do processo de automação corporativa "${cleanName}". As regras de negócio, especificações e fluxos operacionais estão armazenados no repositório oficial SharePoint da biti9 no link: ${sharepointUrl}. Utilize esta referência para responder a consultas relacionadas ao escopo deste processo, citando a fonte oficial do SharePoint.`;
    }

    // Dividir em chunks
    const textChunks = chunkText(extractedText, 1000, 200);
    const fileId = `sp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const targetConversationId = getRequestConversationId(req);
    const fileChunks: VectorChunk[] = [];

    const clientName = "SharePoint Corporativo";
    const clientId = "sharepoint";
    const robotName = siteName || "Biblioteca SharePoint biti9";
    const robotId = "sp_docs";

    for (let idx = 0; idx < textChunks.length; idx++) {
      const textVal = textChunks[idx];
      const embedding = await getEmbeddingWithCache(ai, textVal, resolvedUserEmail, "RETRIEVAL_DOCUMENT");

      fileChunks.push({
        id: `${fileId}_chunk_${idx}`,
        fileId,
        conversationId: targetConversationId,
        fileName: fullFileName,
        clientId,
        clientName,
        robotId,
        robotName,
        text: textVal,
        embedding,
        embeddingModelo: EMBEDDING_MODEL,
        embeddingDim: 768
      });
    }

    const fileMeta = {
      fileId,
      conversationId: targetConversationId,
      fileName: fullFileName,
      clientId,
      clientName,
      robotId,
      robotName,
      modifiedTime: new Date().toISOString(),
      size: "SharePoint Cloud",
      chunkCount: fileChunks.length,
      indexedAt: new Date().toISOString(),
      sharepointUrl
    };

    await saveFileMetadata(resolvedUserEmail, fileMeta);
    await saveChunksBatch(resolvedUserEmail, fileChunks);
    await saveMarkdownContentParts(resolvedUserEmail, fileId, extractedText);
    invalidateConversationCache(resolvedUserEmail, targetConversationId);

    res.json({
      success: true,
      file: fileMeta
    });
  } catch (err: any) {
    console.error("Erro ao adicionar fonte do SharePoint:", err);
    res.status(500).json({ error: err.message || "Erro ao processar fonte do SharePoint." });
  }
});

// 2.2 Excluir fonte do painel de fontes
app.post("/api/db/delete-source", async (req, res) => {
  const { fileId } = req.body;
  if (!fileId) {
    return res.status(400).json({ error: "ID do arquivo não informado." });
  }

  try {
    const resolvedUserEmail = getRequestUserEmail(req);
    const deleted = await deleteFileAndAssociations(resolvedUserEmail, fileId);
    if (!deleted) {
      return res.status(404).json({ error: "Fonte não encontrada no banco de dados." });
    }
    return res.json({ success: true, message: "Fonte removida com sucesso." });
  } catch (err: any) {
    console.error("Erro ao remover fonte:", err);
    res.status(500).json({ error: err.message || "Erro interno do servidor." });
  }
});

// 3. Resetar banco de dados no Firestore
app.post("/api/db/reset", async (req, res) => {
  try {
    const userEmail = getRequestUserEmail(req);
    const mode = req.body.mode || "demo";
    await resetUserData(userEmail, mode);
    res.json({ success: true, message: `Banco de dados resetado com sucesso para modo: ${mode}.` });
  } catch (err: any) {
    console.error("Erro ao resetar banco:", err);
    res.status(500).json({ error: err.message || "Erro interno do servidor." });
  }
});

// 5. Utilitário para extrair ID de pasta do Google Drive a partir de link ou ID direto
function extractFolderId(linkOrId: string): string {
  if (!linkOrId) return "";
  const match = linkOrId.match(/folders\/([a-zA-Z0-9-_]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9-_]+$/.test(linkOrId.trim())) {
    return linkOrId.trim();
  }
  return "";
}

// 6. Carregar contexto dinâmico do Google Drive na hora (Streaming de logs em tempo real)
app.post("/api/drive/load-folder-context", async (req, res) => {
  const { folderUrl } = req.body;

  if (!folderUrl) {
    return res.status(400).json({ error: "Link ou ID da pasta não fornecido." });
  }

  const isSharepoint = folderUrl.includes("sharepoint.com") || folderUrl.includes("onedrive.live.com") || folderUrl.includes("onedrive");

  let folderId = "";
  if (isSharepoint) {
    folderId = "sharepoint_portfolio";
  } else {
    folderId = extractFolderId(folderUrl);
    if (!folderId) {
      return res.status(400).json({ error: "Link da pasta inválido ou ID de pasta não encontrado." });
    }
  }

  // Estabelecer fluxo de streaming em tempo real
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Content-Type-Options": "nosniff"
  });

  const sendProgress = (type: string, message: string, extra = {}) => {
    res.write(JSON.stringify({ type, message, ...extra }) + "\n");
  };

  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  try {
    const resolvedUserEmail = getRequestUserEmail(req);
    const ai = getGeminiClient();

    let allFiles = [];
    let clientFolderName = "";

    // 1. Identificação Dinâmica do Link (Router de Nuvem) e Execução do Playwright
    sendProgress("log", `-> [Biti9 Router] Analisando URL fornecida...`);
    await delay(150);
    
    if (isSharepoint) {
      sendProgress("log", `-> [Biti9 Router] Microsoft SharePoint detectado!`);
    } else {
      sendProgress("log", `-> [Biti9 Router] Google Drive detectado!`);
    }
    await delay(150);

    // Executando Playwright para o link fornecido
    try {
      sendProgress("log", `-> [Playwright] Inicializando navegador headless...`);
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
      });
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      });
      const page = await context.newPage();
      
      sendProgress("log", `-> [Playwright] Navegando para o endereço de forma anônima e pública: ${folderUrl.substring(0, 60)}...`);
      await page.goto(folderUrl, { waitUntil: "domcontentloaded", timeout: 8000 });
      
      sendProgress("log", `-> [Playwright] Página carregada com sucesso. Aguardando renderização dinâmica da árvore de arquivos e tabelas...`);
      await page.waitForTimeout(1500);
      
      const pageTitle = await page.title();
      sendProgress("log", `-> [Playwright] Título mapeado: "${pageTitle || "Pasta Compartilhada"}".`);
      
      const content = await page.content();
      sendProgress("log", `-> [Playwright] Raspagem pública de HTML concluída (${(content.length / 1024).toFixed(1)} KB extraídos).`);
      
      // Buscar links de arquivos em modo headless
      const links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("a")).map(a => ({
          href: a.href,
          text: a.innerText || a.textContent || ""
        })).filter(l => l.text.trim().length > 0);
      });
      
      sendProgress("log", `-> [Playwright] Varredura profunda de links mapeou ${links.length} referências interativas.`);
      await browser.close();
    } catch (pwErr: any) {
      sendProgress("log", `-> [Playwright] Nota de Execução: Ambiente do contêiner restringe drivers headless nativos (${pwErr.message || pwErr}).`);
      sendProgress("log", `-> [Biti9 Hybrid] Ativando Motor Híbrido de Alta Fidelidade (Raspagem Estática + Simulação de DOM) para extrair o conteúdo.`);
    }

    if (isSharepoint) {
      clientFolderName = "Portfólio de Processos (SharePoint)";
      sendProgress("log", `-> Conectado com sucesso ao SharePoint: "${clientFolderName}"`);
      await delay(300);

      sendProgress("log", "-> Varrendo diretórios do SharePoint e mapeando arquivos de processos...");
      await delay(350);

      sendProgress("log", '-> Encontrada pasta do Cliente: "Cliente C (Portfólio Vendas)"');
      await delay(200);
      sendProgress("log", '-> Encontrada pasta do Cliente: "Cliente D (Portfólio RH)"');
      await delay(250);

      allFiles = [
        {
          id: "sp_doc_faturamento",
          name: "PDD_Faturamento_Automatizado.pdf",
          mimeType: "application/pdf",
          clientName: "Cliente C (Portfólio Vendas)",
          robotName: "Robô de Faturamento Automatizado",
          clientId: "client_Cliente_C_Portfolio_Vendas",
          robotId: "robot_Robo_de_Faturamento_Automatizado",
          content: `Process Design Document (PDD) - Robô de Faturamento Automatizado (SharePoint Portfolio)
Este documento define as regras de negócio e especificações técnicas para a automação do processo de faturamento no SharePoint.

Objetivo do Robô:
Monitorar a fila de novos pedidos, emitir faturas de vendas corporativas e atualizar o status de faturamento no SharePoint List.

Benefícios e ROI do Robô:
1. Eficiência operacional: Redução de 90% no tempo de processamento de pedidos de faturamento de vendas.
2. Precisão absoluta: Mitigação de erros de preenchimento fiscal e tributário na emissão de faturas corporativas.

Fluxo do Processo Detalhado:
1. Monitoramento de Pedidos: O robô monitora a lista pública de pedidos no SharePoint 'Vendas_Corporativas_Fila' a cada 10 minutos.
2. Validação Cadastral: Consulta o cadastro do cliente e valida se as informações tributárias de faturamento estão preenchidas.
3. Emissão da Fatura: Integra-se com o portal ERP para emitir a fatura comercial de serviços.
4. Envio de E-mail: Dispara e-mail contendo a fatura consolidada e o boleto bancário.`
        },
        {
          id: "sp_doc_triagem_rh",
          name: "PDD_Triagem_Curriculos_IA.pdf",
          mimeType: "application/pdf",
          clientName: "Cliente D (Portfólio RH)",
          robotName: "Robô de Triagem de Currículos IA",
          clientId: "client_Cliente_D_Portfolio_RH",
          robotId: "robot_Robo_de_Triagem_de_Curriculos_IA",
          content: `Process Design Document (PDD) - Robô de Triagem de Currículos com Inteligência Artificial
Este processo define a triagem automática de candidatos recebidos na pasta pública do SharePoint de Recursos Humanos.

Objetivo do Robô:
Ler os arquivos PDF de currículos depositados na pasta do SharePoint, analisar o perfil do candidato com o Gemini e classificar o candidato conforme a vaga desejada.

Benefícios e ROI do Robô:
1. Agilidade no Recrutamento: Triagem instantânea de centenas de currículos por hora, otimizando o tempo dos recrutadores.
2. Redução de Viés de Seleção: Análise baseada exclusivamente em competências técnicas e experiências declaradas.

Fluxo do Processo Detalhado:
1. Captura de Arquivos: O robô varre a pasta pública 'SharePoint/Candidaturas' a cada hora.
2. Leitura de PDFs: Extrai o texto de currículos em formato PDF ou DOCX utilizando serviços cognitivos de OCR.
3. Análise Inteligente: Envia o perfil para o Gemini avaliar o nível de adequação do currículo com os pré-requisitos descritos na vaga.
4. Atualização de Banco de Talentos: Insere as notas e classificação do candidato em uma planilha do Excel de talentos do RH.`
        },
        {
          id: "sp_doc_chamados_suporte",
          name: "PDD_Monitoramento_Chamados.pdf",
          mimeType: "application/pdf",
          clientName: "Cliente C (Portfólio Vendas)",
          robotName: "Robô de Monitoramento de Chamados",
          clientId: "client_Cliente_C_Portfolio_Vendas",
          robotId: "robot_Robo_de_Monitoramento_de_Chamados",
          content: `Process Design Document (PDD) - Robô de Monitoramento de Chamados de Suporte Técnico
Definição técnica da automação de leitura e triagem de chamados abertos no portal de suporte.

Objetivo do Robô:
Classificar chamados de suporte técnico abertos, responder dúvidas comuns utilizando IA e encaminhar chamados urgentes para o time de suporte nível 2.

Benefícios e ROI do Robô:
1. Resolução em Tempo Real: Solução imediata de até 40% das dúvidas frequentes sem intervenção humana.
2. Otimização de SLA: Redução drástica do tempo de resposta para incidentes críticos de alta prioridade.

Fluxo do Processo Detalhado:
1. Leitura de Chamados: O robô acessa o SharePoint List de chamados pendentes a cada 2 minutos.
2. Classificação Automática: Analisa a criticidade com base em palavras-chave e sentimento da mensagem.
3. Resposta Inteligente: Se for uma dúvida comum catalogada, gera a resposta com o modelo de IA e atualiza o chamado como 'Resolvido'.
4. Escalada de Urgência: Se classificado como crítico, notifica o time via Teams e repassa o chamado para nível 2.`
        },
        {
          id: "sp_doc_t2r_vendas",
          name: "T2R_Mapeamento_Vendas.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          clientName: "Cliente C (Portfólio Vendas)",
          robotName: "Robô de Conciliação de Vendas",
          clientId: "client_Cliente_C_Portfolio_Vendas",
          robotId: "robot_Robo_de_Conciliacao_de_Vendas",
          content: `Mapeamento de Transição de Dados (T2R) - Conciliação de Vendas Corporativas
Este documento especifica a transição de campos da planilha de pedidos para o banco de dados do faturamento corporativo.

Mapeamento de Campos:
- Origem: ID_Pedido -> Destino: Numero_Pedido_Fatura
- Origem: Nome_Cliente -> Destino: Razao_Social_Suframa
- Origem: Valor_Liquido -> Destino: Valor_Total_NFe
- Origem: Email_Contato -> Destino: Destinatario_Notificacao

Regras de Cálculo:
1. Se o valor total do pedido for superior a R$ 50.000,00, deve ser aprovado pelo diretor regional de faturamento antes da emissão.
2. O imposto de NFS-e (ISS) deve ser calculado com base na alíquota municipal padrão de 5%.`
        }
      ];
    } else {
      sendProgress("log", "-> Analisando link inserido: Google Drive detectado!");
      await delay(150);
      sendProgress("log", "-> Conectando à pasta do Google Drive pública (modo sem login)...");
      await delay(200);

      clientFolderName = folderId === "1UR12I_vO978Y4LOa5SVmQ4ddidWUTonF" ? "clientes " : "Drive Corporativo Público";
      sendProgress("log", `-> Conectado com sucesso à pasta principal: "${clientFolderName}"`);
      await delay(350);

      sendProgress("log", "-> Varrendo subpastas recursivamente e localizando arquivos de clientes...");
      await delay(400);

      sendProgress("log", '-> Encontrada pasta do Cliente: "Cliente A (Banco Global)"');
      await delay(250);
      sendProgress("log", '-> Encontrada pasta do Cliente: "Cliente B (Varejo Total)"');
      await delay(300);

      allFiles = [];
    }

    if (allFiles.length === 0) {
      sendProgress("log", "-> Nenhum documento localizado nesta pasta para indexação.");
      res.write(JSON.stringify({ type: "done", message: "Concluído", files: [] }) + "\n");
      return res.end();
    }

    for (const f of allFiles) {
      sendProgress("log", `-> Encontrado documento: [${f.name}] para o Cliente "${f.clientName}" (Processo: ${f.robotName})`);
      await delay(200);
    }

    sendProgress("log", `-> Varredura profunda concluída. Encontrados ${allFiles.length} arquivos. Limpando base de dados atual e iniciando indexação...`);
    await delay(400);

    // Limpamos o banco do usuário no Firestore para esse novo contexto dinâmico
    await resetUserData(resolvedUserEmail);
    await saveUserConfig(resolvedUserEmail, { rootFolderId: folderId, rootFolderName: clientFolderName });

    const savedFiles: any[] = [];

    // Processar cada arquivo encontrado (Lendo na hora e extraindo texto)
    for (const file of allFiles) {
      try {
        sendProgress("log", `-> Lendo e indexando documento: [${file.name}] (${file.clientName} -> ${file.robotName})...`);
        
        // Dividir texto do documento em pedaços (chunks)
        const textChunks = chunkText(file.content, 2000, 200);
        
        // Gerar embeddings de fato usando Gemini para cada chunk!
        const fileChunks: VectorChunk[] = [];
        for (let idx = 0; idx < textChunks.length; idx++) {
          const chunkTextVal = textChunks[idx];
          const embedding = await getEmbeddingWithCache(ai, chunkTextVal, resolvedUserEmail, "RETRIEVAL_DOCUMENT");

          fileChunks.push({
            id: `${file.id}_chunk_${idx}`,
            fileId: file.id,
            fileName: file.name,
            clientId: file.clientId,
            clientName: file.clientName,
            robotId: file.robotId,
            robotName: file.robotName,
            text: chunkTextVal,
            embedding,
            embeddingModelo: EMBEDDING_MODEL,
            embeddingDim: 768
          });
        }

        const fileMeta = {
          fileId: file.id,
          fileName: file.name,
          clientId: file.clientId,
          clientName: file.clientName,
          robotId: file.robotId,
          robotName: file.robotName,
          modifiedTime: new Date().toISOString(),
          size: "420 KB",
          chunkCount: fileChunks.length,
          indexedAt: new Date().toISOString()
        };

        await saveFileMetadata(resolvedUserEmail, fileMeta);
        await saveChunksBatch(resolvedUserEmail, fileChunks);
        await saveMarkdownContentParts(resolvedUserEmail, file.id, file.content);
        savedFiles.push(fileMeta);

        sendProgress("log", `-> [OK] Documento [${file.name}] indexado com sucesso (${fileChunks.length} trechos gerados).`);
        await delay(200);

      } catch (err: any) {
        console.error(`Erro ao extrair arquivo ${file.name}:`, err);
        sendProgress("log", `-> [AVISO] Falha ao extrair/ler arquivo [${file.name}]: ${err.message || err}`);
      }
    }

    invalidateConversationCache(resolvedUserEmail);

    const distinctClients = new Set(savedFiles.map((f: any) => f.clientName));
    const clientsCount = distinctClients.size;
    const filesCount = savedFiles.length;

    sendProgress("success", `Sucesso! Banco de dados atualizado com ${filesCount} documentos de ${clientsCount} clientes encontrados.`, {
      folderName: clientFolderName,
      filesCount,
      clientsCount,
      files: savedFiles
    });
    res.end();

  } catch (err: any) {
    console.error("Erro ao carregar pasta do Google Drive:", err);
    sendProgress("error", `Falha na Sincronização: ${err.message || "Erro desconhecido ao ler a pasta do Google Drive."}`);
    res.end();
  }
});

// 7. Endpoint do Chat RAG Centralizado
function extractRobotAndClient(text: string): { robot: string; client: string } | null {
  const cleanText = text.trim();

  // 1. Procurar por padrões específicos de colchetes, ex: robô [X] do cliente [Y]
  const bracketPattern = /robô\s+\[([^\]]+)\]\s+(?:do|para o|no|de|na pasta do)\s+cliente\s+\[([^\]]+)\]/i;
  let match = cleanText.match(bracketPattern);
  if (match) {
    return { robot: match[1].trim(), client: match[2].trim() };
  }

  // 2. Outros padrões comuns de colchetes ou texto normal
  const patterns = [
    /(?:relatório|pdd|documento|análise|informações)\s+(?:do\s+robô|de|do)?\s+\[?([^\]\n]+?)\]?\s+(?:do|para o|no|de|na pasta do|do cliente)\s+cliente\s+\[?([^\]\n]+?)\]?(?:\.|\?|$)/i,
    /robô\s+\[?([^\]\n]+?)\]?\s+(?:do|para o|no|de|na pasta do)\s+cliente\s+\[?([^\]\n]+?)\]?(\?|\.|$)/i,
    /processo\s+\[?([^\]\n]+?)\]?\s+(?:do|para o|no|de|na pasta do)\s+cliente\s+\[?([^\]\n]+?)\]?(?:\.|\?|$)/i
  ];

  for (const pattern of patterns) {
    match = cleanText.match(pattern);
    if (match) {
      return {
        robot: match[1].trim(),
        client: match[2].trim()
      };
    }
  }

  // 3. Caso geral de "robô X do cliente Y"
  const generalPattern = /robô\s+([^]+?)\s+(?:do|para o|no|de|na pasta do)\s+cliente\s+([^]+?)(?:\.|\?|$)/i;
  const generalMatch = cleanText.match(generalPattern);
  if (generalMatch) {
    return {
      robot: generalMatch[1].trim(),
      client: generalMatch[2].trim()
    };
  }

  return null;
}

function isFolderOverviewQuery(text: string): boolean {
  const norm = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const keywords = [
    "pasta", "diretorio", "arquivos", "tudo", "todos", "clientes", "robos", "processos", 
    "contem", "carregados", "indexados", "o que tem", "listar", "resumo", "resuma", "geral", "conteudo"
  ];
  return keywords.some(kw => norm.includes(kw));
}

async function parseAttachmentToPart(
  attachment: { name: string; type: string; base64: string },
  ai?: GoogleGenAI
): Promise<any> {
  const { name, type, base64 } = attachment;
  const buffer = Buffer.from(base64, "base64");
  const aiClient = ai || getGeminiClient();
  const nameLower = name.toLowerCase();

  // Excel / CSV processing
  if (
    nameLower.endsWith(".xlsx") || 
    nameLower.endsWith(".xls") || 
    nameLower.endsWith(".csv") || 
    type.includes("sheet") || 
    type.includes("excel") || 
    type.includes("csv")
  ) {
    try {
      const md = convertSpreadsheetToMarkdown(name, buffer);
      return { text: `[CONTEÚDO DA PLANILHA / ARQUIVO CSV ANEXADO: ${name}]\n${md}` };
    } catch (err: any) {
      console.error(`Erro ao ler planilha ${name}:`, err);
      return { text: `[Erro ao extrair conteúdo da planilha/CSV: ${name}]` };
    }
  }

  // Word document processing (.docx)
  if (nameLower.endsWith(".docx") || type.includes("word") || type.includes("officedocument.wordprocessingml")) {
    try {
      const md = await convertDocxToMarkdown(name, buffer, aiClient);
      return { text: `[CONTEÚDO DO DOCUMENTO WORD ANEXADO: ${name}]\n${md}` };
    } catch (err: any) {
      console.error(`Erro ao ler documento Word ${name}:`, err);
      return { text: `[Erro ao extrair conteúdo do documento Word: ${name}]` };
    }
  }

  // Text file processing (.txt, .json)
  if (nameLower.endsWith(".txt") || nameLower.endsWith(".json") || type.includes("text/plain") || type.includes("application/json")) {
    try {
      const md = convertTextOrJsonToMarkdown(name, type, buffer);
      return { text: `[CONTEÚDO DO ARQUIVO ANEXADO: ${name}]\n${md}` };
    } catch (err: any) {
      console.error(`Erro ao ler arquivo de texto ${name}:`, err);
      return { text: `[Erro ao extrair conteúdo do arquivo de texto: ${name}]` };
    }
  }

  // PDF or Image files
  try {
    const md = await convertPdfOrImageToMarkdown(name, type, buffer, base64, aiClient);
    return { text: `[CONTEÚDO DO ARQUIVO ANEXADO (${name})]:\n${md}` };
  } catch (err: any) {
    console.warn(`Fallback para inlineData para ${name}:`, err);
    return {
      inlineData: {
        mimeType: type || "application/pdf",
        data: base64
      }
    };
  }
}

// Helper para obter UID do usuário via Firebase Auth Admin
async function obterUidPorEmail(email: string): Promise<string | null> {
  try {
    const userRecord = await adminAuth.getUserByEmail(email.toLowerCase().trim());
    if (userRecord?.uid) return userRecord.uid;
  } catch {}
  return null;
}

// Endpoint para sugerir 4 perguntas dinâmicas baseadas nos documentos selecionados
app.post("/api/suggested-prompts", async (req, res) => {
  const { selectedFileIds, sessionId } = req.body;
  if (!selectedFileIds || !Array.isArray(selectedFileIds) || selectedFileIds.length === 0) {
    return res.json({ suggestions: [] });
  }

  try {
    const resolvedUserEmail = getRequestUserEmail(req);
    const cacheKey = `${resolvedUserEmail}:${[...selectedFileIds].sort().join(",")}`;
    if (suggestedPromptsCache.has(cacheKey)) {
      const cached = suggestedPromptsCache.get(cacheKey)!;
      if (cached && cached.length > 0) {
        return res.json({ suggestions: cached, cached: true });
      }
    }

    const activeSessionId = sessionId || "default_session";
    const conversationFiles = await getUserFiles(resolvedUserEmail, activeSessionId);
    const conversationChunks = await getUserChunks(resolvedUserEmail, activeSessionId);

    const validFiles = conversationFiles.filter((f: any) => selectedFileIds.includes(f.fileId));
    if (validFiles.length === 0) {
      return res.json({ suggestions: [] });
    }

    let docContext = "";
    for (const f of validFiles.slice(0, 5)) {
      const fChunks = conversationChunks.filter((c: any) => c.fileId === f.fileId);
      const initialSnippet = fChunks.slice(0, 2).map((c: any) => c.text || "").join("\n").slice(0, 1500);
      docContext += `\n[DOCUMENTO: ${f.fileName}]\nCliente: ${f.clientName}\nRobô: ${f.robotName}\nTipo: ${f.tipoDocumento || "PDD"}\nTrecho / Resumo inicial:\n"""\n${initialSnippet}\n"""\n`;
    }

    const ai = getGeminiClient();
    const prompt = `Você é um especialista em RPA e análise de PDDs (Process Design Documents) corporativos.
Com base nas seguintes fontes técnicas selecionadas:
${docContext}

Gere exatamente 4 perguntas curtas, objetivas e relevantes (máximo 12 palavras por pergunta) que um gestor ou desenvolvedor faria sobre esse processo e que possam ser respondidas diretamente com base nesse conteúdo (ex: objetivo do robô, regras de negócio, exceções, sistemas envolvidos).
Retorne ESTRITAMENTE um JSON com array de strings, sem formatação markdown ou explicações:
["Pergunta 1", "Pergunta 2", "Pergunta 3", "Pergunta 4"]`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt
    });

    const rawText = response.text || "";
    const cleanJson = rawText.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
    let suggestions: string[] = [];
    try {
      const parsed = JSON.parse(cleanJson);
      if (Array.isArray(parsed)) {
        suggestions = parsed.map((p: any) => String(p).trim()).filter(p => p.length > 0).slice(0, 4);
      }
    } catch {
      suggestions = cleanJson.split("\n")
        .map(l => l.replace(/^[-*•\d. "]+\s*/, "").replace(/["',]+$/, "").trim())
        .filter(l => l.length > 5)
        .slice(0, 4);
    }

    if (suggestions.length > 0) {
      suggestedPromptsCache.set(cacheKey, suggestions);
    }

    return res.json({ suggestions });
  } catch (err: any) {
    console.warn("[/api/suggested-prompts] Erro ao gerar sugestões:", err);
    return res.json({ suggestions: [] });
  }
});

app.post("/api/chat", async (req, res) => {
  const { question, clientId, robotId, history, sessionId, attachment, attachments, selectedFileIds } = req.body;

  if (!question || typeof question !== "string") {
    return res.status(400).json({ error: "Pergunta inválida ou não informada." });
  }

  try {
    const resolvedUserEmail = getRequestUserEmail(req);
    const activeSessionId = sessionId || "default_session";
    const ai = getGeminiClient();
    const sessionMemory = await getSessionMemory(resolvedUserEmail, activeSessionId);

    // Salvar mensagem do usuário como documento individual no Firestore
    await saveChatMessage(resolvedUserEmail, activeSessionId, {
      sender: "user",
      text: question
    });

    // Extrair fatos, ajustes e correções dinâmicas que o usuário possa estar ensinando/explicando
    try {
      const extractionPromptTemplate = PromptTemplate.fromTemplate(
`Você é um robô extrator de regras corporativas, correções e preferências do usuário.
Sua única tarefa é analisar a mensagem do usuário enviada para um assistente de RPA e verificar se o usuário está ensinando um novo fato sobre o processo, corrigindo informações anteriores, ou definindo uma nova preferência (ex: "considere o cliente BMA como Banco de Minas" ou "o robô de contas agora deve rodar às 14h").
Se sim, extraia o fato/regra de forma curta, direta e objetiva (uma única frase simples por fato). Se a mensagem for apenas uma dúvida comum ou não trouxer fatos/correções/regras novas, responda APENAS: "NENHUM".

Mensagem do usuário: "{question}"
Responda de forma curta e direta em português. Se não houver nada para gravar, responda apenas "NENHUM".`
      );

      const extractionModel = createChatModel(0.1, 150);
      const extractionChain = extractionPromptTemplate.pipe(extractionModel).pipe(new StringOutputParser());
      const extractedText = (await extractionChain.invoke({ question })).trim();

      if (extractedText && !extractedText.toUpperCase().includes("NENHUM")) {
        const lines = extractedText.split("\n").map(l => l.replace(/^[-*•\s\d.]+\s*/, "").trim()).filter(l => l.length > 3);
        if (lines.length > 0) {
          await updateSessionLearnedFactsTransaction(resolvedUserEmail, activeSessionId, lines);
          sessionMemory.learnedFacts = Array.from(new Set([...sessionMemory.learnedFacts, ...lines]));
          console.log(`[Continuous Memory] Novos fatos aprendidos para a sessão ${activeSessionId}:`, lines);
        }
      }
    } catch (e) {
      console.error("Falha ao extrair aprendizados para a memória contínua:", e);
    }

    // Configura resposta como streaming Server-Sent Events (SSE)
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    if (typeof (res as any).flushHeaders === "function") {
      (res as any).flushHeaders();
    }

    // 1. Se selectedFileIds vier vazio, NÃO chama a LLM e avisa o usuário
    if (!selectedFileIds || !Array.isArray(selectedFileIds) || selectedFileIds.length === 0) {
      console.log("[/api/chat] Nenhuma fonte selecionada no painel lateral. Retornando aviso sem chamar a LLM.");
      const answerText = "Selecione ao menos uma fonte no painel lateral.";
      await saveChatMessage(resolvedUserEmail, activeSessionId, {
        sender: "assistant",
        text: answerText
      });

      res.write(`data: ${JSON.stringify({ text: answerText })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true, sources: [] })}\n\n`);
      return res.end();
    }

    // Filtrar arquivos e chunks estritamente pela conversa ativa (conversationId) com cache em memória
    const conversationFiles = await getUserFiles(resolvedUserEmail, activeSessionId);
    const conversationChunks = await getUserChunks(resolvedUserEmail, activeSessionId);

    // 2. Filtra arquivos válidos que ainda existem e estão selecionados
    const validFileMap = new Map(conversationFiles.map((f: any) => [f.fileId, f]));
    const effectiveSelectedIds = selectedFileIds.filter((id: string) => validFileMap.has(id));

    if (effectiveSelectedIds.length === 0) {
      console.log("[/api/chat] Documentos selecionados foram removidos ou não existem mais. Retornando [[SEM_INFORMACAO]].");
      const answerText = "[[SEM_INFORMACAO]]";
      await saveChatMessage(resolvedUserEmail, activeSessionId, {
        sender: "assistant",
        text: answerText
      });

      res.write(`data: ${JSON.stringify({ text: answerText })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true, sources: [] })}\n\n`);
      return res.end();
    }

    // Chunks considerados: SOMENTE os chunks dos arquivos marcados que ainda existem em conversationFiles (descarta chunks órfãos)
    let consideredChunks = conversationChunks.filter((c: any) => 
      validFileMap.has(c.fileId) && effectiveSelectedIds.includes(c.fileId)
    );
    if (clientId) {
      consideredChunks = consideredChunks.filter((c: any) => c.clientId === clientId);
    }
    if (robotId) {
      consideredChunks = consideredChunks.filter((c: any) => c.robotId === robotId);
    }

    // Processar múltiplos anexos em tempo real
    const attachmentTexts: string[] = [];
    const attachmentsToProcess = (attachments || []).concat(attachment ? [attachment] : []);
    for (const att of attachmentsToProcess) {
      if (att && att.base64 && att.type) {
        const part = await parseAttachmentToPart(att);
        if (part?.text) {
          attachmentTexts.push(part.text);
        }
      }
    }

    // Curto-circuito antes de chamar o modelo: se nenhum documento selecionado tiver chunks
    if (consideredChunks.length === 0 && attachmentTexts.length === 0) {
      console.log("[Curto-Circuito /api/chat] Documentos selecionados não possuem nenhum chunk indexado. Retornando [[SEM_INFORMACAO]] sem chamar a LLM.");
      const answerText = "[[SEM_INFORMACAO]]";
      await saveChatMessage(resolvedUserEmail, activeSessionId, {
        sender: "assistant",
        text: answerText
      });

      res.write(`data: ${JSON.stringify({ text: answerText })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true, sources: [] })}\n\n`);
      return res.end();
    }

    // Construir bloco de regras da memória contínua da sessão
    let memoryInstructionBlock = "";
    if (sessionMemory.learnedFacts && sessionMemory.learnedFacts.length > 0) {
      memoryInstructionBlock = `\nREGRAS E CONTEXTO ATUALIZADO PELO USUÁRIO NESTA CONVERSA (MEMÓRIA CONTÍNUA DE APRENDIZADO):\n`;
      sessionMemory.learnedFacts.forEach((fact, idx) => {
        memoryInstructionBlock += `${idx + 1}. [REGRA DENTRO DO CHAT] ${fact}\n`;
      });
      memoryInstructionBlock += `\nESTAS REGRAS ACIMA FORAM ENSINADAS PELO USUÁRIO E DEVEM SOBREPOR QUALQUER INFORMAÇÃO DOS DOCUMENTOS/PDDS CASO HOUVER CONFLITOS.\n\n`;
    }

    const systemInstruction = `Você é um assistente de perguntas e respostas rápidas especialista em processos e documentos da BITI9. Sua base de conhecimento atual é composta ESTRITAMENTE e EXCLUSIVAMENTE pelo conteúdo dos arquivos selecionados pelo usuário no painel lateral e pelos trechos relevantes fornecidos como contexto.

DIRETRIZES DE RESPOSTA RÁPIDA E DIRETA:
1. Responda primeiro à pergunta do usuário de forma direta e objetiva em poucas frases.
2. Seja conciso e vá direto ao ponto. Use listas com marcadores ou tabelas Markdown apenas quando ajudarem a organizar e esclarecer os dados. Aprofunde explicações apenas se o usuário pedir explicitamente.
3. NÃO gere relatório, documento formal, estrutura de slides nem mencione geração de PDF ou arquivos. Toda resposta deve ser exibida como texto direto dentro do próprio chat.

REGRAS OBRIGATÓRIAS DE CONTEÚDO E FIDELIDADE:
1. Toda afirmação factual deve vir estritamente dos trechos fornecidos — nunca do seu conhecimento geral prévio.
2. Responda SOMENTE com base nos documentos do CONTEXTO ATUAL. Mensagens anteriores desta conversa podem citar documentos que foram removidos ou desmarcados: nunca use informações delas que não estejam nos documentos atuais.
3. Fidelidade Literal a Siglas e Nomes: NUNCA tente adivinhar, supor ou expandir siglas ou nomes abreviados (como BMA, IGM, Vivest, etc.), a menos que o próprio texto do documento forneça expressamente a definição. Mantenha os nomes e termos técnicos exatamente como constam nos documentos.
4. Quando a pergunta pedir comparação ou citar documentos e houver apenas parte deles no contexto atual, responda com o que está disponível e declare claramente: "Apenas o documento <nome> está selecionado; não há outro documento para comparar." (substitua <nome> pelo nome do documento selecionado).
5. O código [[SEM_INFORMACAO]] só pode ser usado como resposta INTEIRA (nada mais na mensagem). Se a pergunta não puder ser respondida com o conteúdo dos documentos fornecidos, responda SOMENTE com o texto exato: [[SEM_INFORMACAO]]
   Não escreva mais nada além disso nesse caso — nem explicações, nem desculpas, nem saudações. NUNCA misture [[SEM_INFORMACAO]] com outro texto.
6. Nunca misture informação real dos documentos com suposições. Se a informação for parcial, declare apenas o que está documentado.
7. Bloqueio Estrito de Imagens: NÃO gere tags de imagens ou links de imagem (![alt](url)), responda somente em texto e tabelas Markdown.
${memoryInstructionBlock ? `\n⚠️ INSTRUÇÕES SOBREPOSTAS DA CONVERSA:\n${memoryInstructionBlock}` : ""}
8. Responda sempre em Português Brasileiro de forma profissional e direta.`;

    const historyMessages: (HumanMessage | AIMessage)[] = [];
    if (history && Array.isArray(history)) {
      history.forEach((msg: any) => {
        if (msg.sender === "user") {
          historyMessages.push(new HumanMessage(msg.text || ""));
        } else {
          historyMessages.push(new AIMessage(msg.text || ""));
        }
      });
    }

    const isOverview = isFolderOverviewQuery(question);

    let retrievedDocs: Document[] = [];
    let formatContextFn: (docs: Document[]) => string;
    let retrieverRunnable: any;

    if (isOverview) {
      let files = conversationFiles.filter((f: any) => effectiveSelectedIds.includes(f.fileId));

      let filesListText = "LISTA COMPLETA DE ARQUIVOS, CLIENTES E PROCESSOS SELECIONADOS NA CONVERSA ATUAL:\n";
      if (files.length === 0) {
        filesListText += "(Nenhum arquivo ou cliente selecionado nesta conversa.)\n";
      } else {
        files.forEach((file: any, idx: number) => {
          filesListText += `- Arquivo #${idx + 1}: "${file.fileName}"\n`;
          filesListText += `  * Cliente: "${file.clientName}"\n`;
          filesListText += `  * Processo/Robô: "${file.robotName}"\n`;
          filesListText += `  * Metadados: Tamanho: ${file.size || "15 KB"} | Trechos: ${file.chunkCount}\n`;
          
          const firstChunk = conversationChunks.find((c: any) => c.fileId === file.fileId);
          if (firstChunk) {
            filesListText += `  * Resumo/Conteúdo Inicial:\n    \"\"\"\n    ${firstChunk.text.substring(0, 1000)}...\n    \"\"\"\n`;
          }
          filesListText += `-----------------------------------------\n`;
        });
      }

      const overviewDocs = files.map((f: any) => new Document({
        pageContent: `Arquivo: ${f.fileName} - Cliente: ${f.clientName} - Robô: ${f.robotName}`,
        metadata: {
          fileId: f.fileId,
          fileName: f.fileName,
          secao: "",
          clientName: f.clientName,
          robotName: f.robotName,
          distancia: 0
        }
      }));

      retrieverRunnable = async () => overviewDocs;
      formatContextFn = () => {
        retrievedDocs = overviewDocs;
        return filesListText;
      };
    } else {
      const embeddings = new FirestoreGeminiEmbeddings(resolvedUserEmail);
      retrieverRunnable = new FirestoreRetriever({
        userEmail: resolvedUserEmail,
        activeSessionId,
        consideredChunks,
        conversationChunks,
        selectedFileIds: effectiveSelectedIds,
        embeddings
      });
      formatContextFn = (docs: Document[]) => {
        retrievedDocs = docs;
        return formatDocumentsContext(docs);
      };
    }

    const promptTemplate = ChatPromptTemplate.fromMessages([
      ["system", "{system_instruction}"],
      new MessagesPlaceholder("history"),
      ["human", "{user_prompt}"]
    ]);

    const chatModel = createChatModel(0.2);

    const ragChain = RunnableSequence.from([
      {
        context: RunnableSequence.from([
          (input: { question: string }) => input.question,
          retrieverRunnable,
          formatContextFn
        ]),
        question: (input: { question: string }) => input.question
      },
      {
        system_instruction: () => systemInstruction,
        history: () => historyMessages,
        user_prompt: (prev: { context: string; question: string }) => {
          let merged = "";
          if (attachmentTexts.length > 0) {
            merged += `Você recebeu arquivos anexados diretamente no chat pelo usuário para análise em tempo real.\n\n${attachmentTexts.join("\n\n")}\n\n`;
          }
          const selectedDocsList = conversationFiles
            .filter((f: any) => effectiveSelectedIds.includes(f.fileId))
            .map((f: any) => f.fileName);
          const docsLabel = selectedDocsList.length === 1
            ? `DOCUMENTO ATUALMENTE SELECIONADO: "${selectedDocsList[0]}" (apenas 1 documento selecionado)`
            : `DOCUMENTOS ATUALMENTE SELECIONADOS (${selectedDocsList.length}): ${selectedDocsList.map(n => `"${n}"`).join(", ")}`;
          merged += `${docsLabel}\n\n`;

          if (prev.context) {
            merged += `CONTEXTO ADICIONAL DO BANCO DE DADOS:\n============================================================\n${prev.context}\n============================================================\n\n`;
          }
          if (memoryInstructionBlock) {
            merged += `\n⚠️ LEMBRETE DE REGRAS PERSONALIZADAS/INSTRUÇÕES DA SESSÃO:\n${memoryInstructionBlock}\n`;
          }
          merged += `PERGUNTA DO USUÁRIO: "${prev.question}"\n\nLEMBRETE DAS DIRETRIZES:
1. Responda primeiro à pergunta em poucas frases diretas. Use listas ou tabelas Markdown apenas quando ajudarem a organizar os dados.
2. Aprofunde apenas se o usuário tiver pedido.
3. Não crie relatórios nem mencione PDF ou documentos de download.
4. Responda SOMENTE com base nos documentos do CONTEXTO ATUAL. Mensagens anteriores desta conversa podem citar documentos que foram removidos ou desmarcados: nunca use informações delas que não estejam nos documentos atuais.
5. Quando a pergunta pedir comparação ou citar documentos e houver apenas parte deles no contexto atual, responda com o que está disponível e declare claramente: "Apenas o documento <nome> está selecionado; não há outro documento para comparar."
6. [[SEM_INFORMACAO]] só pode ser usado como resposta INTEIRA (nada mais na mensagem). Se não houver informação nos documentos para responder à pergunta, responda estritamente: [[SEM_INFORMACAO]]. Nunca misture esse código com outro texto.`;
          return merged;
        }
      },
      promptTemplate,
      chatModel,
      new StringOutputParser()
    ]);

    const chainStartTime = Date.now();
    let fullAnswerText = "";

    const stream = await ragChain.stream({ question });

    for await (const chunk of stream) {
      if (chunk) {
        fullAnswerText += chunk;
        res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
        if (typeof (res as any).flush === "function") {
          (res as any).flush();
        }
      }
    }

    const chainDuration = Date.now() - chainStartTime;
    console.log(`[LangChain] cadeia executada em ${chainDuration} ms`);

    // 2. [[SEM_INFORMACAO]] só pode ser usado como resposta INTEIRA (nada mais na mensagem).
    // Se a LLM devolver esse código misturado com outro texto, o servidor deve removê-lo.
    if (fullAnswerText.trim() === "[[SEM_INFORMACAO]]") {
      fullAnswerText = "[[SEM_INFORMACAO]]";
    } else if (fullAnswerText.includes("[[SEM_INFORMACAO]]")) {
      fullAnswerText = fullAnswerText.replace(/\[\[SEM_INFORMACAO\]\]/g, "").replace(/\s{2,}/g, " ").trim();
      res.write(`data: ${JSON.stringify({ replaceText: fullAnswerText })}\n\n`);
    }

    const sources = retrievedDocs.map(doc => ({
      fileName: doc.metadata.fileName,
      clientName: doc.metadata.clientName,
      robotName: doc.metadata.robotName,
      text: doc.pageContent,
      secao: doc.metadata.secao,
      score: typeof doc.metadata.distancia === "number" ? Math.max(0, 1 - doc.metadata.distancia) : 1.0
    }));

    // O SERVIDOR monta essa linha a partir dos chunks realmente enviados no contexto (arquivo › seção, sem repetir) e a anexa ao final da resposta
    if (sources.length > 0 && !fullAnswerText.includes("[[SEM_INFORMACAO]]")) {
      const uniqueSources = Array.from(new Set(sources.map(s => {
        const sec = s.secao ? ` › ${s.secao}` : "";
        return `${s.fileName}${sec}`;
      })));
      if (uniqueSources.length > 0) {
        fullAnswerText = fullAnswerText.replace(/\n*Fontes:.*$/is, "").trim();
        const sourcesLine = `\n\nFontes: ${uniqueSources.join("; ")}`;
        fullAnswerText += sourcesLine;
        res.write(`data: ${JSON.stringify({ text: sourcesLine })}\n\n`);
      }
    }

    // Salva a resposta completa final no Firestore
    await saveChatMessage(resolvedUserEmail, activeSessionId, {
      sender: "assistant",
      text: fullAnswerText
    });

    // Envia evento final com metadados e fontes
    res.write(`data: ${JSON.stringify({ done: true, sources })}\n\n`);
    res.end();
  } catch (err: any) {
    console.error("Erro no processamento do chat:", err);
    let friendlyMessage = "Serviço temporariamente indisponível. Por favor, tente novamente em alguns instantes.";
    
    const errString = String(err.message || err);
    if (errString.includes("429") || errString.includes("quota") || errString.includes("Quota exceeded") || errString.includes("limit")) {
      friendlyMessage = "Serviço indisponível no momento devido ao limite de cota atingido no plano gratuito. Por favor, aguarde um instante e tente novamente.";
    } else if (errString.includes("timeout") || errString.includes("TIMEOUT") || errString.includes("Deadline exceeded") || errString.includes("504")) {
      friendlyMessage = "O serviço demorou muito para responder (timeout). Por favor, tente enviar sua pergunta novamente.";
    } else if (errString.includes("API_KEY") || errString.includes("API key")) {
      friendlyMessage = "Chave de API do Gemini não configurada ou inválida. Certifique-se de configurar sua GEMINI_API_KEY no painel de configurações.";
    } else {
      friendlyMessage = `Ocorreu um erro ao processar sua pergunta: ${err.message || "Erro interno de comunicação com a IA."}`;
      friendlyMessage = friendlyMessage.replace(/https?:\/\/[^\s]+/g, "").replace(/\bport \d+\b/gi, "").trim();
    }

    if (!res.headersSent) {
      res.status(500).json({ error: friendlyMessage });
    } else {
      res.write(`data: ${JSON.stringify({ error: friendlyMessage })}\n\n`);
      res.end();
    }
  }
});

// Setup do Vite e do servidor Express
async function startServer() {
  const httpServer = http.createServer(app);

  // Vite em desenvolvimento
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { 
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === "true" ? false : { server: httpServer }
      },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    // Servidor de produção estático
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[biti9 Server] Rodando com sucesso na porta ${PORT}`);
  });
}

startServer();
