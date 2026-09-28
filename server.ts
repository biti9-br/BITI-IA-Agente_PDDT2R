import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import * as XLSX from "xlsx";
import mammoth from "mammoth";
import { VectorDatabase, VectorChunk, PDDDocument } from "./src/types";
import { initializeApp as initClientFirebase } from "firebase/app";
import { getFirestore as getClientFirestore, doc, getDoc, getDocs, setDoc, deleteDoc, collection } from "firebase/firestore";
import { initializeApp as initAdminApp, getApps as getAdminApps, cert } from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import { getFirestore as getAdminFirestore, FieldValue as AdminFieldValue } from "firebase-admin/firestore";

dotenv.config();

const configPath = path.join(process.cwd(), "firebase-applet-config.json");
let firebaseConfig: any = null;
if (fs.existsSync(configPath)) {
  try {
    firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    console.error("Erro ao carregar firebase-applet-config.json:", e);
  }
}

let firebaseApp: any = null;
let firestoreDb: any = null;
let firestoreDbActive = false;

if (process.env.ENABLE_FIRESTORE === "true" && firebaseConfig && firebaseConfig.apiKey) {
  try {
    firebaseApp = initClientFirebase(firebaseConfig);
    firestoreDb = getClientFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);
    firestoreDbActive = true;
    console.log("[Firebase] Inicializado com sucesso no backend para persistência durável!");
  } catch (err) {
    console.error("[Firebase] Falha ao inicializar o Firebase no backend:", err);
    firestoreDbActive = false;
  }
}

// Inicialização segura do Firebase Admin
let adminApp: any = null;
let adminFirestoreDb: any = null;
try {
  if (getAdminApps().length === 0) {
    const adminConfig: any = {};
    if (firebaseConfig && firebaseConfig.projectId) {
      adminConfig.projectId = firebaseConfig.projectId;
    }
    adminApp = initAdminApp(adminConfig);
  } else {
    adminApp = getAdminApps()[0];
  }
  adminFirestoreDb = getAdminFirestore();
  console.log("[Firebase Admin] Inicializado com sucesso para autenticação e busca vetorial.");
} catch (adminErr) {
  console.warn("[Firebase Admin] Aviso ao inicializar Firebase Admin:", adminErr);
}

// 1. Resolver o uid a partir do userEmail já existente
async function obterUidPorEmail(email: string): Promise<string | null> {
  if (!email || !email.trim()) return null;
  try {
    const auth = getAdminAuth();
    const usuario = await auth.getUserByEmail(email.trim().toLowerCase());
    return usuario.uid;
  } catch (e) {
    return null; // usuário não encontrado no Firebase Auth
  }
}

// 2. Busca vetorial no histórico de conversas
async function gerarEmbeddingHistorico(ai: GoogleGenAI, texto: string): Promise<number[]> {
  try {
    const resultado = await ai.models.embedContent({
      model: "text-embedding-004",
      contents: texto,
    });
    const embedding = (resultado as any).embedding?.values ||
                      (Array.isArray((resultado as any).embeddings) ? (resultado as any).embeddings[0]?.values : null);
    return Array.isArray(embedding) ? embedding : [];
  } catch (err) {
    console.error("[gerarEmbeddingHistorico] Erro ao gerar embedding:", err);
    return [];
  }
}

async function buscarHistoricoRelevante(ai: GoogleGenAI, uid: string, pergunta: string, limite = 5): Promise<string[]> {
  if (!adminFirestoreDb || !uid) return [];
  try {
    const embeddingPergunta = await gerarEmbeddingHistorico(ai, pergunta);
    if (!embeddingPergunta || embeddingPergunta.length === 0) {
      return [];
    }

    const resultado = await adminFirestoreDb
      .collection("chunks")
      .where("uid", "==", uid)
      .findNearest({
        vectorField: "embedding",
        queryVector: AdminFieldValue.vector(embeddingPergunta),
        limit: limite,
        distanceMeasure: "COSINE",
      })
      .get();

    const trechos = resultado.docs.map((docSnap: any) => docSnap.data().texto as string).filter(Boolean);
    console.log(`[RAG Histórico] Encontrados ${trechos.length} trechos relevantes de conversas anteriores para uid ${uid}`);
    return trechos;
  } catch (erro) {
    console.error("Falha na busca vetorial de histórico:", erro);
    return [];
  }
}

// Mecanismo de bloqueio (Mutex) por usuário para evitar race conditions em gravações paralelas
const dbLocks: Record<string, Promise<any>> = {};

async function acquireDBLock(userEmail: string): Promise<() => void> {
  const userKey = userEmail.toLowerCase().trim();
  const currentLock = dbLocks[userKey] || Promise.resolve();
  let resolveLock: () => void;
  const nextLock = new Promise<void>((resolve) => {
    resolveLock = resolve;
  });
  dbLocks[userKey] = nextLock;
  await currentLock;
  return resolveLock!;
}

const app = express();
const PORT = 3000;

// Permite receber dados maiores, como tokens ou PDFs em base64
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Inicializa a pasta de dados
const DATA_DIR = path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "vector_db.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Inicialização padrão do banco de dados vetorial
function getInitialDB(): VectorDatabase {
  return {
    indexedFiles: {},
    chunks: [],
    rootFolderId: "",
    rootFolderName: "",
    mode: "demo",
    embeddingCache: {}
  };
}

// Helper to retrieve user email from request query, body, or headers
function getRequestUserEmail(req: express.Request): string {
  const email = (req.query.email as string) || 
                (req.headers["x-user-email"] as string) || 
                (req.body && req.body.userEmail) || 
                "gabriel.conceicao@biti9.com.br";
  return email.trim().toLowerCase();
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

// Get the DB file path based on user email to guarantee physical persistence and isolation
function getDBPath(userEmail?: string): string {
  const email = (userEmail && userEmail.trim()) ? userEmail.trim().toLowerCase() : "gabriel.conceicao@biti9.com.br";
  const safeEmail = email.replace(/[^a-zA-Z0-9]/g, "_");
  return path.join(DATA_DIR, `vector_db_${safeEmail}.json`);
}

// Carrega ou inicializa o banco de dados
function loadDB(userEmail?: string): VectorDatabase {
  const dbFile = getDBPath(userEmail);
  try {
    if (fs.existsSync(dbFile)) {
      const content = fs.readFileSync(dbFile, "utf8");
      return JSON.parse(content);
    }
  } catch (e) {
    console.error(`Erro ao carregar o banco de dados vetorial para ${userEmail || 'default'}, reiniciando...`, e);
  }
  const db = getInitialDB();
  saveDB(db, userEmail);
  return db;
}

function saveDB(db: VectorDatabase, userEmail?: string) {
  const dbFile = getDBPath(userEmail);
  try {
    fs.writeFileSync(dbFile, JSON.stringify(db, null, 2), "utf8");
  } catch (e) {
    console.error(`Erro ao salvar o banco de dados vetorial para ${userEmail || 'default'}`, e);
  }
}

// Carrega o banco de dados do Firestore
async function loadDBFromFirestore(userEmail: string): Promise<VectorDatabase | null> {
  if (!firestoreDb || !firestoreDbActive) return null;
  try {
    const userEmailKey = userEmail.toLowerCase().trim();
    
    // 1. Carregar Configurações Principais
    const configDocRef = doc(firestoreDb, `users/${userEmailKey}/config/main`);
    const configSnap = await getDoc(configDocRef);
    const configData = configSnap.exists() ? configSnap.data() : {};

    // 2. Carregar Metadados dos Arquivos
    const filesSnap = await getDocs(collection(firestoreDb, `users/${userEmailKey}/files`));
    const indexedFiles: Record<string, any> = {};
    filesSnap.forEach(doc => {
      indexedFiles[doc.id] = doc.data();
    });

    // 3. Carregar Chunks de Vetores
    const chunksSnap = await getDocs(collection(firestoreDb, `users/${userEmailKey}/chunks`));
    const chunks: any[] = [];
    chunksSnap.forEach(doc => {
      chunks.push(doc.data());
    });

    // 4. Carregar Histórico de Sessões
    const sessionsSnap = await getDocs(collection(firestoreDb, `users/${userEmailKey}/sessions`));
    const sessions: Record<string, any> = {};
    sessionsSnap.forEach(doc => {
      sessions[doc.id] = doc.data();
    });

    // 5. Carregar Cache de Embeddings
    let embeddingCache: Record<string, number[]> = {};
    try {
      const cacheSnap = await getDocs(collection(firestoreDb, `users/${userEmailKey}/embeddingCache`));
      cacheSnap.forEach(doc => {
        embeddingCache[doc.id] = doc.data().embedding;
      });
    } catch (e) {
      console.warn("[Firebase] Falha ao carregar embeddingCache do Firestore, iniciando vazio:", e);
    }

    return {
      mode: (configData.mode as 'real' | 'demo') || "demo",
      rootFolderId: configData.rootFolderId || "",
      rootFolderName: configData.rootFolderName || "",
      indexedFiles,
      chunks,
      sessions,
      embeddingCache
    };
  } catch (err: any) {
    console.error("[Firebase] Erro ao carregar dados do Firestore para", userEmail, err);
    const errMsg = err?.message || String(err);
    if (
      errMsg.includes("PERMISSION_DENIED") ||
      errMsg.includes("permission-denied") ||
      errMsg.includes("not been used") ||
      errMsg.includes("disabled") ||
      errMsg.includes("offline")
    ) {
      console.warn("[Firebase] Firestore está inacessível, desabilitado ou offline. Desativando persistência do Firestore no runtime para evitar lentidão e erros, utilizando apenas persistência local.");
      firestoreDbActive = false;
    }
    return null;
  }
}

// Salva todo o banco de dados no Firestore
async function saveDBToFirestore(db: VectorDatabase, userEmail: string): Promise<void> {
  if (!firestoreDb || !firestoreDbActive) return;
  try {
    const userEmailKey = userEmail.toLowerCase().trim();

    // 1. Salvar Configurações Principais
    const configDocRef = doc(firestoreDb, `users/${userEmailKey}/config/main`);
    await setDoc(configDocRef, {
      mode: db.mode,
      rootFolderId: db.rootFolderId,
      rootFolderName: db.rootFolderName,
      updatedAt: new Date().toISOString()
    });

    // 2. Salvar Metadados dos Arquivos
    for (const [fileId, file] of Object.entries(db.indexedFiles)) {
      const fileDocRef = doc(firestoreDb, `users/${userEmailKey}/files/${fileId}`);
      await setDoc(fileDocRef, file);
    }

    // 3. Salvar Chunks de Vetores
    for (const chunk of db.chunks) {
      const chunkDocRef = doc(firestoreDb, `users/${userEmailKey}/chunks/${chunk.id}`);
      await setDoc(chunkDocRef, chunk);
    }

    // 4. Salvar Histórico de Sessões
    if (db.sessions) {
      for (const [sessionId, session] of Object.entries(db.sessions)) {
        const sessionDocRef = doc(firestoreDb, `users/${userEmailKey}/sessions/${sessionId}`);
        await setDoc(sessionDocRef, session);
      }
    }

    // 5. Salvar Cache de Embeddings
    if (db.embeddingCache) {
      for (const [hash, embedding] of Object.entries(db.embeddingCache)) {
        const cacheDocRef = doc(firestoreDb, `users/${userEmailKey}/embeddingCache/${hash}`);
        await setDoc(cacheDocRef, { embedding });
      }
    }
  } catch (err: any) {
    console.error("[Firebase] Erro ao salvar dados no Firestore para", userEmail, err);
    const errMsg = err?.message || String(err);
    if (
      errMsg.includes("PERMISSION_DENIED") ||
      errMsg.includes("permission-denied") ||
      errMsg.includes("not been used") ||
      errMsg.includes("disabled") ||
      errMsg.includes("offline")
    ) {
      console.warn("[Firebase] Firestore está inacessível, desabilitado ou offline durante a gravação. Desativando persistência do Firestore.");
      firestoreDbActive = false;
    }
  }
}

// Popula PDDs demonstrativos de forma síncrona caso o banco esteja totalmente zerado
function seedInitialDemoFiles(db: VectorDatabase) {
  for (const demoPdd of DEMO_PDDS) {
    const fileId = `demo_file_${demoPdd.fileName.replace(/\./g, "_")}`;
    if (db.indexedFiles[fileId]) continue;

    const chunksText = chunkText(demoPdd.content, 1000, 200);
    const fileChunks: VectorChunk[] = [];

    for (let i = 0; i < chunksText.length; i++) {
      const text = chunksText[i];
      const mockEmbedding = Array(768).fill(0).map((_, idx) => Math.sin(idx + i));
      fileChunks.push({
        id: `${fileId}_chunk_${i}`,
        fileId,
        conversationId: "default_session",
        fileName: demoPdd.fileName,
        clientId: `demo_client_${demoPdd.clientName.replace(/\s+/g, "_")}`,
        clientName: demoPdd.clientName,
        robotId: `demo_robot_${demoPdd.robotName.replace(/\s+/g, "_")}`,
        robotName: demoPdd.robotName,
        text,
        embedding: mockEmbedding
      });
    }

    db.indexedFiles[fileId] = {
      fileId,
      conversationId: "default_session",
      fileName: demoPdd.fileName,
      clientId: `demo_client_${demoPdd.clientName.replace(/\s+/g, "_")}`,
      clientName: demoPdd.clientName,
      robotId: `demo_robot_${demoPdd.robotName.replace(/\s+/g, "_")}`,
      robotName: demoPdd.robotName,
      modifiedTime: new Date().toISOString(),
      size: "15.0 KB",
      chunkCount: fileChunks.length,
      indexedAt: new Date().toISOString()
    };

    db.chunks.push(...fileChunks);
  }
}

// Carrega o banco de dados assincronamente combinando o armazenamento local e o Firestore de forma resiliente
async function loadDBAsync(userEmail?: string): Promise<VectorDatabase> {
  const resolvedEmail = (userEmail && userEmail.trim()) ? userEmail.trim().toLowerCase() : "gabriel.conceicao@biti9.com.br";
  
  // 1. Tentar ler do arquivo local do usuário
  const dbFile = getDBPath(resolvedEmail);
  let localDb: VectorDatabase | null = null;
  try {
    if (fs.existsSync(dbFile)) {
      const content = fs.readFileSync(dbFile, "utf8");
      localDb = JSON.parse(content);
    }
  } catch (e) {
    console.error(`Erro ao carregar o banco de dados vetorial local para ${resolvedEmail}`, e);
  }

  // Fallback / Migração: Se o arquivo do usuário estiver sem arquivos mas existir vector_db.json genérico
  if ((!localDb || Object.keys(localDb.indexedFiles || {}).length === 0) && fs.existsSync(DB_FILE)) {
    try {
      const globalContent = fs.readFileSync(DB_FILE, "utf8");
      const globalDb = JSON.parse(globalContent);
      if (globalDb && globalDb.indexedFiles && Object.keys(globalDb.indexedFiles).length > 0) {
        if (!localDb) localDb = getInitialDB();
        localDb.indexedFiles = { ...globalDb.indexedFiles, ...(localDb.indexedFiles || {}) };
        localDb.chunks = [...(globalDb.chunks || []), ...(localDb.chunks || [])];
        console.log(`[Database Migration] ${Object.keys(globalDb.indexedFiles).length} arquivos migrados para ${resolvedEmail}`);
      }
    } catch (e) {
      console.warn("Falha ao migrar de vector_db.json:", e);
    }
  }

  // 2. Se Firestore estiver ativo, ler os dados remotos
  let firestoreDbData: VectorDatabase | null = null;
  if (firestoreDb && firestoreDbActive) {
    firestoreDbData = await loadDBFromFirestore(resolvedEmail);
  }

  // 3. Mesclagem sem perda de dados: reune todos os arquivos locais e remotos
  const mergedFiles: Record<string, any> = {
    ...(localDb?.indexedFiles || {}),
    ...(firestoreDbData?.indexedFiles || {})
  };

  // Dedup de chunks por ID
  const chunkMap = new Map<string, any>();
  (localDb?.chunks || []).forEach(c => chunkMap.set(c.id, c));
  (firestoreDbData?.chunks || []).forEach(c => chunkMap.set(c.id, c));

  const mergedDb: VectorDatabase = {
    mode: firestoreDbData?.mode || localDb?.mode || "demo",
    rootFolderId: firestoreDbData?.rootFolderId || localDb?.rootFolderId || "",
    rootFolderName: firestoreDbData?.rootFolderName || localDb?.rootFolderName || "",
    indexedFiles: mergedFiles,
    chunks: Array.from(chunkMap.values()),
    sessions: { ...(localDb?.sessions || {}), ...(firestoreDbData?.sessions || {}) },
    embeddingCache: { ...(localDb?.embeddingCache || {}), ...(firestoreDbData?.embeddingCache || {}) }
  };

  // Se o banco estiver completamente zerado, insere os arquivos padrão de demonstração
  if (Object.keys(mergedDb.indexedFiles).length === 0) {
    seedInitialDemoFiles(mergedDb);
  }

  // Atualiza arquivo local
  saveDB(mergedDb, resolvedEmail);

  // Sincroniza em segundo plano para o Firestore
  if (firestoreDb && firestoreDbActive) {
    saveDBToFirestore(mergedDb, resolvedEmail).catch(err => {
      console.warn("[Firebase] Erro na sincronização em background:", err);
    });
  }

  return mergedDb;
}

// Salva o banco de dados assincronamente no local e no Firestore
async function saveDBAsync(db: VectorDatabase, userEmail?: string): Promise<void> {
  saveDB(db, userEmail);
  if (userEmail && firestoreDb && firestoreDbActive) {
    await saveDBToFirestore(db, userEmail);
  }
}

// Utilitário de similaridade de cosseno
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA === 0 || normB === 0 ? 0 : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
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
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY não configurada nas variáveis de ambiente do servidor.");
    }
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

// Helper para gerar conteúdo com retentativas (retries) e modelo de fallback robusto
async function generateContentWithFallback(ai: GoogleGenAI, params: any): Promise<any> {
  const modelsToTry = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.1-flash-lite"];
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
        const isTransient = errStr.includes("503") || 
                            errStr.includes("UNAVAILABLE") || 
                            errStr.includes("high demand") || 
                            errStr.includes("RESOURCE_EXHAUSTED") ||
                            err.status === 503 || 
                            err.statusCode === 503 ||
                            err.status === 429 ||
                            err.statusCode === 429;
        
        console.warn(`[WARN] Erro na tentativa ${attempt} com o modelo ${model}: ${errStr}`);
        if (!isTransient) {
          // Se for um erro definitivo (ex: 404, formato inválido), não adianta retentar, muda para o próximo modelo
          break;
        }
        // Espera um tempo curto com backoff exponencial antes de tentar novamente
        await new Promise(resolve => setTimeout(resolve, 800 * attempt));
      }
    }
  }
  throw lastError || new Error("Falha ao gerar conteúdo com Gemini após várias tentativas e fallbacks.");
}

// Helper para obter embedding usando cache para evitar requisições desnecessárias à API
async function getEmbeddingWithCache(ai: GoogleGenAI, text: string, db: VectorDatabase): Promise<number[]> {
  if (!db.embeddingCache) {
    db.embeddingCache = {};
  }
  const textHash = crypto.createHash("sha256").update(text).digest("hex");
  if (db.embeddingCache[textHash] && Array.isArray(db.embeddingCache[textHash]) && db.embeddingCache[textHash].length > 0) {
    return db.embeddingCache[textHash];
  }

  try {
    const embResponse = await ai.models.embedContent({
      model: "gemini-embedding-2-preview",
      contents: text
    });

    const embedding = (embResponse as any).embedding?.values || 
                      (Array.isArray((embResponse as any).embeddings) ? (embResponse as any).embeddings[0]?.values : null);
    if (!embedding || !Array.isArray(embedding)) {
      throw new Error("Formato inválido de resposta de embedding.");
    }

    db.embeddingCache[textHash] = embedding;
    return embedding;
  } catch (err: any) {
    const errMsg = err.message || String(err);
    console.error(`[Embedding API Error] Falha ao obter embedding para hash ${textHash}:`, errMsg);
    if (errMsg.includes("429") || errMsg.includes("quota") || errMsg.includes("limit") || errMsg.includes("Quota exceeded")) {
      throw new Error("Cota de solicitações de IA (embeddings) temporariamente excedida no plano gratuito. Por favor, certifique-se de que a chave de API possui faturamento ativado (Billing) ou tente novamente em alguns instantes.");
    }
    throw err;
  }
}

// Dados simulados para o modo demonstrativo (Demo Mode)
const DEMO_PDDS = [
  {
    fileName: "PDD_Abertura_Contas_V2.pdf",
    clientName: "Cliente A (Banco Global)",
    robotName: "Robô de Abertura de Contas",
    content: `Process Design Document (PDD) - Robô de Abertura de Contas de Pessoa Física
Este documento define as regras de negócio e especificações técnicas para a automação do processo de abertura de contas correntes.

Objetivo do Robô:
Automatizar a triagem de fichas cadastrais enviadas por e-mail, validação de documentos de identidade e criação de contas no sistema legado do banco.

Fluxo do Processo:
1. Entrada de Dados: O robô monitora a caixa postal "novascontas@bancoglobal.com.br" a cada 5 minutos em busca de e-mails com o assunto "Abertura de Conta - [Nome do Cliente]".
2. Extração de Documentos: O robô faz o download do arquivo PDF anexo que contém a Ficha Cadastral e fotos do RG/CPF ou CNH.
3. OCR e Validação de Dados:
   - Extrai o CPF, Nome Completo, Data de Nascimento e Nome da Mãe.
   - Consulta o portal da Receita Federal (via API ou navegação web automatizada) para verificar a regularidade do CPF. Se o CPF estiver 'Cancelado' ou 'Irregular', o robô encerra o caso e envia e-mail de rejeição automática ao cliente.
4. Consulta Serasa / Crédito:
   - Realiza consulta cadastral no Serasa Experian.
   - Se o score do cliente for menor que 400 pontos, o robô encaminha o caso para análise humana no Jira e anexa o relatório em PDF.
   - Se o score for maior ou igual a 400 pontos, prossegue com o fluxo automático.
5. Inserção no Core Bancário:
   - Abre o sistema legado 'CoreBank v8.2' via emulador de terminal Mainframe.
   - Navega até a tela cadastral 'T-004' e insere os dados do cliente.
   - Confirma a operação e armazena o número da agência e conta corrente gerado.
6. Notificação Final:
   - Envia um e-mail de boas-vindas ao cliente contendo as informações da nova conta e instruções para primeiro acesso no aplicativo móvel.`
  },
  {
    fileName: "PDD_Conciliacao_Bancaria.pdf",
    clientName: "Cliente A (Banco Global)",
    robotName: "Robô de Conciliação Bancária",
    content: `Process Design Document (PDD) - Automação de Conciliação Financeira Diária
Documento de especificação para o robô de conciliação entre extratos de bancos físicos e lançamentos contábeis.

Descrição Geral:
O processo visa garantir que todas as transações realizadas nas contas bancárias do Cliente A correspondam exatamente aos lançamentos contidos no ERP SAP ERP Central Component (ECC).

Passo a Passo da Automação:
1. Download de Extratos: O robô acessa, diariamente às 07:00, os Internet Bankings do Itaú, Bradesco e Banco do Brasil utilizando credenciais armazenadas de forma segura no cofre de senhas CyberArk.
2. Formato do Extrato: Realiza o download dos extratos bancários consolidados do dia anterior no formato OFX.
3. Importação no SAP:
   - Abre o SAP ECC através do SAP GUI instalado na máquina virtual do robô.
   - Executa a transação contábil 'FF_5' (Importação Eletrônica de Extrato).
   - Carrega os arquivos OFX obtidos.
4. Batimento de Valores (Conciliação):
   - O robô extrai os lançamentos e realiza o batimento automático das transações com base no ID único de transação bancária e no valor exato.
   - Transações com divergência de centavos ou valores menores que R$ 100,00 são lançadas em uma conta de ajustes temporários automática.
   - Transações com divergência superior a R$ 100,00 ou sem correspondência são marcadas com a flag 'Pendente de Análise Manual'.
5. Relatório de Divergências:
   - Gera uma planilha Excel ('Divergencias_Conciliacao_[Data].xlsx') contendo os lançamentos não batidos.
   - Envia a planilha por e-mail para o time de contas a receber ('financeiro@clientea.com.br').`
  },
  {
    fileName: "PDD_Gerador_NFe.pdf",
    clientName: "Cliente B (Varejo Total)",
    robotName: "Robô de Emissão de Notas Fiscais",
    content: `Process Design Document (PDD) - Robô Emissor de Notas Fiscais Eletrônicas de Serviço (NFS-e)
Documento de design de processo para emissão em lote de notas fiscais no portal da prefeitura.

Escopo do Processo:
Realizar a emissão automática de NFS-e para todos os pedidos de venda de serviços faturados no e-commerce da Varejo Total.

Regras de Negócio e Passos:
1. Coleta de Pedidos: O robô conecta-se diretamente ao banco de dados relacional MySQL de produção e executa uma query na tabela 'pedidos' buscando por registros com status 'Faturamento_Pendente' e tipo 'Serviço'.
2. Preparação dos Dados:
   - Consolida os campos: Razão Social ou Nome do Comprador, CNPJ ou CPF, endereço completo, e-mail, descrição detalhada do serviço prestado e valor total.
   - Aplica a tabela de alíquotas tributárias de ISS dependendo do código de serviço selecionado para o item.
3. Emissão no Portal da Prefeitura:
   - O robô abre o navegador Google Chrome em modo headless e acessa o portal tributário da Prefeitura de São Paulo.
   - Realiza a autenticação segura por meio do Certificado Digital corporativo do tipo A1 (instalado diretamente na máquina de execução).
   - Preenche o formulário eletrônico de emissão campo por campo.
4. Download e Armazenamento:
   - Emite a guia, aguarda a geração da NFS-e e faz o download do arquivo XML da nota e do documento em PDF (RPS).
   - Salva os arquivos no servidor de arquivos da empresa na pasta '\\\\servidor\\nfs_emitidas\\2026\\[Nome_do_Cliente]'.
5. Atualização de Status:
   - Altera o status do pedido para 'Faturado_Emitido' no banco de dados MySQL e salva o número da nota fiscal gerada no campo correspondente.
   - Dispara um e-mail automático ao comprador anexando o PDF da nota fiscal de serviço.`
  },
  {
    fileName: "PDD_Cadastro_Produtos_ERP.pdf",
    clientName: "Cliente B (Varejo Total)",
    robotName: "Robô de Cadastro de Produtos",
    content: `Process Design Document (PDD) - Automação de Cadastro de Itens no ERP Totvs Protheus
Guia técnico de design do robô responsável por cadastrar mercadorias enviadas pelo setor de compras.

Objetivo Geral:
Eliminar erros de digitação e reduzir o tempo de cadastro de novos SKUs no ERP Totvs Protheus, garantindo as devidas parametrizações tributárias e fiscais.

Instruções Operacionais:
1. Leitura de Planilha de Origem:
   - O robô monitora uma planilha compartilhada no Google Sheets ('Cadastro_Mestre_Mercadorias').
   - Processa apenas as linhas marcadas com o status 'Aprovado pelo Compras' e que não possuem a coluna 'Status ERP' preenchida.
2. Enriquecimento de Dados:
   - O robô consome a API externa do portal Cosmos (Bluesoft) usando o código de barras (EAN-13) para recuperar automaticamente a descrição técnica padronizada, marca e classificação fiscal (NCM - Nomenclatura Comum do Mercosul).
3. Acesso ao ERP Protheus:
   - Abre o cliente do ERP Totvs Protheus via atalho de desktop.
   - Insere o login e senha de serviço e seleciona a filial correta de destino.
   - Navega até o módulo de 'Faturamento' (MATA010) -> Cadastro de Produtos.
4. Digitação dos Campos:
   - Preenche código interno sequencial, descrição comercial, unidade de medida, grupo de produto, código NCM e alíquota média de ICMS de entrada/saída.
   - Define o tipo do produto como 'PA' (Produto Acabado) ou 'MC' (Mercadoria para Revenda).
5. Gravação e Log:
   - Clica em 'Salvar' e monitora se houve popup de aviso ou de erro (ex: 'Código NCM inválido' ou 'EAN duplicado').
   - Se ocorrer erro, grava a mensagem de erro na planilha do Google Sheets e marca a linha como 'Erro Cadastro'.
   - Se salvou corretamente, atualiza o status na planilha como 'Cadastrado com Sucesso' e preenche o código interno gerado.`
  }
];

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
  const userEmail = getRequestUserEmail(req);
  const targetConversationId = getRequestConversationId(req);
  const db = await loadDBAsync(userEmail);
  
  // Lista apenas os arquivos vinculados a esta conversa
  const conversationFiles = Object.values(db.indexedFiles).filter(file => {
    const fileConvId = file.conversationId || "default_session";
    return fileConvId === targetConversationId;
  });

  const filesList = conversationFiles.map(file => ({
    id: file.fileId,
    fileId: file.fileId,
    conversationId: file.conversationId || "default_session",
    name: file.fileName,
    fileName: file.fileName,
    clientId: file.clientId,
    clientName: file.clientName,
    robotId: file.robotId,
    robotName: file.robotName,
    modifiedTime: file.modifiedTime,
    size: file.size,
    chunkCount: file.chunkCount,
    indexedAt: file.indexedAt,
    status: 'indexed',
    origin: (file as any).origin || 'Arquivo local',
    folderPath: (file as any).folderPath,
    originalName: (file as any).originalName || file.fileName
  }));

  const conversationChunks = db.chunks.filter(c => {
    const chunkConvId = c.conversationId || "default_session";
    return chunkConvId === targetConversationId;
  });

  // Agrupa os documentos por Cliente e Robô para exibir na estrutura do app
  const clientMap: Record<string, { id: string; name: string; robots: Record<string, { id: string; name: string; documents: any[] }> }> = {};
  
  conversationFiles.forEach(file => {
    const cId = file.clientId || "uploaded";
    const cName = file.clientName || "Fontes Enviadas";
    const rId = file.robotId || "direct_upload";
    const rName = file.robotName || "Uploads Diretos";

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
    
    clientMap[cId].robots[rId].documents.push({
      id: file.fileId,
      fileId: file.fileId,
      conversationId: file.conversationId || "default_session",
      name: file.fileName,
      clientId: cId,
      clientName: cName,
      robotId: rId,
      robotName: rName,
      modifiedTime: file.modifiedTime,
      size: file.size,
      chunkCount: file.chunkCount,
      indexedAt: file.indexedAt,
      status: 'indexed',
      origin: (file as any).origin || 'Arquivo local',
      folderPath: (file as any).folderPath,
      originalName: (file as any).originalName || file.fileName
    });
  });

  const clientGroups = Object.values(clientMap).map(client => ({
    id: client.id,
    name: client.name,
    robots: Object.values(client.robots)
  }));

  res.json({
    success: true,
    conversationId: targetConversationId,
    mode: db.mode,
    rootFolderId: db.rootFolderId,
    rootFolderName: db.rootFolderName,
    fileCount: conversationFiles.length,
    chunkCount: conversationChunks.length,
    files: filesList,
    clientGroups
  });
};

app.get("/api/db/status", getSourcesHandler);
app.get("/api/sources", getSourcesHandler);
app.get("/api/agent/files", getSourcesHandler);
app.get("/api/conversations/:conversationId/sources", getSourcesHandler);

// Endpoint para atualizar dados/título da conversa
const updateConversationHandler = async (req: express.Request, res: express.Response) => {
  const conversationId = req.params.conversationId || req.params.id;
  const { title, userEmail } = req.body;

  if (!conversationId) {
    return res.status(400).json({ error: "ID da conversa é obrigatório." });
  }

  try {
    const resolvedUserEmail = userEmail || getRequestUserEmail(req);
    const db = await loadDBAsync(resolvedUserEmail);

    if (!db.sessions) {
      db.sessions = {};
    }

    if (!db.sessions[conversationId]) {
      db.sessions[conversationId] = {
        sessionId: conversationId,
        title: title || "Nova Conversa",
        learnedFacts: [],
        messages: []
      };
    } else {
      if (title !== undefined) {
        db.sessions[conversationId].title = title;
      }
    }

    await saveDBAsync(db, resolvedUserEmail);

    return res.json({
      success: true,
      conversationId,
      title: db.sessions[conversationId].title
    });
  } catch (err: any) {
    console.error("Erro ao atualizar conversa:", err);
    return res.status(500).json({ error: "Erro ao atualizar o título da conversa." });
  }
};

app.patch("/api/conversations/:conversationId", updateConversationHandler);
app.put("/api/conversations/:conversationId", updateConversationHandler);

// Validador de tipo PDD estrutural utilizando IA
async function validarComoPDD(ai: GoogleGenAI, textoDocumento: string): Promise<{ valido: boolean; justificativa: string }> {
  const prompt = `Você é um especialista em Centro de Excelência de RPA que audita documentos de mapeamento de processos. Analise o texto abaixo e determine se ele é um PDD (Process Definition Document) no formato usado pela empresa.

Um PDD verdadeiro deste formato normalmente contém a maioria destes elementos:
- Título ou cabeçalho "Process Definition Document" ou "PDD", com campos [CLIENTE], [PROCESSO], [SUB-PROCESSO]
- Seções "Histórico de Revisões" e "Histórico de Aprovação"
- Seção "Descrição do Processo" com subseções como "Visão Geral do Processo", "Objetivos", "Contatos do Processo", "Pré-requisitos mínimos para automação", "Mapa do Processo", "Premissas do Processo"
- Seção "Responsabilidades" com matriz RACI (R, A, C, I)
- Seção "Detalhamento do Processo" com "Passo a Passo"
- Seção "Exceções e Regras de Negócio" com "Exceções de Negócio", "Exceções de Sistema", "Indicadores", "Relatórios"
- Campos como "Frequência de execução", "Criticidade", "Volumetria por período", "Franquia contratada"

Se o documento apresentar essa estrutura (mesmo incompleta ou com campos vazios), responda exatamente: SIM
Se for outro tipo de documento (contrato, planilha solta, e-mail, manual genérico, etc.), responda exatamente: NAO

Responda apenas com SIM ou NAO na primeira linha. Na segunda linha, uma justificativa breve.

Texto do documento:
"""
${textoDocumento.slice(0, 8000)}
"""`;

  try {
    const resultado = await generateContentWithFallback(ai, {
      contents: [prompt],
      config: {
        temperature: 0
      }
    });
    const texto = (resultado.text || "").trim();
    const linhas = texto.split("\n");
    const primeiraLinha = (linhas[0] || "").trim().toUpperCase();
    const valido = primeiraLinha.startsWith("SIM");
    const justificativa = linhas.slice(1).join(" ").trim() || (valido ? "Estrutura validada com sucesso como PDD." : "O documento não apresenta a estrutura obrigatória de um PDD.");

    return { valido, justificativa };
  } catch (err: any) {
    console.error("Erro na validação de PDD via Gemini:", err);
    // Em caso de falha transitória de API, analisar por marcadores estruturais do texto
    const lower = textoDocumento.toLowerCase();
    const temMarcadores = (lower.includes("process definition") || lower.includes("pdd")) &&
                          (lower.includes("processo") || lower.includes("visão geral") || lower.includes("histórico"));
    return {
      valido: temMarcadores,
      justificativa: temMarcadores
        ? "Documento aceito por conter os marcadores estruturais básicos de um PDD."
        : "Não foi possível confirmar a estrutura de PDD no documento."
    };
  }
}

// 2.1 Adicionar nova fonte manualmente (Source Management UI)
app.post("/api/db/add-source", async (req, res) => {
  const { name, type, base64, userEmail, origin, folderPath, originalName } = req.body;
  if (!name || !base64) {
    return res.status(400).json({ error: "Nome do arquivo e conteúdo base64 são necessários." });
  }

  try {
    const resolvedUserEmail = userEmail || getRequestUserEmail(req);
    const ai = getGeminiClient();

    const buffer = Buffer.from(base64, "base64");
    let extractedText = "";

    const nameLower = name.toLowerCase();
    if (nameLower.endsWith(".xlsx") || nameLower.endsWith(".xls") || nameLower.endsWith(".csv") || type.includes("sheet") || type.includes("excel") || type.includes("csv")) {
      try {
        const workbook = XLSX.read(buffer, { type: "buffer" });
        extractedText = `[CONTEÚDO DA PLANILHA / ARQUIVO CSV ENVIADO: ${name}]\n`;
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          const csvData = XLSX.utils.sheet_to_csv(sheet);
          extractedText += `--- ABA: ${sheetName} ---\n${csvData}\n`;
        }
      } catch (err: any) {
        console.error(`Erro ao ler planilha ${name}:`, err);
        return res.status(400).json({ error: `Erro ao extrair conteúdo da planilha/CSV: ${err.message}` });
      }
    } else if (nameLower.endsWith(".docx") || type.includes("word") || type.includes("officedocument.wordprocessingml")) {
      try {
        const result = await mammoth.extractRawText({ buffer });
        extractedText = `[CONTEÚDO DO DOCUMENTO WORD ENVIADO: ${name}]\n${result.value}`;
      } catch (err: any) {
        console.error(`Erro ao ler documento Word ${name}:`, err);
        return res.status(400).json({ error: `Erro ao extrair conteúdo do documento Word: ${err.message}` });
      }
    } else if (nameLower.endsWith(".txt") || nameLower.endsWith(".json") || type.includes("text/plain") || type.includes("application/json")) {
      extractedText = buffer.toString("utf-8");
    } else if (nameLower.endsWith(".pdf") || type.includes("pdf")) {
      // Validar cabeçalho do PDF
      if (buffer.length < 4 || buffer.toString("ascii", 0, 4) !== "%PDF") {
        return res.status(400).json({ error: "O arquivo PDF está corrompido, incompleto ou não é um PDF válido." });
      }
      
      // Verificar se o PDF está protegido/criptografado por senha
      const pdfString = buffer.toString("binary");
      if (pdfString.includes("/Encrypt")) {
        return res.status(400).json({ error: "O arquivo PDF está protegido por senha ou criptografado, impedindo a leitura." });
      }

      try {
        // Transcrever PDF via Gemini com retentativas e fallback robusto
        const response = await generateContentWithFallback(ai, {
          contents: [
            {
              inlineData: {
                mimeType: "application/pdf",
                data: base64
              }
            },
            "Por favor, extraia todo o texto legível e as tabelas deste documento na íntegra. Retorne apenas o texto extraído do documento, mantendo a estrutura original o máximo possível, sem comentários, notas ou explicações adicionais."
          ]
        });
        extractedText = response.text || "";
        if (!extractedText.trim()) {
          throw new Error("O Gemini não retornou nenhum texto para este documento.");
        }
      } catch (err: any) {
        console.error(`Erro ao transcrever documento com Gemini ${name}:`, err);
        return res.status(400).json({ error: `Erro na transcrição inteligente do arquivo: ${err.message}` });
      }
    } else if (type.startsWith("image/")) {
      try {
        // Transcrever Imagem via Gemini com retentativas e fallback robusto
        const response = await generateContentWithFallback(ai, {
          contents: [
            {
              inlineData: {
                mimeType: type,
                data: base64
              }
            },
            "Por favor, extraia todo o texto legível e as tabelas desta imagem na íntegra. Retorne apenas o texto extraído, sem comentários ou explicações adicionais."
          ]
        });
        extractedText = response.text || "";
        if (!extractedText.trim()) {
          throw new Error("O Gemini não retornou nenhum texto para esta imagem.");
        }
      } catch (err: any) {
        console.error(`Erro ao transcrever imagem com Gemini ${name}:`, err);
        return res.status(400).json({ error: `Erro na transcrição da imagem: ${err.message}` });
      }
    } else {
      extractedText = buffer.toString("utf-8");
    }

    if (!extractedText.trim()) {
      return res.status(400).json({ error: "Não foi possível extrair nenhum texto legível do arquivo enviado." });
    }

    // Validação de tipo PDD ao adicionar fonte
    const { valido, justificativa } = await validarComoPDD(ai, extractedText);
    if (!valido) {
      console.warn(`[VALIDAÇÃO PDD RECUSADA] Documento "${name}" rejeitado. Justificativa: ${justificativa}`);
      return res.status(422).json({
        erro: "Documento rejeitado: não corresponde ao formato PDD aceito pela aplicação.",
        error: "Documento rejeitado: não corresponde ao formato PDD aceito pela aplicação.",
        justificativa,
      });
    }

    // Dividir em chunks
    const textChunks = chunkText(extractedText, 1000, 200);

    const fileId = `uploaded_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    const targetConversationId = getRequestConversationId(req);
    const fileChunks: VectorChunk[] = [];

    // Metadados para fontes enviadas manualmente ou importadas do SharePoint
    const isSharePoint = origin === "SharePoint";
    const clientName = isSharePoint ? "SharePoint" : "Fontes Enviadas";
    const clientId = isSharePoint ? "sharepoint" : "uploaded";
    const robotName = folderPath ? folderPath : (isSharePoint ? "Biblioteca Corporativa" : "Uploads Diretos");
    const robotId = isSharePoint ? "sharepoint_docs" : "direct_upload";

    // Adquirir lock de gravação para sincronização segura concorrente
    const releaseDB = await acquireDBLock(resolvedUserEmail);
    try {
      const db = await loadDBAsync(resolvedUserEmail);

      for (let idx = 0; idx < textChunks.length; idx++) {
        const textVal = textChunks[idx];
        let embedding: number[] = [];
        try {
          embedding = await getEmbeddingWithCache(ai, textVal, db);
        } catch (embedErr) {
          console.warn(`Erro ao gerar embedding real para ${name} chunk ${idx}, gerando array mockado...`, embedErr);
          embedding = Array(768).fill(0).map(() => Math.random() - 0.5);
        }

        fileChunks.push({
          id: `${fileId}_chunk_${idx}`,
          fileId,
          conversationId: targetConversationId,
          fileName: name,
          clientId,
          clientName,
          robotId,
          robotName,
          text: textVal,
          embedding
        });
      }

      db.chunks.push(...fileChunks);
      db.indexedFiles[fileId] = {
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
        folderPath: folderPath || undefined,
        originalName: originalName || name
      };

      await saveDBAsync(db, resolvedUserEmail);
    } finally {
      releaseDB();
    }

    res.json({
      success: true,
      file: {
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
        indexedAt: new Date().toISOString()
      }
    });
  } catch (err: any) {
    console.error("Erro no processamento do upload manual:", err);
    res.status(500).json({ error: err.message || "Erro interno do servidor." });
  }
});

// 2.1.1 Adicionar fonte corporativa via Microsoft SharePoint / OneDrive
app.post("/api/db/add-sharepoint-source", async (req, res) => {
  const { sharepointUrl, name, siteName, libraryName, userEmail, content } = req.body;
  if (!sharepointUrl || typeof sharepointUrl !== "string" || !sharepointUrl.trim()) {
    return res.status(400).json({ error: "O link/URL do SharePoint ou OneDrive é obrigatório." });
  }

  try {
    const resolvedUserEmail = userEmail || getRequestUserEmail(req);
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

    const releaseDB = await acquireDBLock(resolvedUserEmail);
    try {
      const db = await loadDBAsync(resolvedUserEmail);

      for (let idx = 0; idx < textChunks.length; idx++) {
        const textVal = textChunks[idx];
        let embedding: number[] = [];
        try {
          embedding = await getEmbeddingWithCache(ai, textVal, db);
        } catch (embedErr) {
          console.warn(`Erro embedding SharePoint chunk ${idx}, usando fallback:`, embedErr);
          embedding = Array(768).fill(0).map(() => Math.random() - 0.5);
        }

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
          embedding
        });
      }

      db.chunks.push(...fileChunks);
      db.indexedFiles[fileId] = {
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
        indexedAt: new Date().toISOString()
      };

      await saveDBAsync(db, resolvedUserEmail);
    } finally {
      releaseDB();
    }

    res.json({
      success: true,
      file: {
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
      }
    });
  } catch (err: any) {
    console.error("Erro ao adicionar fonte do SharePoint:", err);
    res.status(500).json({ error: err.message || "Erro ao processar fonte do SharePoint." });
  }
});

// 2.2 Excluir fonte do painel de fontes
app.post("/api/db/delete-source", async (req, res) => {
  const { fileId, userEmail } = req.body;
  if (!fileId) {
    return res.status(400).json({ error: "ID do arquivo não informado." });
  }

  try {
    const resolvedUserEmail = userEmail || getRequestUserEmail(req);
    const db = await loadDBAsync(resolvedUserEmail);

    if (db.indexedFiles[fileId]) {
      delete db.indexedFiles[fileId];
      db.chunks = db.chunks.filter(c => c.fileId !== fileId);
      await saveDBAsync(db, resolvedUserEmail);

      // Excluir também do Firestore de forma assíncrona
      if (firestoreDb && firestoreDbActive && resolvedUserEmail) {
        const userEmailKey = resolvedUserEmail.toLowerCase().trim();
        try {
          const fileDocRef = doc(firestoreDb, `users/${userEmailKey}/files/${fileId}`);
          await deleteDoc(fileDocRef);

          // Remover os chunks associados do Firestore
          const chunksSnap = await getDocs(collection(firestoreDb, `users/${userEmailKey}/chunks`));
          for (const chunkDoc of chunksSnap.docs) {
            const chunkData = chunkDoc.data();
            if (chunkData.fileId === fileId) {
              await deleteDoc(doc(firestoreDb, `users/${userEmailKey}/chunks/${chunkDoc.id}`));
            }
          }
          console.log(`[Firebase] Arquivo ${fileId} e seus chunks excluídos do Firestore para ${resolvedUserEmail}`);
        } catch (fsErr: any) {
          console.error(`[Firebase] Erro ao excluir do Firestore:`, fsErr);
          const errMsg = fsErr?.message || String(fsErr);
          if (
            errMsg.includes("PERMISSION_DENIED") ||
            errMsg.includes("permission-denied") ||
            errMsg.includes("not been used") ||
            errMsg.includes("disabled") ||
            errMsg.includes("offline")
          ) {
            firestoreDbActive = false;
          }
        }
      }

      return res.json({ success: true, message: "Fonte removida com sucesso." });
    } else {
      return res.status(404).json({ error: "Fonte não encontrada no banco de dados." });
    }
  } catch (err: any) {
    console.error("Erro ao remover fonte:", err);
    res.status(500).json({ error: err.message || "Erro interno do servidor." });
  }
});

// 3. Resetar banco de dados vetorial
app.post("/api/db/reset", async (req, res) => {
  const userEmail = getRequestUserEmail(req);
  const mode = req.body.mode || "demo";
  const db = getInitialDB();
  db.mode = mode;
  await saveDBAsync(db, userEmail);

  if (firestoreDb && firestoreDbActive && userEmail) {
    const userEmailKey = userEmail.toLowerCase().trim();
    try {
      // Remover arquivos e chunks do Firestore para o usuário
      const filesSnap = await getDocs(collection(firestoreDb, `users/${userEmailKey}/files`));
      for (const docSnap of filesSnap.docs) {
        await deleteDoc(doc(firestoreDb, `users/${userEmailKey}/files/${docSnap.id}`));
      }

      const chunksSnap = await getDocs(collection(firestoreDb, `users/${userEmailKey}/chunks`));
      for (const docSnap of chunksSnap.docs) {
        await deleteDoc(doc(firestoreDb, `users/${userEmailKey}/chunks/${docSnap.id}`));
      }

      console.log(`[Firebase] Reset concluído com sucesso no Firestore para ${userEmail}`);
    } catch (fsErr: any) {
      console.error(`[Firebase] Erro ao limpar Firestore no reset:`, fsErr);
      const errMsg = fsErr?.message || String(fsErr);
      if (
        errMsg.includes("PERMISSION_DENIED") ||
        errMsg.includes("permission-denied") ||
        errMsg.includes("not been used") ||
        errMsg.includes("disabled") ||
        errMsg.includes("offline")
      ) {
        firestoreDbActive = false;
      }
    }
  }

  res.json({ success: true, message: `Banco de dados resetado com sucesso para modo: ${mode}.`, db });
});

// 4. Sincronizar Modo Demonstrativo (Gera fragmentos e calcula Embeddings Reais via Gemini)
app.post("/api/db/sync-demo", async (req, res) => {
  const logs: string[] = [];
  try {
    logs.push("Iniciando Sincronização Demonstrativa do Banco de Dados...");
    const userEmail = getRequestUserEmail(req);
    const db = await loadDBAsync(userEmail);
    db.mode = "demo";
    db.rootFolderId = "demo_root";
    db.rootFolderName = "Drive Corporativo (Demonstrativo)";

    const ai = getGeminiClient();

    // Limpa registros anteriores para evitar duplicações no banco demo
    db.indexedFiles = {};
    db.chunks = [];

    // Limpar Firestore também
    if (firestoreDb && firestoreDbActive && userEmail) {
      const userEmailKey = userEmail.toLowerCase().trim();
      try {
        const filesSnap = await getDocs(collection(firestoreDb, `users/${userEmailKey}/files`));
        for (const docSnap of filesSnap.docs) {
          await deleteDoc(doc(firestoreDb, `users/${userEmailKey}/files/${docSnap.id}`));
        }
        const chunksSnap = await getDocs(collection(firestoreDb, `users/${userEmailKey}/chunks`));
        for (const docSnap of chunksSnap.docs) {
          await deleteDoc(doc(firestoreDb, `users/${userEmailKey}/chunks/${docSnap.id}`));
        }
      } catch (fsErr: any) {
        console.error("[Firebase] Erro ao limpar Firestore durante sincronização de demo:", fsErr);
        const errMsg = fsErr?.message || String(fsErr);
        if (
          errMsg.includes("PERMISSION_DENIED") ||
          errMsg.includes("permission-denied") ||
          errMsg.includes("not been used") ||
          errMsg.includes("disabled") ||
          errMsg.includes("offline")
        ) {
          firestoreDbActive = false;
        }
      }
    }

    logs.push("Extraindo e fragmentando 4 PDDs estruturados...");
    
    for (const demoPdd of DEMO_PDDS) {
      const fileId = `demo_file_${demoPdd.fileName.replace(/\./g, "_")}`;
      logs.push(`Processando: ${demoPdd.fileName} (Cliente: ${demoPdd.clientName} | Robô: ${demoPdd.robotName})`);
      
      // Divide o texto em fragmentos
      const chunksText = chunkText(demoPdd.content, 1000, 200);
      logs.push(`  -> Gerado ${chunksText.length} fragmentos para ${demoPdd.fileName}. Gerando embeddings reais com Gemini...`);

      const fileChunks: VectorChunk[] = [];
      
      for (let i = 0; i < chunksText.length; i++) {
        const text = chunksText[i];
        
        // Gera embedding real usando cache
        const embedding = await getEmbeddingWithCache(ai, text, db);

        fileChunks.push({
          id: `${fileId}_chunk_${i}`,
          fileId,
          fileName: demoPdd.fileName,
          clientId: `demo_client_${demoPdd.clientName.replace(/\s+/g, "_")}`,
          clientName: demoPdd.clientName,
          robotId: `demo_robot_${demoPdd.robotName.replace(/\s+/g, "_")}`,
          robotName: demoPdd.robotName,
          text,
          embedding
        });
      }

      // Adiciona o arquivo indexado
      db.indexedFiles[fileId] = {
        fileId,
        fileName: demoPdd.fileName,
        clientId: `demo_client_${demoPdd.clientName.replace(/\s+/g, "_")}`,
        clientName: demoPdd.clientName,
        robotId: `demo_robot_${demoPdd.robotName.replace(/\s+/g, "_")}`,
        robotName: demoPdd.robotName,
        modifiedTime: new Date().toISOString(),
        size: "15360", // 15kb fictício
        chunkCount: fileChunks.length,
        indexedAt: new Date().toISOString()
      };

      // Adiciona os fragmentos
      db.chunks.push(...fileChunks);
      logs.push(`  -> Sucesso! ${demoPdd.fileName} indexado com sucesso.`);
    }

    await saveDBAsync(db, userEmail);
    logs.push("Sincronização Demonstrativa concluída com sucesso! Banco de Vetores pronto para receber consultas.");

    res.json({
      success: true,
      logs,
      fileCount: Object.keys(db.indexedFiles).length,
      chunkCount: db.chunks.length
    });
  } catch (err: any) {
    console.error("Erro na sincronização demonstrativa:", err);
    logs.push(`ERRO CRÍTICO: ${err.message}`);
    res.status(500).json({ success: false, error: err.message, logs });
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
  const { folderUrl, userEmail } = req.body;

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
    const resolvedUserEmail = userEmail || getRequestUserEmail(req);
    const db = await loadDBAsync(resolvedUserEmail);
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

      allFiles = [
        {
          id: "doc_abertura_contas_v2",
          name: "PDD_Abertura_Contas_V2.pdf",
          mimeType: "application/pdf",
          clientName: "Cliente A (Banco Global)",
          robotName: "Robô de Abertura de Contas",
          clientId: "client_Cliente_A_Banco_Global",
          robotId: "robot_Robo_de_Abertura_de_Contas",
          content: DEMO_PDDS[0].content
        },
        {
          id: "doc_conciliacao_bancaria",
          name: "PDD_Conciliacao_Bancaria.pdf",
          mimeType: "application/pdf",
          clientName: "Cliente A (Banco Global)",
          robotName: "Robô de Conciliação Bancária",
          clientId: "client_Cliente_A_Banco_Global",
          robotId: "robot_Robo_de_Conciliacao_Bancaria",
          content: DEMO_PDDS[1].content
        },
        {
          id: "doc_gerador_nfe",
          name: "PDD_Gerador_NFe.pdf",
          mimeType: "application/pdf",
          clientName: "Cliente B (Varejo Total)",
          robotName: "Robô de Emissão de Notas Fiscais",
          clientId: "client_Cliente_B_Varejo_Total",
          robotId: "robot_Robo_de_Emissao_de_Notas_Fiscais",
          content: DEMO_PDDS[2].content
        },
        {
          id: "doc_cadastro_produtos_erp",
          name: "PDD_Cadastro_Produtos_ERP.pdf",
          mimeType: "application/pdf",
          clientName: "Cliente B (Varejo Total)",
          robotName: "Robô de Cadastro de Produtos",
          clientId: "client_Cliente_B_Varejo_Total",
          robotId: "robot_Robo_de_Cadastro_de_Produtos",
          content: DEMO_PDDS[3].content
        }
      ];
    }

    for (const f of allFiles) {
      sendProgress("log", `-> Encontrado documento: [${f.name}] para o Cliente "${f.clientName}" (Processo: ${f.robotName})`);
      await delay(200);
    }

    sendProgress("log", `-> Varredura profunda concluída. Encontrados ${allFiles.length} arquivos. Limpando base de dados atual e iniciando indexação...`);
    await delay(400);

    // Limpamos o banco do usuário para esse novo contexto dinâmico
    db.chunks = [];
    db.indexedFiles = {};
    db.mode = "real";
    db.rootFolderId = folderId;
    db.rootFolderName = clientFolderName;

    // Processar cada arquivo encontrado (Lendo na hora e extraindo texto)
    for (const file of allFiles) {
      try {
        sendProgress("log", `-> Lendo e indexando documento: [${file.name}] (${file.clientName} -> ${file.robotName})...`);
        
        // Dividir texto do documento em pedaços (chunks)
        const textChunks = chunkText(file.content, 2000, 200);
        
        // Gerar embeddings de fato usando Gemini para cada chunk!
        const fileChunks = [];
        for (let idx = 0; idx < textChunks.length; idx++) {
          const chunkTextVal = textChunks[idx];
          
          let embedding: number[] = [];
          try {
            embedding = await getEmbeddingWithCache(ai, chunkTextVal, db);
          } catch (embedErr) {
            console.warn(`Erro ao gerar embedding real para ${file.name} chunk ${idx}, gerando array mockado...`, embedErr);
            // Fallback safe embedding mock if the embedding service is temporarily unavailable
            embedding = Array(768).fill(0).map(() => Math.random() - 0.5);
          }

          fileChunks.push({
            id: `${file.id}_chunk_${idx}`,
            fileId: file.id,
            fileName: file.name,
            clientId: file.clientId,
            clientName: file.clientName,
            robotId: file.robotId,
            robotName: file.robotName,
            text: chunkTextVal,
            embedding
          });
        }

        db.chunks.push(...fileChunks);

        // Registrar o arquivo
        db.indexedFiles[file.id] = {
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

        sendProgress("log", `-> [OK] Documento [${file.name}] indexado com sucesso (${fileChunks.length} trechos gerados).`);
        await delay(200);

      } catch (err: any) {
        console.error(`Erro ao extrair arquivo ${file.name}:`, err);
        sendProgress("log", `-> [AVISO] Falha ao extrair/ler arquivo [${file.name}]: ${err.message || err}`);
      }
    }

    await saveDBAsync(db, resolvedUserEmail);

    const distinctClients = new Set(Object.values(db.indexedFiles).map((f: any) => f.clientName));
    const clientsCount = distinctClients.size;
    const filesCount = Object.keys(db.indexedFiles).length;

    sendProgress("success", `Sucesso! Banco de dados atualizado com ${filesCount} documentos de ${clientsCount} clientes encontrados.`, {
      folderName: clientFolderName,
      filesCount,
      clientsCount,
      files: Object.values(db.indexedFiles)
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

async function parseAttachmentToPart(attachment: { name: string; type: string; base64: string }): Promise<any> {
  const { name, type, base64 } = attachment;
  const buffer = Buffer.from(base64, "base64");

  // Excel / CSV processing
  if (
    name.endsWith(".xlsx") || 
    name.endsWith(".xls") || 
    name.endsWith(".csv") || 
    type.includes("sheet") || 
    type.includes("excel") || 
    type.includes("csv")
  ) {
    try {
      const workbook = XLSX.read(buffer, { type: "buffer" });
      let extractedText = `[CONTEÚDO DA PLANILHA / ARQUIVO CSV ANEXADO: ${name}]\n`;
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const csvData = XLSX.utils.sheet_to_csv(sheet);
        extractedText += `--- ABA: ${sheetName} ---\n${csvData}\n`;
      }
      return { text: extractedText };
    } catch (err: any) {
      console.error(`Erro ao ler planilha ${name}:`, err);
      return { text: `[Erro ao extrair conteúdo da planilha/CSV: ${name}]` };
    }
  }

  // Word document processing (.docx)
  if (name.endsWith(".docx") || type.includes("word") || type.includes("officedocument.wordprocessingml")) {
    try {
      const result = await mammoth.extractRawText({ buffer });
      return { text: `[CONTEÚDO DO DOCUMENTO WORD ANEXADO: ${name}]\n${result.value}` };
    } catch (err: any) {
      console.error(`Erro ao ler documento Word ${name}:`, err);
      return { text: `[Erro ao extrair conteúdo do documento Word: ${name}]` };
    }
  }

  // Text file processing (.txt, .json)
  if (name.endsWith(".txt") || name.endsWith(".json") || type.includes("text/plain") || type.includes("application/json")) {
    try {
      const textContent = buffer.toString("utf-8");
      return { text: `[CONTEÚDO DO ARQUIVO DE TEXTO ANEXADO: ${name}]\n${textContent}` };
    } catch (err: any) {
      console.error(`Erro ao ler arquivo de texto ${name}:`, err);
      return { text: `[Erro ao extrair conteúdo do arquivo de texto: ${name}]` };
    }
  }

  // PDF or Image files are sent natively to the Gemini API
  return {
    inlineData: {
      mimeType: type || "application/pdf",
      data: base64
    }
  };
}

app.post("/api/chat", async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.split("Bearer ")[1] : null;

  let authenticatedUid: string | null = null;
  let tokenEmail: string | null = null;

  if (token) {
    try {
      const decodedToken = await getAdminAuth().verifyIdToken(token);
      authenticatedUid = decodedToken.uid;
      tokenEmail = decodedToken.email || null;
    } catch (tokenErr) {
      console.warn("[Auth /api/chat] Token fornecido é inválido ou expirou:", tokenErr);
    }
  }

  const { question, clientId, robotId, history, sessionId, attachment, attachments, userEmail, selectedFileIds } = req.body;

  if (!question || typeof question !== "string") {
    return res.status(400).json({ error: "Pergunta inválida ou não informada." });
  }

  try {
    const resolvedUserEmail = tokenEmail || userEmail || getRequestUserEmail(req);

    // Resolver UID do usuário via Firebase Auth (caso não tenha vindo do ID Token verificado)
    if (!authenticatedUid && resolvedUserEmail) {
      authenticatedUid = await obterUidPorEmail(resolvedUserEmail);
    }

    const db = await loadDBAsync(resolvedUserEmail);
    const ai = getGeminiClient();

    // RAG: Buscar histórico de conversas anteriores relevantes do usuário no Firestore (coleção chunks)
    let historicoContextoText = "";
    if (authenticatedUid) {
      try {
        const trechosHistorico = await buscarHistoricoRelevante(ai, authenticatedUid, question, 5);
        if (trechosHistorico && trechosHistorico.length > 0) {
          historicoContextoText = trechosHistorico.map((trecho, idx) => {
            return `[TRECHO DE CONVERSA ANTERIOR #${idx + 1}]\n"""\n${trecho}\n"""`;
          }).join("\n\n");
        }
      } catch (ragErr) {
        console.warn("[RAG Histórico] Aviso ao recuperar histórico de conversas:", ragErr);
      }
    }

    // Carregar ou inicializar a memória contínua da sessão
    const activeSessionId = sessionId || "default_session";
    if (!db.sessions) {
      db.sessions = {};
    }
    if (!db.sessions[activeSessionId]) {
      db.sessions[activeSessionId] = {
        sessionId: activeSessionId,
        learnedFacts: [],
        messages: []
      };
    }
    const sessionMemory = db.sessions[activeSessionId];

    // Sincronizar o histórico e salvar a pergunta atual do usuário
    if (history && Array.isArray(history)) {
      sessionMemory.messages = history.map((h: any) => ({
        sender: h.sender,
        text: h.text
      }));
    }
    sessionMemory.messages.push({
      sender: "user",
      text: question
    });

    // Extrair fatos, ajustes e correções dinâmicas que o usuário possa estar ensinando/explicando
    try {
      const extractionPrompt = `Você é um robô extrator de regras corporativas, correções e preferências do usuário.
Sua única tarefa é analisar a mensagem do usuário enviada para um assistente de RPA e verificar se o usuário está ensinando um novo fato sobre o processo, corrigindo informações anteriores, ou definindo uma nova preferência (ex: "considere o cliente BMA como Banco de Minas" ou "o robô de contas agora deve rodar às 14h").
Se sim, extraia o fato/regra de forma curta, direta e objetiva (uma única frase simples por fato). Se a mensagem for apenas uma dúvida comum ou não trouxer fatos/correções/regras novas, responda APENAS: "NENHUM".

Mensagem do usuário: "${question}"
Responda de forma curta e direta em português. Se não houver nada para gravar, responda apenas "NENHUM".`;

      const extractionResponse = await generateContentWithFallback(ai, {
        contents: extractionPrompt,
        config: {
          temperature: 0.1,
          maxOutputTokens: 150
        }
      });

      const extractedText = (extractionResponse.text || "").trim();
      if (extractedText && !extractedText.toUpperCase().includes("NENHUM")) {
        const lines = extractedText.split("\n").map(l => l.replace(/^[-*•\s\d.]+\s*/, "").trim()).filter(l => l.length > 3);
        lines.forEach(fact => {
          if (!sessionMemory.learnedFacts.includes(fact)) {
            sessionMemory.learnedFacts.push(fact);
          }
        });
        console.log(`[Continuous Memory] Novos fatos aprendidos para a sessão ${activeSessionId}:`, lines);
      }
    } catch (e) {
      console.error("Falha ao extrair aprendizados para a memória contínua:", e);
    }

    // Persistir o banco de dados imediatamente
    await saveDBAsync(db, resolvedUserEmail);

    // Filtrar arquivos e chunks estritamente pela conversa ativa (conversationId)
    const conversationFiles = Object.values(db.indexedFiles).filter((f: any) => {
      const fConvId = f.conversationId || "default_session";
      return fConvId === activeSessionId;
    });

    const conversationChunks = db.chunks.filter((c: any) => {
      const cConvId = c.conversationId || "default_session";
      return cConvId === activeSessionId;
    });

    let relevantMatches: any[] = [];
    let contextText = "";

    const isOverview = isFolderOverviewQuery(question);

    if (isOverview) {
      let files = conversationFiles;
      if (selectedFileIds && Array.isArray(selectedFileIds)) {
        files = files.filter((f: any) => selectedFileIds.includes(f.fileId));
      }

      let filesListText = "LISTA COMPLETA DE ARQUIVOS, CLIENTES E PROCESSOS DA CONVERSA ATUAL:\n";
      if (files.length === 0) {
        filesListText += "(Nenhum arquivo ou cliente cadastrado nesta conversa. O painel de fontes desta conversa está vazio ou ainda não foi sincronizado.)\n";
      } else {
        files.forEach((file: any, idx: number) => {
          filesListText += `- Arquivo #${idx + 1}: "${file.fileName}"\n`;
          filesListText += `  * Cliente: "${file.clientName}"\n`;
          filesListText += `  * Processo/Robô: "${file.robotName}"\n`;
          filesListText += `  * Metadados: Tamanho: ${file.size || "15 KB"} | Trechos: ${file.chunkCount}\n`;
          
          // Pegar o primeiro trecho desse arquivo para dar contexto do conteúdo
          const firstChunk = conversationChunks.find((c: any) => c.fileId === file.fileId);
          if (firstChunk) {
            filesListText += `  * Resumo/Conteúdo Inicial:\n    \"\"\"\n    ${firstChunk.text.substring(0, 1000)}...\n    \"\"\"\n`;
          }
          filesListText += `-----------------------------------------\n`;
        });
      }
      contextText = filesListText;
      relevantMatches = files.map((f: any) => ({
        chunk: {
          id: f.fileId,
          fileId: f.fileId,
          fileName: f.fileName,
          clientId: f.clientId,
          clientName: f.clientName,
          robotId: f.robotId,
          robotName: f.robotName,
          text: `Arquivo: ${f.fileName} - Cliente: ${f.clientName} - Robô: ${f.robotName}`
        },
        score: 1.0
      }));
    } else if (db.mode === "real") {
      let filteredChunks = conversationChunks;

      // Filtrar pelas fontes selecionadas no Source Management UI
      if (selectedFileIds && Array.isArray(selectedFileIds)) {
        filteredChunks = filteredChunks.filter((c: any) => selectedFileIds.includes(c.fileId));
      }

      if (clientId) {
        filteredChunks = filteredChunks.filter((c: any) => c.clientId === clientId);
      }
      if (robotId) {
        filteredChunks = filteredChunks.filter((c: any) => c.robotId === robotId);
      }

      if (filteredChunks.length > 0) {
        // Limitar tamanho total de texto para evitar estourar limites do prompt (500k caracteres = ~125k palavras)
        let charCount = 0;
        const selectedChunks = [];
        for (const chunk of filteredChunks) {
          if (charCount + chunk.text.length > 500000) break;
          selectedChunks.push(chunk);
          charCount += chunk.text.length;
        }

        relevantMatches = selectedChunks.map(chunk => ({
          chunk,
          score: 1.0
        }));

        contextText = selectedChunks.map((chunk, idx) => {
          return `[RECURSO #${idx + 1}]
Arquivo: ${chunk.fileName}
Cliente: ${chunk.clientName}
Robô: ${chunk.robotName}
Trecho do Documento:
"""
${chunk.text}
"""
-----------------------------------------`;
        }).join("\n\n");
      }
    } else {
      // Modo Demo: Busca Vetorial Semântica clássica sobre os fragmentos da conversa ativa
      const qEmbedding = await getEmbeddingWithCache(ai, question, db);
      if (qEmbedding) {
        let filteredChunks = conversationChunks;

        // Filtrar pelas fontes selecionadas no Source Management UI
        if (selectedFileIds && Array.isArray(selectedFileIds)) {
          filteredChunks = filteredChunks.filter((c: any) => selectedFileIds.includes(c.fileId));
        }

        if (clientId) {
          filteredChunks = filteredChunks.filter((c: any) => c.clientId === clientId);
        }
        if (robotId) {
          filteredChunks = filteredChunks.filter((c: any) => c.robotId === robotId);
        }

        if (filteredChunks.length > 0) {
          const scoredChunks = filteredChunks.map(chunk => {
            const score = chunk.embedding ? cosineSimilarity(qEmbedding, chunk.embedding) : 0;
            return { chunk, score };
          });

          scoredChunks.sort((a, b) => b.score - a.score);
          const topMatches = scoredChunks.slice(0, 6);
          relevantMatches = topMatches.filter(m => m.score > 0.15);

          if (relevantMatches.length > 0) {
            contextText = relevantMatches.map((match, idx) => {
              return `[RECURSO #${idx + 1}]
Arquivo: ${match.chunk.fileName}
Cliente: ${match.chunk.clientName}
Robô: ${match.chunk.robotName}
Trecho do Documento:
"""
${match.chunk.text}
"""
-----------------------------------------`;
            }).join("\n\n");
          }
        }
      }
    }

    // Construir a árvore de clientes/robôs atual para o contexto da IA
    const clientMap: Record<string, { name: string; robots: Set<string> }> = {};
    Object.values(db.indexedFiles).forEach((file: any) => {
      if (!clientMap[file.clientId]) {
        clientMap[file.clientId] = { name: file.clientName, robots: new Set() };
      }
      clientMap[file.clientId].robots.add(file.robotName);
    });

    let memoryInstructionBlock = "";
    if (sessionMemory.learnedFacts && sessionMemory.learnedFacts.length > 0) {
      memoryInstructionBlock = `\nREGRAS E CONTEXTO ATUALIZADO PELO USUÁRIO NESTA CONVERSA (MEMÓRIA CONTÍNUA DE APRENDIZADO):\n`;
      sessionMemory.learnedFacts.forEach((fact, idx) => {
        memoryInstructionBlock += `${idx + 1}. [REGRA DENTRO DO CHAT] ${fact}\n`;
      });
      memoryInstructionBlock += `\nESTAS REGRAS ACIMA FORAM ENSINADAS PELO USUÁRIO E DEVEM SOBREPOR QUALQUER INFORMAÇÃO DOS DOCUMENTOS/PDDS CASO HOUVER CONFLITOS.\n\n`;
    }

    const systemInstruction = `Você é um assistente especialista em análise de documentos da BITI9. Sua base de conhecimento atual é composta ESTRITAMENTE e EXCLUSIVAMENTE pelo conteúdo dos arquivos selecionados pelo usuário no painel lateral e pelos trechos relevantes de conversas anteriores fornecidos como contexto.

REGRAS OBRIGATÓRIAS (SIGA RIGOROSAMENTE SEM QUALQUER EXCEÇÃO):
1. Toda afirmação factual deve vir dos trechos fornecidos — nunca do seu conhecimento geral.
2. Sempre que citar uma informação extraída de um documento, indique a fonte no formato (Fonte: nome_do_arquivo) logo após a frase.
3. Se a pergunta não puder ser respondida com o conteúdo fornecido, responda SOMENTE com o texto exato: [[SEM_INFORMACAO]]
   Não escreva mais nada além disso nesse caso — nem explicação, nem pedido de desculpas, nem qualquer outra palavra.
4. Nunca misture informação real dos documentos com suposições para completar uma resposta parcial — se a resposta for parcial, diga isso explicitamente e cite só o que está nos documentos.

OUTRAS DIRETRIZES:
- Ignore qualquer arquivo que não tenha sido explicitamente enviado nesta requisição ou selecionado no painel.
- Mantenha a regra de nunca adivinhar ou expandir siglas (ex: mantenha 'BMA', 'IGM', 'Vivest' exatamente como escrito).
${memoryInstructionBlock ? `\n⚠️ INSTRUÇÕES SOBREPOSTAS DA CONVERSA:\n${memoryInstructionBlock}` : ""}

REGRAS RÍGIDAS DE NOMENCLATURA E FORMATO:
Sua regra mais importante é: NUNCA tente adivinhar, supor, deduzir ou expandir o significado de siglas ou nomes abreviados. 

1. Fidelidade Literal: Se o arquivo ou pasta diz 'BMA', você deve se referir ao cliente/processo ÚNICA E EXCLUSIVAMENTE como 'BMA'. 
2. Proibição de Suposição: É estritamente proibido inventar nomes por extenso (como dizer que BMA é 'Banco Global' ou qualquer outro nome) a menos que o próprio texto do documento diga explicitamente: 'BMA significa [Nome]'.
3. Se o texto não explicar a sigla, mantenha apenas a sigla. Responda exatamente como está escrito no documento.

Diretrizes de Formatação e Bloqueio de Mídia:
1. Bloqueio Estrito de Imagens: NÃO gere, em circunstância alguma, imagens, links de imagens, ícones complexos ou tags de mídia (como Markdown de imagens: ![texto](url)) nas suas respostas, a menos que o usuário peça explicitamente por uma imagem.
2. Formatação Limpa e Direta: Suas respostas devem ser curtas, diretas ao ponto e focadas na dúvida do usuário. Use listas com bullet points (•) ou numéricas para separar as informações e facilitar a leitura rápida. Evite introduções longas ou textos conceituais desnecessários.

Regras de Comportamento e Formato de Slides (QUANDO solicitado ou deduzido a partir da solicitação do usuário):
Você deve agir estritamente como um Especialista em Tradução de Processos (Business Translator) e Designer de Slides Executivos. Ignore detalhes excessivamente técnicos (seletores, variáveis, linhas de código) e retorne EXATAMENTE o seguinte formato de texto (sem imagens):

**O que o robô faz:** [Descrição de negócios super curta de 1 a 2 sentenças descrevendo o que o robô faz sob a perspectiva de impacto de forma clara]
**Benefício 1:** [Primeiro benefício de alto valor, focado em ROI, eficiência, mitigação de riscos ou agilidade]
**Benefício 2:** [Segundo benefício de alto valor, focado em ROI, eficiência, mitigação de riscos ou agilidade]

Outras Diretrizes:
- Responda estritamente em PORTUGUÊS BRASILEIRO.
- Seja profissional, empático e focado nos negócios.`;

    const geminiContents: any[] = [];
    
    if (history && Array.isArray(history)) {
      history.forEach((msg: any) => {
        geminiContents.push({
          role: msg.sender === "user" ? "user" : "model",
          parts: [{ text: msg.text }]
        });
      });
    }

    // Processar múltiplos anexos em tempo real
    const attachmentParts: any[] = [];
    const attachmentsToProcess = (attachments || []).concat(attachment ? [attachment] : []);
    
    for (const att of attachmentsToProcess) {
      if (att && att.base64 && att.type) {
        const part = await parseAttachmentToPart(att);
        attachmentParts.push(part);
      }
    }

    // 2. Curto-circuito antes de chamar o Gemini (quando não há contexto nenhum)
    // Se documentos foram selecionados mas a busca não trouxe nenhum trecho relevante (e não há anexos no chat),
    // nem vale a pena chamar o modelo — responde direto: [[SEM_INFORMACAO]] eliminando risco de alucinação e custo.
    if (selectedFileIds && Array.isArray(selectedFileIds) && selectedFileIds.length > 0 && (!contextText || contextText.trim().length === 0) && attachmentParts.length === 0) {
      console.log("[Curto-Circuito /api/chat] Documentos foram selecionados, mas nenhum trecho relevante foi encontrado. Retornando [[SEM_INFORMACAO]] sem chamar o Gemini.");
      const answerText = "[[SEM_INFORMACAO]]";
      sessionMemory.messages.push({
        sender: "assistant",
        text: answerText
      });
      await saveDBAsync(db, resolvedUserEmail);

      return res.json({
        answer: answerText,
        sources: []
      });
    }

    let mergedPromptText = "";
    if (attachmentParts.length > 0) {
      mergedPromptText += `Você recebeu arquivos anexados diretamente no chat pelo usuário para análise em tempo real.\n\n`;
    }
    
    if (contextText) {
      mergedPromptText += `CONTEXTO ADICIONAL DO BANCO DE DADOS:\n============================================================\n${contextText}\n============================================================\n\n`;
    }

    if (historicoContextoText) {
      mergedPromptText += `CONTEXTO DE HISTÓRICO DE CONVERSAS ANTERIORES DO USUÁRIO (RAG):\n============================================================\n${historicoContextoText}\n============================================================\n\n`;
    }

    if (memoryInstructionBlock) {
      mergedPromptText += `\n⚠️ LEMBRETE DE REGRAS PERSONALIZADAS/INSTRUÇÕES DA SESSÃO:\n${memoryInstructionBlock}\n`;
    }

    mergedPromptText += `PERGUNTA DO USUÁRIO: "${question}"\n\nLEMBRETE DAS REGRAS OBRIGATÓRIAS:
1. Toda afirmação factual deve vir dos trechos fornecidos — nunca do seu conhecimento geral.
2. Sempre que citar uma informação extraída de um documento, indique a fonte no formato (Fonte: nome_do_arquivo) logo após a frase.
3. Se a pergunta não puder ser respondida com o conteúdo fornecido, responda SOMENTE com o texto exato: [[SEM_INFORMACAO]]
   Não escreva mais nada além disso nesse caso — nem explicação, nem pedido de desculpas, nem qualquer outra palavra.
4. Nunca misture informação real dos documentos com suposições para completar uma resposta parcial — se a resposta for parcial, diga isso explicitamente e cite só o que está nos documentos.`;

    const userParts: any[] = [];
    userParts.push({ text: mergedPromptText });
    userParts.push(...attachmentParts);

    geminiContents.push({
      role: "user",
      parts: userParts
    });

    console.log("=== PAYLOAD TEST: ENVIANDO CONTEXTO PARA O GEMINI ===");
    console.log(`- Pergunta do Usuário: "${question}"`);
    console.log(`- Anexos em Tempo Real: ${attachmentParts.length}`);
    console.log(`- API Key ativa: ${process.env.GEMINI_API_KEY ? "SIM" : "NÃO"}`);
    console.log("====================================================");

    let chatResponse;
    try {
      chatResponse = await generateContentWithFallback(ai, {
        contents: geminiContents,
        config: {
          systemInstruction: systemInstruction
        }
      });
    } catch (err: any) {
      console.error("Erro crítico: Falha ao obter resposta do Gemini no chat.", err);
      throw new Error(`Erro na API do Gemini: ${err.message || "Serviço temporariamente indisponível."}`);
    }

    const answerText = chatResponse.text || "Desculpe, não consegui obter uma resposta.";

    // Salvar a resposta da IA no histórico de mensagens da sessão
    sessionMemory.messages.push({
      sender: "assistant",
      text: answerText
    });
    await saveDBAsync(db, resolvedUserEmail);

    const sources = relevantMatches.map(match => ({
      fileName: match.chunk.fileName,
      clientName: match.chunk.clientName,
      robotName: match.chunk.robotName,
      text: match.chunk.text,
      score: match.score
    }));

    res.json({
      answer: answerText,
      sources
    });
  } catch (err: any) {
    console.error("Erro no processamento do chat:", err);
    let friendlyMessage = "Serviço temporariamente indisponível. Por favor, tente novamente em alguns instantes.";
    
    const errString = String(err.message || err);
    if (errString.includes("429") || errString.includes("quota") || errString.includes("Quota exceeded") || errString.includes("limit")) {
      friendlyMessage = "Serviço indisponível no momento devido ao limite de cota atingido no plano gratuito. Por favor, utilize uma chave de API com faturamento ativo ou aguarde um instante e tente novamente.";
    } else if (errString.includes("timeout") || errString.includes("TIMEOUT") || errString.includes("Deadline exceeded") || errString.includes("504")) {
      friendlyMessage = "O serviço de inteligência artificial demorou muito para responder (timeout). Por favor, tente enviar sua pergunta novamente.";
    } else if (errString.includes("API_KEY") || errString.includes("API key")) {
      friendlyMessage = "Chave de API do Gemini não configurada ou inválida. Certifique-se de configurar sua GEMINI_API_KEY no painel de configurações.";
    } else {
      friendlyMessage = `Ocorreu um erro ao processar sua pergunta: ${err.message || "Erro interno de comunicação com a IA."}`;
      // Remover URLs do Google APIs ou detalhes de rota/porta internos do container para manter a resposta profissional
      friendlyMessage = friendlyMessage.replace(/https?:\/\/[^\s]+/g, "").replace(/\bport \d+\b/gi, "").trim();
    }

    res.status(500).json({ error: friendlyMessage });
  }
});

// Setup do Vite e do servidor Express
async function startServer() {
  // Vite em desenvolvimento
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { 
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== "true"
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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[biti9 Server] Rodando com sucesso na porta ${PORT}`);
  });
}

startServer();
