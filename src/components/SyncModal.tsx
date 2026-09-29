import React, { useState, useEffect, useRef } from "react";
import { Folder, RefreshCw, AlertTriangle, Play, Terminal, X, ShieldAlert, CheckCircle2 } from "lucide-react";
import { apiFetch } from "../services/api";

interface SyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  token: string | null;
  onRefresh: () => void;
  onLoginWithGoogle: () => void;
  onSuccessOk?: () => void;
  userEmail?: string;
}

export default function SyncModal({
  isOpen,
  onClose,
  token,
  onRefresh,
  onLoginWithGoogle,
  onSuccessOk,
  userEmail
}: SyncModalProps) {
  const [syncing, setSyncing] = useState(false);
  const [inputFolderLink, setInputFolderLink] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [loadingFolderName, setLoadingFolderName] = useState(false);
  const [resolvedFolderName, setResolvedFolderName] = useState("");

  const terminalEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logic for terminal logs
  useEffect(() => {
    if (terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  if (!isOpen) return null;

  // Utility to extract Google Drive Folder ID
  const extractFolderId = (input: string): string => {
    const trimmed = input.trim();
    if (trimmed.includes("drive.google.com")) {
      const match = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) {
        return match[1];
      }
    }
    return trimmed;
  };

  const handleStartSync = async () => {
    const folderId = extractFolderId(inputFolderLink);
    if (!folderId) {
      setLogs(["[ERRO] Por favor, insira um ID ou link válido de pasta do Google Drive."]);
      return;
    }

    if (!token) {
      setLogs(["[ERRO] Usuário não autenticado no Google Drive. Conecte-se primeiro."]);
      return;
    }

    setSyncing(true);
    setLogs([
      `[SISTEMA] Iniciando Sincronização Real a partir de ID/Link...`,
      `[SISTEMA] ID da pasta raiz resolvido: "${folderId}"`,
      `[SISTEMA] Validando acesso à pasta no Google Drive...`
    ]);

    try {
      // Step 1: Resolve Folder Name for logs and display
      setLoadingFolderName(true);
      let folderName = "Pasta Raiz Conectada";
      try {
        const nameRes = await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}?fields=name`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (nameRes.ok) {
          const nameData = await nameRes.json();
          if (nameData.name) {
            folderName = nameData.name;
            setResolvedFolderName(folderName);
            setLogs(prev => [...prev, `[SISTEMA] Pasta validada: "${folderName}"`]);
          }
        } else {
          setLogs(prev => [...prev, `[SISTEMA] Aviso: Não foi possível obter o nome da pasta. Usando ID padrão.`]);
        }
      } catch (err: any) {
        setLogs(prev => [...prev, `[SISTEMA] Aviso: Falha ao resolver nome da pasta: ${err.message}`]);
      } finally {
        setLoadingFolderName(false);
      }

      // Step 2: Trigger the RAG Sync backend
      setLogs(prev => [...prev, `[SISTEMA] Disparando indexação neural no backend (PDFs e T2Rs)...`]);
      
      const res = await apiFetch("/api/drive/sync-real", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "x-drive-token": token } : {})
        },
        body: JSON.stringify({
          rootFolderId: folderId,
          rootFolderName: folderName,
          userEmail: userEmail
        })
      });

      const data = await res.json();
      if (data.success) {
        setLogs(prev => [...prev, ...data.logs]);
        onRefresh(); // Updates the counter of "DOCUMENTOS" and "FRAGMENTOS" and reloads client list
        setStatusMessage("Sincronização concluída com sucesso!");
      } else {
        setLogs(prev => [...prev, ...data.logs, `[ERRO] Falha na sincronização: ${data.error}`]);
        setStatusMessage(`Falha na sincronização: ${data.error}`);
      }
    } catch (e: any) {
      setLogs(prev => [...prev, `[ERRO CRÍTICO] Exceção na sincronização: ${e.message}`]);
      setStatusMessage(`Erro crítico: ${e.message}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center z-50 p-4 animate-fade-in">
      <div 
        className="bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)] rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-[var(--cor-borda)] flex items-center justify-between bg-[var(--cor-card-fundo)] font-sans">
          <div className="flex items-center gap-2">
            <div className="bg-[var(--cor-primaria-clara)] p-1.5 rounded text-[var(--cor-primaria)]">
              <Folder className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--cor-texto)]">
                Sincronizador Google Drive (RAG)
              </h3>
              <p className="text-xs text-[var(--cor-texto-secundario)]">Indexação de PDDs & Processos</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            disabled={syncing}
            className="text-[var(--cor-texto-secundario)] hover:text-[var(--cor-texto)] transition-colors disabled:opacity-30 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-4 flex-1 font-sans">
          {!token ? (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-5 text-center space-y-3">
              <ShieldAlert className="w-10 h-10 text-amber-500 mx-auto" />
              <div className="space-y-1">
                <p className="text-xs font-semibold text-amber-500">Conexão Necessária</p>
                <p className="text-xs text-[var(--cor-texto-secundario)]">
                  Você precisa autorizar a conexão com o Google Drive para poder rastrear e ler as pastas de seus clientes.
                </p>
              </div>
              <button
                onClick={onLoginWithGoogle}
                className="bg-[var(--cor-balaousuario-fundo)] hover:opacity-90 text-white text-xs font-medium px-4 py-2 rounded-lg transition-colors shadow-xs cursor-pointer"
              >
                Conectar ao Google Drive
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-[var(--cor-texto)]">
                  Link ou ID da Pasta do Drive:
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={inputFolderLink}
                    onChange={(e) => setInputFolderLink(e.target.value)}
                    disabled={syncing}
                    placeholder="Cole o link completo da pasta ou o ID (ex: 1A_B-C_D-E...)"
                    className="flex-1 bg-[var(--cor-superficie)] border border-[var(--cor-borda)] rounded-lg px-3 py-2 text-xs text-[var(--cor-texto)] placeholder-[var(--cor-texto-secundario)] focus:outline-none focus:border-[var(--cor-primaria)] focus:bg-[var(--cor-card-fundo)] transition-all font-mono"
                  />
                  <button
                    onClick={handleStartSync}
                    disabled={syncing || !inputFolderLink.trim()}
                    className="bg-[var(--cor-balaousuario-fundo)] hover:opacity-90 text-white font-medium px-4 py-2 rounded-lg text-xs transition-colors disabled:opacity-50 flex items-center gap-1.5 shadow-xs cursor-pointer"
                  >
                    {syncing ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        Sincronizando...
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5" />
                        Iniciar Sincronização
                      </>
                    )}
                  </button>
                </div>
                <p className="text-xs text-[var(--cor-texto-secundario)]">
                  Dica: O ID é o código no final do endereço da pasta ou cole o endereço completo da barra de navegação.
                </p>
              </div>

              {/* Console de logs */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-semibold text-[var(--cor-texto-secundario)]">
                  <span className="flex items-center gap-1">
                    <Terminal className="w-3.5 h-3.5 text-[var(--cor-primaria)]" />
                    Console de Indexação RAG em Tempo Real
                  </span>
                  {syncing && (
                    <span className="text-amber-500 animate-pulse flex items-center gap-1 text-xs">
                      <RefreshCw className="w-2.5 h-2.5 animate-spin" />
                      Indexando arquivos...
                    </span>
                  )}
                </div>
                
                <div className="bg-[var(--cor-superficie)] border border-[var(--cor-borda)] rounded-lg p-3 h-48 overflow-y-auto font-mono text-xs leading-relaxed custom-scrollbar text-[var(--cor-texto)]">
                  {logs.length === 0 ? (
                    <div className="text-[var(--cor-texto-secundario)] italic">
                      [SISTEMA] Aguardando link ou ID para iniciar processo de escaneamento de PDDs e processos...
                    </div>
                  ) : (
                    logs.map((log, index) => {
                      let colorClass = "text-[var(--cor-texto)]";
                      if (log.startsWith("[ERRO]")) colorClass = "text-rose-500 font-bold";
                      if (log.startsWith("[SISTEMA]")) colorClass = "text-[var(--cor-primaria)] font-semibold";
                      if (log.includes("->")) colorClass = "text-blue-500";
                      return (
                        <div key={index} className={colorClass}>
                          {log}
                        </div>
                      );
                    })
                  )}
                  <div ref={terminalEndRef} />
                </div>
              </div>

              {/* Status Banner */}
              {statusMessage && (
                <div className="bg-[var(--cor-superficie)] border border-[var(--cor-borda)] rounded-lg p-3 flex items-center justify-between text-xs text-[var(--cor-texto)]">
                  <span className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                    {statusMessage}
                  </span>
                  <button 
                    onClick={() => {
                      setStatusMessage(null);
                      if (onSuccessOk) {
                        onSuccessOk();
                      } else {
                        onClose();
                      }
                    }}
                    className="text-xs text-[var(--cor-primaria)] hover:underline cursor-pointer"
                  >
                    OK
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-[var(--cor-borda)] bg-[var(--cor-card-fundo)] flex justify-end gap-2 text-xs text-[var(--cor-texto-secundario)]">
          <span>O backend extrairá texto via Gemini de múltiplos formatos (PDFs, Planilhas, Docs)</span>
        </div>
      </div>
    </div>
  );
}
