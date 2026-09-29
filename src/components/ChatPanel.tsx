import React, { useState, useEffect, useRef } from "react";
import { Send, Sparkles, RefreshCw, FileText, Bot, User, CheckCircle, XCircle, ChevronDown, HelpCircle, ArrowRight, Plus, MessageSquare, Trash2, Database, Layers, Paperclip, X, AlertCircle, History, Clock, Pencil, Check, Download, Cloud, Lock, ShieldCheck } from "lucide-react";
import { ChatMessage, ClientGroup, ChatSession } from "../types";
import { auth } from "../firebase";
import { 
  salvarSessaoFirestore, 
  carregarSessoesFirestore, 
  excluirSessaoFirestore, 
  renomearSessaoFirestore 
} from "../services/conversas";
import { gerarBlobPDF } from "../services/consultas";
import { apiFetch } from "../services/api";

interface ChatPanelProps {
  selectedClientId: string;
  selectedRobotId: string;
  clientGroups: ClientGroup[];
  onResetFilters: () => void;
  onOpenSidebar?: () => void;
  userEmail?: string;
  token?: string | null;
  onRefresh?: () => void;
  selectedFileIds?: string[];
  activeSessionId?: string;
  onSessionChange?: (newSessionId: string) => void;
  onNewSession?: () => void;
  showSources?: boolean;
  onToggleSources?: () => void;
  triggerNewSession?: number;
  triggerOpenHistory?: number;
  userId?: string;
}

const QUICK_PROMPTS = [
  "Quais são todos os robôs do Cliente A?",
  "Como funciona o fluxo do Robô de Abertura de Contas?",
  "O que o robô faz em caso de divergência de conciliação bancária?",
  "Quais sites ou sistemas o emissor de notas fiscais acessa?"
];

const WELCOME_FULL_TEXT = "Olá,! sou o **Robbi9**, assistente de consultas da **Biti9**\n\nFui treinado para analisar os seus **Process Design Documents (PDDs)** e planilhas/documentos **T2R**.\n\nComo posso ajudar você hoje?";

function normalizeWelcomeInSessions(sessList: ChatSession[]): ChatSession[] {
  return sessList.map(s => ({
    ...s,
    messages: (s.messages || []).map(m => {
      if (m.sender === "assistant" && (
        m.id === "welcome" ||
        m.id.startsWith("welcome") ||
        m.text?.toLowerCase().includes("assistente de consultas") ||
        m.text?.toLowerCase().includes("robbi9") ||
        m.text?.toLowerCase().includes("especialista em rpa")
      )) {
        return {
          ...m,
          text: WELCOME_FULL_TEXT
        };
      }
      return m;
    })
  }));
}

// Helper para criar uma sessão inicial com saudação limpa
function createInitialSession(uid?: string): ChatSession {
  return {
    id: `session_${Date.now()}`,
    title: "Dúvidas Gerais de PDDs",
    messages: [
      {
        id: "welcome",
        sender: "assistant",
        text: WELCOME_FULL_TEXT,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }
    ],
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };
}

export default function ChatPanel({
  selectedClientId,
  selectedRobotId,
  clientGroups,
  onResetFilters,
  onOpenSidebar,
  userEmail,
  token,
  onRefresh,
  selectedFileIds = [],
  activeSessionId: propActiveSessionId,
  onSessionChange,
  onNewSession,
  showSources,
  onToggleSources,
  triggerNewSession,
  triggerOpenHistory,
  userId
}: ChatPanelProps) {
  // Chaves de isolamento local por usuário (garante que um usuário nunca veja as conversas de outro no navegador)
  const getUserStorageKey = (uid?: string) => uid ? `biti9_chat_sessions_${uid}` : "biti9_chat_sessions_guest";
  const getUserActiveKey = (uid?: string) => uid ? `biti9_active_session_id_${uid}` : "biti9_active_session_id_guest";

  // Estado do histórico de conversas (sessões) com persistência local e em nuvem
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const storageKey = getUserStorageKey(userId);
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      } catch (e) {
        console.error("Erro ao ler sessões de chat salvas:", e);
      }
    }
    return [createInitialSession(userId)];
  });

  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    const activeKey = getUserActiveKey(userId);
    return propActiveSessionId || localStorage.getItem(activeKey) || "default_session";
  });

  // Carrega e sincroniza o histórico individual e privado do usuário ao autenticar ou trocar de usuário
  useEffect(() => {
    let isCancelled = false;
    const currentStorageKey = getUserStorageKey(userId);
    const currentActiveKey = getUserActiveKey(userId);

    // 1. Carrega imediatamente do cache local individual deste usuário (sem flash ou espera)
    const localSaved = localStorage.getItem(currentStorageKey);
    let initialUserSessions: ChatSession[] = [];
    if (localSaved) {
      try {
        const parsed = JSON.parse(localSaved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          initialUserSessions = parsed;
        }
      } catch (e) {
        console.error("Erro ao carregar sessões locais do usuário:", e);
      }
    }

    if (initialUserSessions.length > 0) {
      const normalizedInitial = normalizeWelcomeInSessions(initialUserSessions);
      setSessions(normalizedInitial);
      const savedActiveId = localStorage.getItem(currentActiveKey);
      if (savedActiveId && normalizedInitial.some(s => s.id === savedActiveId)) {
        setActiveSessionId(savedActiveId);
        if (onSessionChange) onSessionChange(savedActiveId);
      } else {
        const firstId = normalizedInitial[0].id;
        setActiveSessionId(firstId);
        if (onSessionChange) onSessionChange(firstId);
      }
    } else {
      // Cria sessão inicial limpa para o novo usuário
      const newInitSess = createInitialSession(userId);
      setSessions([newInitSess]);
      setActiveSessionId(newInitSess.id);
      if (onSessionChange) onSessionChange(newInitSess.id);
    }

    // 2. Se o usuário estiver autenticado no Firebase Auth, busca histórico privado na nuvem (Firestore)
    if (userId && auth.currentUser && auth.currentUser.uid === userId) {
      carregarSessoesFirestore(userId)
        .then((remoteSessions) => {
          if (isCancelled) return;
          if (remoteSessions && remoteSessions.length > 0) {
            const normalizedRemote = normalizeWelcomeInSessions(remoteSessions);
            setSessions(normalizedRemote);
            localStorage.setItem(currentStorageKey, JSON.stringify(normalizedRemote));

            const savedActiveId = localStorage.getItem(currentActiveKey);
            if (savedActiveId && normalizedRemote.some(s => s.id === savedActiveId)) {
              setActiveSessionId(savedActiveId);
              if (onSessionChange) onSessionChange(savedActiveId);
            } else {
              const firstId = normalizedRemote[0].id;
              setActiveSessionId(firstId);
              if (onSessionChange) onSessionChange(firstId);
            }
          }
        })
        .catch((err) => {
          console.warn("Aviso ao carregar histórico privado do Firestore:", err);
        });
    }

    return () => {
      isCancelled = true;
    };
  }, [userId]);

  // Sync prop changes if external component updates activeSessionId
  useEffect(() => {
    if (propActiveSessionId && propActiveSessionId !== activeSessionId) {
      setActiveSessionId(propActiveSessionId);
    }
  }, [propActiveSessionId]);

  // Encontra a sessão ativa
  const activeSession = sessions.find(s => s.id === activeSessionId) || sessions[0] || {
    id: "default_session",
    title: "Dúvidas Gerais de PDDs",
    messages: []
  };

  const [toast, setToast] = useState<{ show: boolean; message: string; type: "success" | "error" }>({
    show: false,
    message: "",
    type: "success"
  });

  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>("");
  const [baixandoPdfMsgId, setBaixandoPdfMsgId] = useState<string | null>(null);

  const handleBaixarPDF = (msg: ChatMessage) => {
    try {
      setBaixandoPdfMsgId(msg.id);
      const titulo = activeSession.title || "Consulta de Automação biti9";
      const blob = gerarBlobPDF(titulo, "Consulta", msg.text);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safeTitle = titulo.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 30);
      a.download = `Consulta_${safeTitle}_${Date.now()}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      console.error("Erro ao gerar PDF:", err);
      setToast({
        show: true,
        message: `Erro ao baixar PDF: ${err?.message || "Tente novamente."}`,
        type: "error"
      });
    } finally {
      setBaixandoPdfMsgId(null);
    }
  };

  const handleStartRename = (e: React.MouseEvent, sess: ChatSession) => {
    e.stopPropagation();
    setEditingSessionId(sess.id);
    setEditingTitle(sess.title);
  };

  const handleSaveRename = async (sessionId: string, e?: React.FormEvent | React.MouseEvent | React.KeyboardEvent) => {
    if (e) {
      e.stopPropagation();
      if ("preventDefault" in e) e.preventDefault();
    }

    const trimmed = editingTitle.trim();
    if (!trimmed) {
      setEditingSessionId(null);
      return;
    }

    // 1. Atualizar no estado do React e no localStorage individual do usuário
    const currentStorageKey = getUserStorageKey(userId);
    const updatedSessions = sessions.map(s => {
      if (s.id === sessionId) {
        return { ...s, title: trimmed };
      }
      return s;
    });
    setSessions(updatedSessions);
    localStorage.setItem(currentStorageKey, JSON.stringify(updatedSessions));
    setEditingSessionId(null);

    // 2. Persistir no Firestore sob a coleção privada do usuário
    if (userId) {
      renomearSessaoFirestore(userId, sessionId, trimmed).catch(err =>
        console.warn("Aviso ao renomear sessão privada no Firestore:", err)
      );
    }

    // 3. Notificar backend se necessário
    try {
      await apiFetch(`/api/conversations/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: trimmed
        })
      });
    } catch (err) {
      // Silencioso
    }
  };

  const showNotification = (message: string, type: "success" | "error") => {
    setToast({ show: true, message, type });
    setTimeout(() => {
      setToast(prev => ({ ...prev, show: false }));
    }, 6000);
  };

  const [inputText, setInputText] = useState("");
  const [loading, setLoading] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [expandedSourceKey, setExpandedSourceKey] = useState<string | null>(null);
  const [currentSources, setCurrentSources] = useState<any[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<Array<{ name: string; type: string; base64: string }>>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Persiste as sessões de conversa e a sessão ativa no escopo individual do usuário
  useEffect(() => {
    const currentStorageKey = getUserStorageKey(userId);
    localStorage.setItem(currentStorageKey, JSON.stringify(sessions));
  }, [sessions, userId]);

  useEffect(() => {
    const currentActiveKey = getUserActiveKey(userId);
    localStorage.setItem(currentActiveKey, activeSessionId);
  }, [activeSessionId, userId]);

  const messages = activeSession.messages;

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, loading]);

  // Encontra nome do filtro atual
  let filterLabel = "";
  if (selectedClientId) {
    const client = clientGroups.find(c => c.id === selectedClientId);
    if (client) {
      filterLabel = `Cliente: ${client.name}`;
      if (selectedRobotId) {
        const robot = client.robots.find(r => r.id === selectedRobotId);
        if (robot) {
          filterLabel += ` > Robô: ${robot.name}`;
        }
      }
    }
  }

  // Cria uma nova sessão de conversa individual e privada
  const handleNewSession = () => {
    const newId = `session_${Date.now()}`;
    const newSess: ChatSession = {
      id: newId,
      title: "Nova Conversa",
      messages: [
        {
          id: `welcome_${Date.now()}`,
          sender: "assistant",
          text: WELCOME_FULL_TEXT,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }
      ],
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    setSessions(prev => [newSess, ...prev]);
    setActiveSessionId(newId);
    if (onSessionChange) onSessionChange(newId);
    if (onNewSession) onNewSession();
    setExpandedSourceKey(null);
    setCurrentSources([]);

    // Persiste imediatamente no Firestore no documento do usuário autenticado
    if (userId) {
      salvarSessaoFirestore(userId, newSess).catch(err =>
        console.warn("Aviso ao salvar nova sessão privada no Firestore:", err)
      );
    }
  };

  useEffect(() => {
    if (triggerNewSession && triggerNewSession > 0) {
      handleNewSession();
    }
  }, [triggerNewSession]);

  useEffect(() => {
    if (triggerOpenHistory && triggerOpenHistory > 0) {
      setIsHistoryOpen(true);
    }
  }, [triggerOpenHistory]);

  // Exclui uma sessão de conversa do histórico privado do usuário
  const handleDeleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();

    // Remove do Firestore privado
    if (userId) {
      excluirSessaoFirestore(userId, id).catch(err =>
        console.warn("Aviso ao excluir sessão no Firestore:", err)
      );
    }

    if (sessions.length <= 1) {
      // Reseta a única existente para uma nova vazia
      const fallbackSess = createInitialSession(userId);
      setSessions([fallbackSess]);
      setActiveSessionId(fallbackSess.id);
      if (onSessionChange) onSessionChange(fallbackSess.id);
      if (userId) {
        salvarSessaoFirestore(userId, fallbackSess).catch(err =>
          console.warn("Aviso ao salvar sessão fallback no Firestore:", err)
        );
      }
      return;
    }

    const filtered = sessions.filter(s => s.id !== id);
    setSessions(filtered);
    if (activeSessionId === id) {
      const nextId = filtered[0].id;
      setActiveSessionId(nextId);
      if (onSessionChange) onSessionChange(nextId);
    }
  };

  // Limpa as mensagens da conversa atual, mantendo a sessão
  const handleClearCurrentChat = () => {
    const updated = sessions.map(sess => {
      if (sess.id === activeSession.id) {
        const cleaned: ChatSession = {
          ...sess,
          messages: [
            {
              id: `welcome_${Date.now()}`,
              sender: "assistant",
              text: "Olá! As mensagens anteriores desta conversa foram limpas.\n\nComo posso ajudar com a análise dos seus PDDs ou T2R agora?",
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            }
          ]
        };
        if (userId) {
          salvarSessaoFirestore(userId, cleaned).catch(err =>
            console.warn("Aviso ao atualizar sessão limpa no Firestore:", err)
          );
        }
        return cleaned;
      }
      return sess;
    });

    setSessions(updated);
    setExpandedSourceKey(null);
    setCurrentSources([]);
  };

  // Seleção e upload de múltiplos arquivos para o chat
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const validExtensions = ['.png', '.jpg', '.jpeg', '.pdf', '.xlsx', '.xls', '.docx', '.doc', '.csv', '.txt'];
    setAttachmentError(null);
    
    Array.from(files).forEach((file: any) => {
      const fileExtension = '.' + file.name.split('.').pop()?.toLowerCase();
      if (!validExtensions.includes(fileExtension) && !file.type.startsWith("image/")) {
        setAttachmentError(`Formato "${fileExtension}" não suportado. Escolha imagens, PDF, DOCX, XLSX, CSV ou TXT.`);
        setTimeout(() => setAttachmentError(null), 5000);
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        setAttachedFiles(prev => [
          ...prev,
          {
            name: file.name,
            type: file.type || 'application/octet-stream',
            base64: base64
          }
        ]);
      };
      reader.onerror = (error) => {
        console.error("Erro ao ler arquivo:", error);
      };
      reader.readAsDataURL(file);
    });

    e.target.value = "";
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    const validExtensions = ['.png', '.jpg', '.jpeg', '.pdf', '.xlsx', '.xls', '.docx', '.doc', '.csv', '.txt'];
    setAttachmentError(null);
    
    Array.from(files).forEach((file: any) => {
      const fileExtension = '.' + file.name.split('.').pop()?.toLowerCase();
      if (!validExtensions.includes(fileExtension) && !file.type.startsWith("image/")) {
        setAttachmentError(`Formato "${fileExtension}" não suportado. Escolha imagens, PDF, DOCX, XLSX, CSV ou TXT.`);
        setTimeout(() => setAttachmentError(null), 5000);
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        setAttachedFiles(prev => [
          ...prev,
          {
            name: file.name,
            type: file.type || 'application/octet-stream',
            base64: base64
          }
        ]);
      };
      reader.readAsDataURL(file);
    });
  };

  const handleSendMessage = async (textToSend: string) => {
    if ((!textToSend.trim() && attachedFiles.length === 0) || loading) return;

    const filesToUpload = [...attachedFiles];
    setAttachedFiles([]);

    const userMessage: ChatMessage = {
      id: `msg_${Date.now()}`,
      sender: "user",
      text: textToSend || `[Arquivos anexados: ${filesToUpload.map(f => f.name).join(", ")}]`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      attachments: filesToUpload.map(f => ({ name: f.name, type: f.type, base64: f.base64 }))
    };

    // Adiciona a mensagem do usuário à sessão ativa e atualiza o título se necessário
    setSessions(prevSessions => {
      return prevSessions.map(sess => {
        if (sess.id === activeSession.id) {
          const updatedMessages = [...sess.messages, userMessage];
          let updatedTitle = sess.title;
          if (sess.title === "Nova Conversa" || sess.title === "Dúvidas Gerais de PDDs") {
            const displayTitle = textToSend || `Arquivos: ${filesToUpload.map(f => f.name).join(", ")}`;
            updatedTitle = displayTitle.length > 25 ? displayTitle.substring(0, 25) + "..." : displayTitle;
          }
          const updatedSess = {
            ...sess,
            title: updatedTitle,
            messages: updatedMessages
          };
          if (userId) {
            salvarSessaoFirestore(userId, updatedSess).catch(err =>
              console.warn("Aviso ao salvar mensagem do usuário no Firestore:", err)
            );
          }
          return updatedSess;
        }
        return sess;
      });
    });

    setInputText("");
    setLoading(true);
    setExpandedSourceKey(null);

    const assistantMessageId = `msg_${Date.now() + 1}`;
    const initialAssistantMessage: ChatMessage = {
      id: assistantMessageId,
      sender: "assistant",
      text: "",
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      sources: []
    };

    setSessions(prevSessions => {
      return prevSessions.map(sess => {
        if (sess.id === activeSession.id) {
          return {
            ...sess,
            messages: [...sess.messages, initialAssistantMessage]
          };
        }
        return sess;
      });
    });

    try {
      // Histórico das últimas 5 mensagens da sessão ativa
      const historyContext = messages.slice(-5).map(m => ({
        sender: m.sender,
        text: m.text
      }));

      const res = await apiFetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          question: textToSend || `Analise os arquivos anexados: ${filesToUpload.map(f => f.name).join(", ")}`,
          clientId: selectedClientId,
          robotId: selectedRobotId,
          history: historyContext,
          sessionId: activeSession.id,
          attachments: filesToUpload.map(f => ({ name: f.name, type: f.type, base64: f.base64 })),
          selectedFileIds: selectedFileIds
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const detailedError = errData.error || `Erro de rede ou servidor (${res.status} ${res.statusText})`;
        throw new Error(detailedError);
      }

      if (!res.body) {
        throw new Error("Não foi possível estabelecer fluxo de leitura com o servidor.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let accumulatedText = "";
      let receivedSources: any[] = [];
      let buffer = "";

      setLoading(false);
      setIsTyping(true);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;

          const dataStr = trimmed.replace(/^data:\s*/, "");
          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.error) {
              throw new Error(parsed.error);
            }
            if (parsed.text) {
              accumulatedText += parsed.text;
              setSessions(prevSessions =>
                prevSessions.map(sess => {
                  if (sess.id === activeSession.id) {
                    return {
                      ...sess,
                      messages: sess.messages.map(m =>
                        m.id === assistantMessageId ? { ...m, text: accumulatedText } : m
                      )
                    };
                  }
                  return sess;
                })
              );
            }
            if (parsed.sources) {
              receivedSources = parsed.sources;
            }
          } catch (err: any) {
            if (err.message && !err.message.includes("JSON")) {
              throw err;
            }
          }
        }
      }

      // Processa restante eventual no buffer
      if (buffer.trim().startsWith("data:")) {
        const dataStr = buffer.trim().replace(/^data:\s*/, "");
        try {
          const parsed = JSON.parse(dataStr);
          if (parsed.text) {
            accumulatedText += parsed.text;
          }
          if (parsed.sources) {
            receivedSources = parsed.sources;
          }
        } catch {}
      }

      // Atualização final com o texto consolidado e fontes
      setSessions(prevSessions =>
        prevSessions.map(sess => {
          if (sess.id === activeSession.id) {
            return {
              ...sess,
              messages: sess.messages.map(m =>
                m.id === assistantMessageId
                  ? { ...m, text: accumulatedText || "Sem resposta obtida.", sources: receivedSources }
                  : m
              )
            };
          }
          return sess;
        })
      );

      if (receivedSources.length > 0) {
        setCurrentSources(receivedSources);
      } else {
        setCurrentSources([]);
      }

      setIsTyping(false);

      if (userId && auth.currentUser && auth.currentUser.uid === userId) {
        setSessions(latest => {
          const current = latest.find(s => s.id === activeSession.id);
          if (current) {
            salvarSessaoFirestore(userId, current).catch(err =>
              console.warn("Aviso ao salvar sessão completa no Firestore:", err)
            );
          }
          return latest;
        });
      }
    } catch (e: any) {
      console.error(e);
      setSessions(prevSessions => {
        return prevSessions.map(sess => {
          if (sess.id === activeSession.id) {
            const hasInitial = sess.messages.some(m => m.id === assistantMessageId);
            if (hasInitial) {
              return {
                ...sess,
                messages: sess.messages.map(m =>
                  m.id === assistantMessageId
                    ? {
                        ...m,
                        text: `Erro no Chat Especialista: ${e.message || "Erro desconhecido."}`,
                        isError: true
                      }
                    : m
                )
              };
            }
            return {
              ...sess,
              messages: [
                ...sess.messages,
                {
                  id: `msg_err_${Date.now()}`,
                  sender: "assistant",
                  text: `Erro no Chat Especialista: ${e.message || "Erro desconhecido."}`,
                  isError: true,
                  timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                }
              ]
            };
          }
          return sess;
        });
      });
      setLoading(false);
      setIsTyping(false);
    }
  };

  // Renderiza textos markdown completos (títulos, listas, negrito, tabelas e fontes) de forma limpa e bonita
  const formatMarkdown = (text: string) => {
    let normalizedText = text;
    normalizedText = normalizedText.replace(
      /Olá[!, ]*sou o \*{0,2}robbi9\*{0,2},?\s*assistente de consultas da \*{0,2}biti9\*{0,2}\.?/gi,
      "Olá,! sou o **Robbi9**, assistente de consultas da **Biti9**"
    );
    normalizedText = normalizedText.replace(
      /Olá[!, ]*sou o \*{0,2}especialista em rpa da biti9\*{0,2}\.?/gi,
      "Olá,! sou o **Robbi9**, assistente de consultas da **Biti9**"
    );
    normalizedText = normalizedText.replace(
      /Seu histórico de conversas é 100% individual e privado[^\n]*\n*/gi,
      ""
    );

    const lines = normalizedText.split("\n");
    const elements: React.ReactNode[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      // Suporte a tabelas Markdown (| Col 1 | Col 2 |)
      if (trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.split("|").length >= 3) {
        const tableLines: string[] = [];
        while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
          tableLines.push(lines[i].trim());
          i++;
        }

        if (tableLines.length >= 2) {
          const headerCells = tableLines[0]
            .split("|")
            .slice(1, -1)
            .map(c => c.trim());

          let startIndex = 1;
          // Pula a linha divisória (|---|---|) se ela contiver apenas hífens, dois-pontos e pipes
          if (tableLines[1].replace(/[\s|:-]/g, "").length === 0) {
            startIndex = 2;
          }

          const bodyRows = tableLines.slice(startIndex).map(tl =>
            tl
              .split("|")
              .slice(1, -1)
              .map(c => c.trim())
          );

          elements.push(
            <div key={`table_${i}`} className="my-2.5 overflow-x-auto rounded-lg border border-[var(--cor-borda)] bg-[var(--cor-superficie)] shadow-2xs">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-slate-100/80 border-b border-[var(--cor-borda)] text-[var(--cor-texto)] font-semibold">
                  <tr>
                    {headerCells.map((h, hIdx) => (
                      <th key={hIdx} className="px-3 py-2 border-r border-[var(--cor-borda)] last:border-r-0">
                        {renderInlineStyles(h)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--cor-borda)]">
                  {bodyRows.map((row, rIdx) => (
                    <tr key={rIdx} className="hover:bg-slate-50/50">
                      {row.map((cell, cIdx) => (
                        <td key={cIdx} className="px-3 py-2 border-r border-[var(--cor-borda)] last:border-r-0 text-[var(--cor-texto)]">
                          {renderInlineStyles(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
          continue;
        }
      }

      // Linha discreta de fontes ao final da resposta
      if (trimmed.startsWith("Fontes:") || trimmed.startsWith("Fonte:")) {
        elements.push(
          <div key={`src_${i}`} className="text-[11px] text-[var(--cor-texto-secundario)] mt-3 pt-2 border-t border-[var(--cor-borda)] font-medium flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5 text-[var(--cor-primaria)] shrink-0" />
            <span>{renderInlineStyles(trimmed)}</span>
          </div>
        );
        i++;
        continue;
      }

      // Suporte a imagens no formato ![alt](url)
      const imgMatch = line.match(/^!\[(.*?)\]\((.*?)\)/);
      if (imgMatch) {
        elements.push(
          <div key={`img_${i}`} className="my-3 flex justify-center w-full">
            <img 
              src={imgMatch[2]} 
              alt={imgMatch[1]} 
              className="rounded-xl border border-sky-400/25 max-h-64 object-cover shadow-lg aspect-video w-full max-w-lg" 
              referrerPolicy="no-referrer"
            />
          </div>
        );
        i++;
        continue;
      }

      // Cabeçalhos Markdown (#, ##, ###, ####)
      if (line.startsWith("#### ")) {
        elements.push(<h5 key={`h5_${i}`} className="text-xs font-semibold text-[var(--cor-texto)] mt-2 mb-1">{line.replace("#### ", "")}</h5>);
        i++;
        continue;
      }
      if (line.startsWith("### ")) {
        elements.push(<h4 key={`h4_${i}`} className="text-xs font-semibold text-[var(--cor-texto)] mt-2.5 mb-1">{line.replace("### ", "")}</h4>);
        i++;
        continue;
      }
      if (line.startsWith("## ")) {
        elements.push(<h3 key={`h3_${i}`} className="text-sm font-bold text-[var(--cor-texto)] mt-3 mb-1.5">{line.replace("## ", "")}</h3>);
        i++;
        continue;
      }
      if (line.startsWith("# ")) {
        elements.push(<h2 key={`h2_${i}`} className="text-base font-bold text-[var(--cor-texto)] mt-4 mb-2">{line.replace("# ", "")}</h2>);
        i++;
        continue;
      }

      // Tópicos com marcadores (*, -, •)
      if (trimmed.startsWith("* ") || trimmed.startsWith("- ") || trimmed.startsWith("• ")) {
        const cleaned = trimmed.replace(/^[\s*-•]+/, "");
        elements.push(
          <div key={`bullet_${i}`} className="flex items-start gap-2 pl-2 my-1">
            <span className="text-[var(--cor-primaria)] select-none mt-1.5 text-[6px]">●</span>
            <span className="text-xs leading-relaxed">{renderInlineStyles(cleaned)}</span>
          </div>
        );
        i++;
        continue;
      }

      // Tópicos numerados (1. , 2. )
      const numMatch = trimmed.match(/^(\d+)\.\s(.*)/);
      if (numMatch) {
        elements.push(
          <div key={`num_${i}`} className="flex items-start gap-2 pl-2 my-1">
            <span className="text-[var(--cor-primaria)] text-xs font-semibold shrink-0">{numMatch[1]}.</span>
            <span className="text-xs leading-relaxed">{renderInlineStyles(numMatch[2])}</span>
          </div>
        );
        i++;
        continue;
      }

      // Linha vazia ou parágrafo comum
      if (trimmed === "") {
        elements.push(<div key={`blank_${i}`} className="h-1.5" />);
      } else {
        elements.push(
          <p key={`p_${i}`} className="text-xs leading-relaxed my-1 min-h-[1px]">
            {renderInlineStyles(line)}
          </p>
        );
      }
      i++;
    }

    return elements;
  };

  const renderInlineStyles = (txt: string) => {
    const parts = txt.split(/(\*\*.*?\*\*|\*[^*\n]+?\*|`.*?`|\(Fonte:[^)]+\)|\[\[SEM_INFORMACAO\]\])/g);
    return parts.map((part, idx) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={idx} className="font-semibold text-inherit">{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
        return <em key={idx} className="italic text-inherit">{part.slice(1, -1)}</em>;
      }
      if (part.startsWith("`") && part.endsWith("`")) {
        return <code key={idx} className="bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-[11px] font-mono border border-slate-200 dark:border-slate-700">{part.slice(1, -1)}</code>;
      }
      if (part.startsWith("(Fonte:") && part.endsWith(")")) {
        return (
          <span key={idx} className="inline-flex items-center gap-1 mx-1 px-1.5 py-0.5 bg-[var(--cor-primaria-clara)] border border-[var(--cor-borda-primaria)] rounded text-[11px] text-[var(--cor-primaria)] font-medium">
            <FileText className="w-3 h-3 text-[var(--cor-primaria)] inline flex-shrink-0" />
            {part}
          </span>
        );
      }
      if (part === "[[SEM_INFORMACAO]]" || part.trim() === "[[SEM_INFORMACAO]]") {
        return (
          <span key={idx} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-[var(--cor-aviso-fundo)] border border-[#FFE0A3] rounded text-xs text-[var(--cor-aviso-texto)] font-medium">
            <AlertCircle className="w-3.5 h-3.5 text-[var(--cor-aviso-texto)] inline flex-shrink-0" />
            Não encontrei essa informação nos documentos selecionados.
          </span>
        );
      }
      return part;
    });
  };

  return (
    <div id="chat_central_container" className="relative flex h-full w-full bg-[var(--cor-fundo)] overflow-hidden">
      
      {/* JANELA DE CONVERSA ATIVA (CENTRO) */}
      <div 
        id="chat_panel" 
        onDragOver={handleDragOver}
        className="relative flex-1 flex flex-col h-full bg-[var(--cor-fundo)] text-[var(--cor-texto)] overflow-hidden"
      >
        
        {/* Toast Notification */}
        {toast.show && (
          <div className="absolute top-16 right-4 z-40 max-w-md animate-slide-in pointer-events-auto">
            {toast.type === "success" ? (
              <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 rounded-xl shadow-lg flex items-start gap-3">
                <CheckCircle className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-xs font-semibold text-emerald-900">Sincronização realizada</p>
                  <p className="text-xs text-emerald-700 mt-0.5">{toast.message}</p>
                </div>
                <button onClick={() => setToast(prev => ({ ...prev, show: false }))} className="text-emerald-500 hover:text-emerald-800 ml-auto cursor-pointer p-0.5">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <div className="bg-rose-50 border border-rose-200 text-rose-800 px-4 py-3 rounded-xl shadow-lg flex items-start gap-3">
                <XCircle className="w-5 h-5 text-rose-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-xs font-semibold text-rose-900">Falha ao definir banco de dados</p>
                  <p className="text-xs text-rose-700 mt-0.5">{toast.message}</p>
                </div>
                <button onClick={() => setToast(prev => ({ ...prev, show: false }))} className="text-rose-500 hover:text-rose-800 ml-auto cursor-pointer p-0.5">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Sub-header com Filtro Ativo */}
        <div className="bg-[var(--cor-card-fundo)] p-3 px-4 border-b border-[var(--cor-borda)] flex items-center justify-between z-10 relative">
          <div className="flex items-center gap-2">
            {onOpenSidebar && (
              <button
                onClick={onOpenSidebar}
                className="lg:hidden p-1.5 hover:bg-[var(--cor-hover)] rounded-md text-[var(--cor-texto-secundario)] hover:text-[var(--cor-texto)] transition-colors mr-1 flex items-center justify-center cursor-pointer border border-[var(--cor-borda)] bg-[var(--cor-card-fundo)]"
                title="Ver Clientes e Robôs"
              >
                <Layers className="w-3.5 h-3.5 text-[var(--cor-primaria)]" />
              </button>
            )}
            <span className="text-sm font-semibold text-[var(--cor-texto)]">
              Chat Central de Processo (RAG)
            </span>
          </div>
          
          <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
            {filterLabel ? (
              <div className="flex items-center gap-2 bg-[var(--cor-primaria-clara)] border border-[var(--cor-borda-primaria)] text-[var(--cor-primaria)] px-2.5 py-1 rounded-full text-xs animate-fade-in font-medium">
                <span className="truncate max-w-[150px] sm:max-w-xs text-xs">{filterLabel}</span>
                <button
                  onClick={onResetFilters}
                  className="hover:text-[var(--cor-texto)] font-bold ml-1 text-[10px]"
                  title="Remover filtro"
                >
                  ✕
                </button>
              </div>
            ) : (
              <span className="hidden sm:inline text-xs text-[var(--cor-texto-secundario)] font-normal mr-1">
                Consultando todos os clientes
              </span>
            )}
          </div>
        </div>

        {/* Fluxo de Mensagens */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar bg-[var(--cor-chat-fundo)] z-10 relative">
          {messages.map((msg, idx) => {
            const isAssistant = msg.sender === "assistant";
            const isWelcomeMsg =
              isAssistant && (
                msg.id === "welcome" ||
                msg.id.startsWith("welcome") ||
                idx === 0 ||
                msg.text?.toLowerCase().includes("assistente de consultas") ||
                msg.text?.toLowerCase().includes("robbi9") ||
                msg.text?.toLowerCase().includes("especialista em rpa")
              );
            
            return (
              <div key={msg.id} className={`flex ${isAssistant ? "justify-start" : "justify-end"} items-start gap-3 max-w-full`}>
                {isAssistant && (
                  <div
                    className="relative flex-shrink-0 mt-0.5 animate-float select-none"
                    title="Robbi9 - Assistente de consultas da Biti9"
                  >
                    <img
                      src="https://connect.biti9.com.br/mascote-robbi9.png"
                      alt="Mascote robbi9"
                      referrerPolicy="no-referrer"
                      className="w-9 h-9 sm:w-10 sm:h-10 object-contain mascote-destaque select-none"
                    />
                  </div>
                )}
                
                <div className={`max-w-2xl space-y-1.5 ${isAssistant ? "text-left" : "text-right"}`}>
                  {/* Balão */}
                  <div className={`p-4 rounded-2xl leading-relaxed text-xs border shadow-xs ${
                    isAssistant 
                      ? "bg-[var(--cor-card-fundo)] border-[var(--cor-borda)] rounded-tl-none text-[var(--cor-texto)] shadow-2xs" 
                      : "bg-[var(--cor-balaousuario-fundo)] border-[var(--cor-balaousuario-borda)] rounded-tr-none text-white shadow-xs"
                  }`}>
                    {/* Retrocompatibilidade e suporte a múltiplos anexos */}
                    {((msg.attachment ? [msg.attachment] : []).concat(msg.attachments || [])).length > 0 && (
                      <div className="mb-2.5 flex flex-wrap gap-2">
                        {((msg.attachment ? [msg.attachment] : []).concat(msg.attachments || [])).map((att, attIdx) => (
                          <div key={attIdx} className={`p-2 rounded-xl border flex items-center gap-2.5 max-w-sm text-left ${
                            isAssistant ? "bg-[var(--cor-superficie)] border-[var(--cor-borda)]" : "bg-white/10 border-white/20"
                          }`}>
                            {att.type.startsWith("image/") && att.base64 ? (
                              <img
                                src={`data:${att.type};base64,${att.base64}`}
                                alt={att.name}
                                className="w-12 h-12 object-cover rounded-lg border border-[var(--cor-borda)] flex-shrink-0"
                              />
                            ) : (
                              <div className={`w-12 h-12 rounded-lg flex items-center justify-center border flex-shrink-0 ${
                                isAssistant ? "bg-[var(--cor-primaria-clara)] border-[var(--cor-borda-primaria)] text-[var(--cor-primaria)]" : "bg-white/20 border-white/30 text-white"
                              }`}>
                                <FileText className="w-6 h-6" />
                              </div>
                            )}
                            <div className="flex flex-col min-w-0">
                              <span className={`text-[11px] font-medium truncate max-w-[180px] ${isAssistant ? "text-[var(--cor-texto)]" : "text-white"}`} title={att.name}>
                                {att.name}
                              </span>
                              <span className={`text-[8px] uppercase tracking-wider mt-0.5 ${isAssistant ? "text-[var(--cor-texto-secundario)]" : "text-white/80"}`}>
                                {att.name.split('.').pop()}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {isWelcomeMsg ? (
                      formatMarkdown(WELCOME_FULL_TEXT)
                    ) : msg.text ? (
                      formatMarkdown(msg.text)
                    ) : (
                      <div className="flex items-center gap-2 py-1 text-[var(--cor-texto-secundario)]">
                        <RefreshCw className="w-3.5 h-3.5 animate-spin text-[var(--cor-primaria)]" />
                        <span className="text-xs">Consultando fontes e gerando resposta...</span>
                      </div>
                    )}
                  </div>

                  {/* Metadados / Tags da Mensagem */}
                  <div className={`text-xs text-[var(--cor-texto-secundario)] flex items-center gap-1.5 ${isAssistant ? "justify-start pl-1" : "justify-end pr-1"}`}>
                    <span>{msg.timestamp}</span>
                    {isAssistant && !isWelcomeMsg && (
                      msg.isError ? (
                        <span className="text-rose-600 flex items-center gap-0.5 text-xs font-medium">
                          <XCircle className="w-3.5 h-3.5" />
                          RAG falhou
                        </span>
                      ) : (
                        <>
                          <span className="text-[var(--cor-primaria)] flex items-center gap-0.5 text-xs font-medium">
                            <CheckCircle className="w-3 h-3 text-[var(--cor-primaria)]" />
                            RAG concluído
                          </span>
                          {msg.text && (
                            <button
                              type="button"
                              onClick={() => handleBaixarPDF(msg)}
                              disabled={baixandoPdfMsgId === msg.id}
                              className="text-[var(--cor-texto-secundario)] hover:text-[var(--cor-primaria)] transition-colors flex items-center gap-1 text-[11px] hover:bg-[var(--cor-superficie)] px-1.5 py-0.5 rounded cursor-pointer ml-auto disabled:opacity-50 font-normal"
                              title="Baixar como PDF"
                            >
                              {baixandoPdfMsgId === msg.id ? (
                                <>
                                  <RefreshCw className="w-3 h-3 animate-spin text-[var(--cor-primaria)]" />
                                  <span>Gerando PDF...</span>
                                </>
                              ) : (
                                <>
                                  <Download className="w-3 h-3 text-current" />
                                  <span>Baixar como PDF</span>
                                </>
                              )}
                            </button>
                          )}
                        </>
                      )
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {loading && !isTyping && messages[messages.length - 1]?.sender !== "assistant" && (
            <div className="flex items-start gap-3 max-w-xl">
              <div
                className="relative flex-shrink-0 animate-float select-none"
                title="robbi9 - Assistente de consultas da Biti9"
              >
                <img
                  src="https://connect.biti9.com.br/mascote-robbi9.png"
                  alt="Mascote robbi9"
                  referrerPolicy="no-referrer"
                  className="w-9 h-9 sm:w-10 sm:h-10 object-contain mascote-destaque select-none"
                />
              </div>
              <div className="space-y-2 flex-1 pt-1 animate-pulse">
                <div className="h-3 bg-slate-200 rounded-full w-3/4"></div>
                <div className="h-3 bg-slate-200 rounded-full w-5/6"></div>
                <div className="h-3 bg-slate-200 rounded-full w-1/2"></div>
                <p className="text-xs text-[var(--cor-primaria)] mt-2 flex items-center gap-1.5 font-medium">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-[var(--cor-primaria)]" />
                  <span>Consultando banco de vetores...</span>
                </p>
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Caixa de Entrada e Chips Rápidos */}
        <div className="p-4 border-t border-[var(--cor-borda)] bg-[var(--cor-card-fundo)] space-y-3.5 z-10 relative">
          {/* Alerta de nenhuma fonte ativa no painel lateral */}
          {selectedFileIds && selectedFileIds.length === 0 && (
            <div className="flex items-center gap-2.5 p-2.5 rounded-lg bg-[var(--cor-aviso-fundo)] border border-[var(--cor-borda)] text-[var(--cor-aviso-texto)] text-xs">
              <AlertCircle className="w-4 h-4 flex-shrink-0 text-[var(--cor-aviso-texto)]" />
              <span>Nenhuma fonte ativa no painel lateral. Marque os arquivos que deseja consultar ou adicione novos no botão <strong>"+ Adicionar fontes"</strong>.</span>
            </div>
          )}
          {/* Chips de Perguntas Rápidas */}
          {messages.length <= 2 && !loading && !isTyping && (
            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-[var(--cor-texto-secundario)] flex items-center gap-1.5">
                <HelpCircle className="w-3.5 h-3.5 text-[var(--cor-primaria)]" />
                Perguntas sugeridas (Clique para consultar)
              </p>
              <div className="flex flex-wrap gap-1.5">
                {QUICK_PROMPTS.map((prompt, i) => (
                  <button
                    key={i}
                    onClick={() => handleSendMessage(prompt)}
                    className="bg-[var(--cor-card-fundo)] hover:bg-[var(--cor-superficie)] border border-[var(--cor-borda)] text-[var(--cor-texto)] hover:border-[var(--cor-primaria)] rounded-lg px-3 py-1.5 text-xs font-medium text-left transition-all flex items-center gap-1 max-w-full cursor-pointer shadow-2xs"
                  >
                    <span className="truncate">{prompt}</span>
                    <ArrowRight className="w-3 h-3 flex-shrink-0 text-[var(--cor-texto-secundario)]" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Card de Preview Flutuante de Arquivo */}
          {attachedFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {attachedFiles.map((file, index) => (
                <div key={index} className="flex items-center gap-2.5 p-2 bg-[var(--cor-superficie)] border border-[var(--cor-borda)] rounded-xl max-w-full w-fit shadow-sm animate-fade-in">
                  {/* File Thumbnail or Icon */}
                  {file.type.startsWith("image/") ? (
                    <img
                      src={`data:${file.type};base64,${file.base64}`}
                      alt="Preview"
                      className="w-8 h-8 object-cover rounded-lg border border-[var(--cor-borda)] flex-shrink-0"
                    />
                  ) : (
                    <div className="w-8 h-8 bg-[var(--cor-primaria-clara)] border border-[var(--cor-borda-primaria)] rounded-lg flex items-center justify-center text-[var(--cor-primaria)] flex-shrink-0">
                      <FileText className="w-4 h-4" />
                    </div>
                  )}
                  
                  <div className="flex flex-col min-w-0 pr-2">
                    <span className="text-xs font-medium text-[var(--cor-texto)] truncate max-w-[150px]" title={file.name}>
                      {file.name}
                    </span>
                    <span className="text-[10px] text-[var(--cor-texto-secundario)] uppercase font-mono tracking-wider">
                      {file.name.split('.').pop()}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => setAttachedFiles(prev => prev.filter((_, idx) => idx !== index))}
                    className="p-1 hover:bg-[var(--cor-hover)] rounded-full text-[var(--cor-texto-secundario)] hover:text-[var(--cor-texto)] transition-colors cursor-pointer"
                    title="Remover anexo"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Mensagem de Erro de Anexo */}
          {attachmentError && (
            <div className="mb-2 flex items-center gap-2 p-2 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-500 text-xs">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="flex-1">{attachmentError}</span>
              <button
                type="button"
                onClick={() => setAttachmentError(null)}
                className="text-rose-400 hover:text-rose-600 text-xs font-bold"
              >
                ✕
              </button>
            </div>
          )}

          {/* Formulário de Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSendMessage(inputText);
            }}
            className="relative flex items-center w-full"
          >
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Pergunte algo sobre os robôs..."
              disabled={loading || isTyping}
              className="w-full bg-[var(--cor-superficie)] border border-[var(--cor-borda)] rounded-full py-2.5 pl-4 pr-12 text-xs text-[var(--cor-texto)] placeholder-[var(--cor-texto-secundario)] focus:outline-none focus:border-[var(--cor-primaria)] focus:bg-[var(--cor-card-fundo)] focus:ring-1 focus:ring-[var(--cor-primaria)]/20 transition-all disabled:opacity-50 font-sans"
            />
            <button
              type="submit"
              disabled={loading || isTyping || (!inputText.trim() && attachedFiles.length === 0)}
              className="absolute right-1.5 p-2 bg-[var(--cor-primaria)] hover:bg-[var(--cor-primaria-hover)] disabled:bg-[var(--cor-superficie)] disabled:text-[var(--cor-texto-secundario)] text-white rounded-full transition-all flex items-center justify-center flex-shrink-0 cursor-pointer shadow-xs"
              title="Enviar"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </form>
        </div>

        {/* Overlay para Drag and Drop de Arquivos */}
        {isDragging && (
          <div 
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className="absolute inset-0 bg-[var(--cor-card-fundo)]/95 backdrop-blur-sm border-2 border-dashed border-[var(--cor-primaria)] rounded-2xl flex flex-col items-center justify-center gap-3 z-50 transition-all m-4 shadow-xl"
          >
            <div className="w-16 h-16 rounded-full bg-[var(--cor-primaria-clara)] border border-[var(--cor-borda-primaria)] flex items-center justify-center text-[var(--cor-primaria)] animate-bounce">
              <Plus className="w-8 h-8" />
            </div>
            <span className="text-sm font-semibold text-[var(--cor-texto)]">Arraste seu arquivo aqui</span>
            <span className="text-xs text-[var(--cor-texto-secundario)]">Imagens (PNG, JPG) ou Documentos (PDF, XLSX, CSV, DOCX, TXT)</span>
          </div>
        )}

      </div>

      {/* GAVETA DE HISTÓRICO FLUTUANTE (DRAWER OVERLAY) */}
      {isHistoryOpen && (
        <div 
          id="history_drawer_overlay"
          className="absolute inset-0 bg-slate-900/50 backdrop-blur-xs z-40 transition-opacity flex justify-end"
          onClick={() => setIsHistoryOpen(false)}
        >
          <div 
            id="history_drawer"
            className="w-full max-w-[380px] bg-[var(--cor-card-fundo)] border-l border-[var(--cor-borda)] h-full flex flex-col shadow-2xl relative animate-slide-in-right text-[var(--cor-texto)]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Cabeçalho da Gaveta */}
            <div className="p-4 border-b border-[var(--cor-borda)] flex items-center justify-between bg-[var(--cor-card-fundo)]">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-[var(--cor-primaria-clara)] border border-[var(--cor-borda-primaria)] flex items-center justify-center text-[var(--cor-primaria)] flex-shrink-0">
                  <History className="w-4 h-4" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-[var(--cor-texto)] font-sans">
                      Histórico de Conversas
                    </h3>
                    <span className="text-xs bg-[var(--cor-primaria-clara)] text-[var(--cor-primaria)] px-2 py-0.5 rounded-full font-semibold">
                      {sessions.length}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-medium mt-0.5">
                    <Lock className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                    <span>Privado e individual</span>
                  </div>
                </div>
              </div>
              <button 
                onClick={() => setIsHistoryOpen(false)}
                className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-700 transition-colors cursor-pointer"
                title="Fechar"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Lista de Sessões */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar bg-[var(--cor-superficie)]">
              {sessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 text-center text-[var(--cor-texto-secundario)]">
                  <MessageSquare className="w-8 h-8 text-slate-400 mb-2" />
                  <p className="text-xs">Nenhum histórico de conversas encontrado</p>
                </div>
              ) : (
                sessions.map((sess) => {
                  const isActive = sess.id === activeSession.id;
                  const isEditing = editingSessionId === sess.id;
                  // Pegar primeira mensagem do usuário se existir para exibir como contexto
                  const firstUserMsg = sess.messages.find(m => m.sender === "user")?.text;
                  
                  return (
                    <div
                      key={sess.id}
                      onClick={() => {
                        if (!isEditing) {
                          setActiveSessionId(sess.id);
                          if (onSessionChange) onSessionChange(sess.id);
                          setExpandedSourceKey(null);
                          setIsHistoryOpen(false); // fecha ao carregar a conversa
                        }
                      }}
                      className={`group flex flex-col gap-2 p-3.5 rounded-xl border transition-all ${
                        isEditing
                          ? "border-[var(--cor-borda-primaria)] bg-[var(--cor-primaria-clara)]"
                          : isActive
                          ? "bg-[var(--cor-card-fundo)] border-[var(--cor-primaria)] shadow-xs ring-1 ring-[var(--cor-primaria)]/30 cursor-pointer"
                          : "border-[var(--cor-borda)] bg-[var(--cor-card-fundo)] hover:bg-[var(--cor-hover)] cursor-pointer"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2 min-w-0 flex-1">
                          <MessageSquare className={`w-4 h-4 mt-0.5 flex-shrink-0 ${isActive ? "text-[var(--cor-primaria)]" : "text-[var(--cor-texto-secundario)]"}`} />
                          
                          {isEditing ? (
                            <div className="flex items-center gap-1.5 min-w-0 flex-1" onClick={(e) => e.stopPropagation()}>
                              <input
                                type="text"
                                autoFocus
                                value={editingTitle}
                                onChange={(e) => setEditingTitle(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    handleSaveRename(sess.id, e);
                                  } else if (e.key === "Escape") {
                                    setEditingSessionId(null);
                                  }
                                }}
                                onFocus={(e) => e.target.select()}
                                className="w-full bg-[var(--cor-card-fundo)] border border-[var(--cor-primaria)] rounded px-2 py-1 text-xs text-[var(--cor-texto)] focus:outline-none focus:ring-1 focus:ring-[var(--cor-primaria)] font-medium"
                              />
                              <button
                                type="button"
                                onClick={(e) => handleSaveRename(sess.id, e)}
                                className="p-1 hover:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 rounded transition-colors cursor-pointer flex-shrink-0"
                                title="Salvar título (Enter)"
                              >
                                <Check className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditingSessionId(null);
                                }}
                                className="p-1 hover:bg-rose-500/10 text-rose-600 dark:text-rose-400 rounded transition-colors cursor-pointer flex-shrink-0"
                                title="Cancelar (Esc)"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ) : (
                            <div className="flex flex-col min-w-0">
                              <span className={`text-xs font-semibold truncate ${isActive ? "text-[var(--cor-primaria)]" : "text-[var(--cor-texto)]"}`}>
                                {sess.title}
                              </span>
                              {firstUserMsg && firstUserMsg !== sess.title && (
                                <p className="text-[11px] text-[var(--cor-texto-secundario)] truncate mt-0.5 italic">
                                  "{firstUserMsg}"
                                </p>
                              )}
                            </div>
                          )}
                        </div>

                        {!isEditing && (
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              type="button"
                              onClick={(e) => handleStartRename(e, sess)}
                              className="text-[var(--cor-texto-secundario)] hover:text-[var(--cor-primaria)] p-1 rounded-md hover:bg-[var(--cor-hover)] transition-all cursor-pointer"
                              title="Renomear conversa"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteSession(sess.id, e);
                              }}
                              className="text-[var(--cor-texto-secundario)] hover:text-rose-600 p-1 rounded-md hover:bg-rose-500/10 transition-all cursor-pointer"
                              title="Excluir do histórico"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="flex items-center justify-between mt-1 text-xs text-[var(--cor-texto-secundario)]">
                        <div className="flex items-center gap-1">
                          <Clock className="w-3 h-3 text-[var(--cor-texto-secundario)]" />
                          <span>{sess.timestamp || "Hoje"}</span>
                        </div>
                        {isActive && (
                          <span className="text-[10px] bg-[var(--cor-primaria-clara)] text-[var(--cor-primaria)] px-1.5 py-0.5 rounded font-semibold">
                            Ativo
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Rodapé da Gaveta */}
            <div className="p-4 border-t border-[var(--cor-borda)] bg-[var(--cor-card-fundo)] flex gap-2">
              <button
                onClick={() => {
                  handleNewSession();
                  setIsHistoryOpen(false);
                }}
                className="w-full flex items-center justify-center gap-2 bg-[var(--cor-balaousuario-fundo)] hover:opacity-95 text-white text-xs font-semibold py-2.5 px-4 rounded-xl transition-all shadow-xs cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                Nova Conversa
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
