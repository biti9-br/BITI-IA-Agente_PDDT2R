import React, { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  X,
  Folder,
  File,
  FileSpreadsheet,
  FileText,
  ChevronRight,
  ArrowLeft,
  RefreshCw,
  Download,
  AlertCircle,
  Cloud,
  CheckCircle2,
  HardDrive,
  Terminal,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  Trash2,
  Sparkles,
  AlertTriangle
} from "lucide-react";
import {
  resolverSiteId,
  encontrarBibliotecaDriveId,
  listarItensSharePoint,
  carregarProximosItensSharePoint,
  obterArquivoSharePointEmMemoria,
  SharePointItem,
  GraphError,
  GraphLogEntry,
  subscribeGraphLogs,
  clearGraphLogs,
  getLastResolvedSite
} from "../services/sharepointService";
import { SHAREPOINT_HOSTNAME, SHAREPOINT_SITE_PATH, SHAREPOINT_LIBRARY } from "../config/sharepoint";
import { apiFetch } from "../services/api";
import { getMemoryToken, reautenticarMicrosoft } from "../auth";

interface SharePointBrowserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (file: File, folderPath: string) => Promise<any>;
}

interface BreadcrumbItem {
  id?: string; // undefined = raiz da biblioteca
  name: string;
}

export default function SharePointBrowserModal({
  isOpen,
  onClose,
  onImport
}: SharePointBrowserModalProps) {
  const [siteId, setSiteId] = useState<string | null>(null);
  const [driveId, setDriveId] = useState<string | null>(null);
  const [activeSiglas, setActiveSiglas] = useState<string[]>([]);
  const [loadingTypes, setLoadingTypes] = useState(true);
  const [folderStack, setFolderStack] = useState<BreadcrumbItem[]>([
    { id: undefined, name: SHAREPOINT_LIBRARY }
  ]);
  const [items, setItems] = useState<SharePointItem[]>([]);
  const [nextLink, setNextLink] = useState<string | undefined>(undefined);
  const [selectedItem, setSelectedItem] = useState<SharePointItem | null>(null);

  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [importing, setImporting] = useState(false);
  const [reauthenticating, setReauthenticating] = useState(false);
  const [hasGraphToken, setHasGraphToken] = useState<boolean>(() => Boolean(getMemoryToken()));
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      apiFetch("/api/settings/document-types/active")
        .then(res => res.json())
        .then(data => {
          if (Array.isArray(data.siglas) && data.siglas.length > 0) {
            setActiveSiglas(data.siglas);
          }
        })
        .catch(() => {});
    }
  }, [isOpen]);

  // Reautenticar na Microsoft quando o token em memória não estiver disponível (ex: após F5)
  const handleReautenticarMicrosoft = async () => {
    setReauthenticating(true);
    setError(null);
    try {
      await reautenticarMicrosoft();
      setHasGraphToken(true);
      await inicializarSharePoint();
    } catch (err: any) {
      console.error("Erro na autenticação com Microsoft:", err);
      setError(err?.message || "Falha na reautenticação com a Microsoft.");
    } finally {
      setReauthenticating(false);
    }
  };

  // Painel de diagnóstico de chamadas Microsoft Graph
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [logs, setLogs] = useState<GraphLogEntry[]>([]);
  const [copiedLogId, setCopiedLogId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const unsubscribe = subscribeGraphLogs((updatedLogs) => {
      setLogs(updatedLogs);
    });
    return unsubscribe;
  }, [isOpen]);

  const handleCopyLog = (log: GraphLogEntry) => {
    try {
      const jsonStr =
        typeof log.response === "string"
          ? log.response
          : JSON.stringify(log.response, null, 2);
      navigator.clipboard.writeText(jsonStr);
      setCopiedLogId(log.id);
      setTimeout(() => setCopiedLogId(null), 2000);
    } catch {
      // Ignora restrição de clipboard
    }
  };

  // Carrega tipos permitidos da API
  useEffect(() => {
    if (isOpen) {
      setLoadingTypes(true);
      apiFetch("/api/settings/document-types/active")
        .then(res => res.json())
        .then(data => {
          if (Array.isArray(data.siglas)) {
            setActiveSiglas(data.siglas);
          }
        })
        .catch(() => {})
        .finally(() => setLoadingTypes(false));
    }
  }, [isOpen]);

  const currentFolder = folderStack[folderStack.length - 1];

  // Carrega itens da pasta atual
  const carregarPasta = useCallback(async (dId: string, folderItemId?: string) => {
    setLoading(true);
    setError(null);
    setSelectedItem(null);
    try {
      const res = await listarItensSharePoint(dId, folderItemId);
      // Ordena: pastas primeiro, depois arquivos alfabeticamente
      const ordenados = [...res.items].sort((a, b) => {
        const aIsFolder = !!a.folder;
        const bIsFolder = !!b.folder;
        if (aIsFolder && !bIsFolder) return -1;
        if (!aIsFolder && bIsFolder) return 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
      setItems(ordenados);
      setNextLink(res.nextLink);
    } catch (err: any) {
      console.error("Erro ao listar itens do SharePoint:", err);
      setError(err.message || "Erro ao conectar ao SharePoint.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Inicialização: resolve site e biblioteca Drive
  const inicializarSharePoint = useCallback(async () => {
    const token = getMemoryToken();
    if (!token) {
      setHasGraphToken(false);
      return;
    }

    setHasGraphToken(true);
    setLoading(true);
    setError(null);
    setFolderStack([{ id: undefined, name: SHAREPOINT_LIBRARY }]);
    setSelectedItem(null);
    try {
      const sId = await resolverSiteId();
      setSiteId(sId);

      const dId = await encontrarBibliotecaDriveId(sId);
      setDriveId(dId);

      await carregarPasta(dId, undefined);
    } catch (err: any) {
      console.error("Erro ao inicializar SharePoint:", err);
      if (err instanceof GraphError && (err.statusCode === 401 || err.statusCode === 403)) {
        setHasGraphToken(false);
      }
      setError(err.message || "Erro ao conectar ao SharePoint.");
    } finally {
      setLoading(false);
    }
  }, [carregarPasta]);

  useEffect(() => {
    if (isOpen) {
      setError(null);
      const tokenPresente = Boolean(getMemoryToken());
      setHasGraphToken(tokenPresente);
      if (tokenPresente) {
        inicializarSharePoint();
      }
    } else {
      setItems([]);
      setSelectedItem(null);
      setError(null);
    }
  }, [isOpen, inicializarSharePoint]);

  // Navegar para dentro de uma pasta
  const handleAbrirPasta = (item: SharePointItem) => {
    if (!driveId || !item.folder) return;
    const proximoNivel = [...folderStack, { id: item.id, name: item.name }];
    setFolderStack(proximoNivel);
    carregarPasta(driveId, item.id);
  };

  // Botão Voltar (uma pasta acima, até a raiz da biblioteca)
  const handleVoltar = () => {
    if (folderStack.length <= 1 || !driveId) return;
    const novoStack = folderStack.slice(0, folderStack.length - 1);
    setFolderStack(novoStack);
    const alvo = novoStack[novoStack.length - 1];
    carregarPasta(driveId, alvo.id);
  };

  // Clique no Breadcrumb
  const handleNavegarBreadcrumb = (index: number) => {
    if (index === folderStack.length - 1 || !driveId) return;
    const novoStack = folderStack.slice(0, index + 1);
    setFolderStack(novoStack);
    const alvo = novoStack[novoStack.length - 1];
    carregarPasta(driveId, alvo.id);
  };

  // Carregar mais itens (paginação)
  const handleCarregarMais = async () => {
    if (!nextLink || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await carregarProximosItensSharePoint(nextLink);
      setItems((prev) => [...prev, ...res.items]);
      setNextLink(res.nextLink);
    } catch (err: any) {
      setError(err.message || "Erro ao carregar mais itens.");
    } finally {
      setLoadingMore(false);
    }
  };

  // Importar o arquivo selecionado
  const handleImportarArquivo = async () => {
    if (!driveId || !selectedItem || selectedItem.folder || importing) return;

    setImporting(true);
    setError(null);

    // Caminho da pasta formatado para auditoria e metadados no agente
    const folderPath = "/" + folderStack.map((f) => f.name).join("/");
    const fileName = selectedItem.name;
    const mimeHint = selectedItem.file?.mimeType;

    try {
      // 1. Busca o conteúdo com fetch GET /drives/{drive-id}/items/{item-id}/content
      // 2. Lê a resposta com response.blob() mantendo SOMENTE em memória
      // 3. Cria um objeto File em memória com o nome original e tipo
      const file = await obterArquivoSharePointEmMemoria(
        driveId,
        selectedItem.id,
        fileName,
        mimeHint
      );

      // e entregue direto ao mesmo fluxo de processamento usado pelo upload local
      const res = await onImport(file, folderPath);
      if (res && res.warning) {
        setWarning(res.warning);
        setImporting(false);
      } else {
        onClose();
      }
    } catch (err: any) {
      console.error("Erro ao obter arquivo do SharePoint:", err);
      if (err.isWarning || err.code === "ALREADY_EXISTS_SAME_CONVERSATION") {
        setWarning(err.message);
      } else {
        setError(err.message || "Falha ao obter o arquivo do SharePoint.");
      }
      setImporting(false);
    }
  };

  const getFileIcon = (item: SharePointItem) => {
    if (item.folder) {
      return <Folder className="w-5 h-5 text-amber-500 fill-amber-500/20 flex-shrink-0" />;
    }
    const ext = item.name.split(".").pop()?.toLowerCase() || "";
    if (["xlsx", "xls", "csv"].includes(ext)) {
      return <FileSpreadsheet className="w-5 h-5 text-emerald-500 flex-shrink-0" />;
    }
    if (["docx", "doc"].includes(ext)) {
      return <FileText className="w-5 h-5 text-blue-500 flex-shrink-0" />;
    }
    if (["pdf"].includes(ext)) {
      return <FileText className="w-5 h-5 text-rose-500 flex-shrink-0" />;
    }
    return <File className="w-5 h-5 text-slate-400 flex-shrink-0" />;
  };

  const formatSize = (bytes?: number) => {
    if (bytes === undefined || bytes === null) return "--";
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const formatDate = (isoString?: string) => {
    if (!isoString) return "--";
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch {
      return isoString;
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/75 backdrop-blur-xs p-3 sm:p-6 animate-fade-in">
      <div className="relative w-full max-w-4xl h-[640px] max-h-[92vh] bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)] rounded-2xl shadow-2xl flex flex-col overflow-hidden text-[var(--cor-texto)]">
        
        {/* Header do Navegador */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--cor-borda)] bg-[var(--cor-superficie)]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-500 flex-shrink-0">
              <Cloud className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-semibold text-[var(--cor-texto)] flex items-center gap-2">
                <span>Navegador do SharePoint</span>
                <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-400 border border-sky-500/20">
                  Somente Leitura
                </span>
              </h2>
              <p className="text-xs text-[var(--cor-texto-secundario)] flex items-center gap-1.5 mt-0.5">
                <HardDrive className="w-3.5 h-3.5 text-slate-400" />
                <span>{SHAREPOINT_HOSTNAME}{SHAREPOINT_SITE_PATH} • {SHAREPOINT_LIBRARY}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Botão para alternar Painel de Diagnóstico */}
            <button
              type="button"
              onClick={() => setShowDiagnostics((prev) => !prev)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium border transition-all cursor-pointer ${
                showDiagnostics
                  ? "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30 font-semibold"
                  : "text-[var(--cor-texto-secundario)] hover:text-[var(--cor-texto)] hover:bg-[var(--cor-hover)] border-[var(--cor-borda)]"
              }`}
              title={showDiagnostics ? "Recolher painel de diagnóstico" : "Exibir painel de diagnóstico Graph"}
            >
              <Terminal className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Diagnóstico</span>
              {logs.length > 0 && (
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 font-semibold">
                  {logs.length}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                if (driveId) {
                  carregarPasta(driveId, currentFolder.id);
                } else {
                  inicializarSharePoint();
                }
              }}
              disabled={loading || importing}
              className="p-2 rounded-xl text-[var(--cor-texto-secundario)] hover:text-[var(--cor-texto)] hover:bg-[var(--cor-hover)] transition-all cursor-pointer disabled:opacity-50"
              title="Atualizar pasta atual"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin text-[var(--cor-primaria)]" : ""}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={importing}
              className="p-2 rounded-xl text-[var(--cor-texto-secundario)] hover:text-[var(--cor-texto)] hover:bg-[var(--cor-hover)] transition-all cursor-pointer"
              title="Fechar navegador"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* PAINEL DE DIAGNÓSTICO (RECOLHÍVEL) - Chamadas ao Graph */}
        {showDiagnostics && (
          <div className="border-b border-[var(--cor-borda)] bg-slate-950 text-slate-200 flex flex-col max-h-72 overflow-hidden animate-fade-in text-xs">
            <div className="flex items-center justify-between px-4 py-2 bg-slate-900 border-b border-slate-800 text-[11px] text-slate-400">
              <div className="flex items-center gap-2">
                <Terminal className="w-3.5 h-3.5 text-sky-400" />
                <span className="font-semibold text-slate-200">Painel de Diagnóstico do Microsoft Graph</span>
                <span>• {logs.length} requisição(ões) capturada(s)</span>
              </div>
              <div className="flex items-center gap-2">
                {logs.length > 0 && (
                  <button
                    type="button"
                    onClick={clearGraphLogs}
                    className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-slate-800 text-slate-400 hover:text-rose-400 cursor-pointer transition-colors"
                    title="Limpar histórico de chamadas"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>Limpar</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowDiagnostics(false)}
                  className="flex items-center gap-1 p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white cursor-pointer"
                  title="Recolher painel"
                >
                  <ChevronUp className="w-3.5 h-3.5" />
                  <span className="text-[10px]">Recolher</span>
                </button>
              </div>
            </div>

            {/* Informações do Site SharePoint Conectado */}
            {getLastResolvedSite() && (
              <div className="px-4 py-1.5 bg-slate-900/60 border-b border-slate-800 text-[11px] text-slate-300 flex items-center justify-between">
                <div className="truncate">
                  <span className="text-slate-400">Site conectado: </span>
                  <span className="font-semibold text-emerald-400">{getLastResolvedSite()?.name || "Site"}</span>
                  <span className="text-slate-500 ml-2">({getLastResolvedSite()?.webUrl})</span>
                </div>
                <span className="text-[10px] text-slate-400 font-mono ml-2 flex-shrink-0">
                  ID: {getLastResolvedSite()?.id?.split(",")[1]?.substring(0, 8) || getLastResolvedSite()?.id?.substring(0, 8)}...
                </span>
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-3 space-y-2.5 font-mono text-[11px] max-h-60 scrollbar-thin">
              {logs.length === 0 ? (
                <p className="text-slate-500 italic py-2 text-center">Nenhuma chamada ao Graph registrada nesta sessão.</p>
              ) : (
                logs.map((log) => {
                  const isSuccess = log.status >= 200 && log.status < 300;
                  const isWarning = log.status === 404;
                  const statusColor = isSuccess
                    ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                    : isWarning
                    ? "bg-amber-500/20 text-amber-400 border-amber-500/30"
                    : "bg-rose-500/20 text-rose-400 border-rose-500/30";

                  return (
                    <div
                      key={log.id}
                      className="rounded-lg border border-slate-800 bg-slate-900/90 p-2.5 space-y-1.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-1.5 text-[10px]">
                        <div className="flex items-center gap-2">
                          <span className={`px-1.5 py-0.5 rounded font-bold border ${statusColor}`}>
                            {log.status === 0 ? "FALHA REDE" : `HTTP ${log.status}`}
                          </span>
                          <span className="text-slate-400">{log.timestamp}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleCopyLog(log)}
                          className="flex items-center gap-1 text-slate-400 hover:text-slate-200 px-1.5 py-0.5 rounded hover:bg-slate-800 cursor-pointer transition-colors"
                          title="Copiar JSON completo da resposta"
                        >
                          {copiedLogId === log.id ? (
                            <>
                              <Check className="w-3 h-3 text-emerald-400" />
                              <span className="text-emerald-400">Copiado</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3" />
                              <span>Copiar JSON</span>
                            </>
                          )}
                        </button>
                      </div>

                      <div className="text-sky-300 break-all select-all font-mono">
                        <span className="text-slate-500">URL: </span>
                        {log.url}
                      </div>

                      <div className="mt-1 space-y-1">
                        <div className="text-slate-400 text-[10px] font-semibold flex items-center gap-1">
                          <span>JSON de resposta completo:</span>
                        </div>
                        <pre className="p-2 bg-black/60 rounded border border-slate-800 text-slate-300 overflow-x-auto max-h-48 text-[10px] whitespace-pre-wrap break-all">
                          {typeof log.response === "string"
                            ? log.response
                            : JSON.stringify(log.response, null, 2)}
                        </pre>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* Mensagem de Aviso (Duplicidade em âmbar) */}
        {warning && (
          <div className="mx-5 mt-4 flex items-start gap-2.5 p-3 rounded-xl bg-amber-500/10 border border-amber-500/25 text-amber-600 dark:text-amber-400 text-xs animate-fade-in">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-500" />
            <div className="flex-1">
              <p className="font-semibold">{warning}</p>
            </div>
            <button
              type="button"
              onClick={() => setWarning(null)}
              className="text-amber-500/70 hover:text-amber-500 text-xs ml-1 cursor-pointer font-bold"
            >
              ✕
            </button>
          </div>
        )}

        {/* Mensagem de Erro (apenas exibida para erros de rede/permissão com token presente) */}
        {error && hasGraphToken && (
          <div className="mx-5 mt-4 flex items-start gap-2.5 p-3 rounded-xl bg-rose-500/10 border border-rose-500/25 text-rose-500 text-xs animate-shake">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-semibold">{error}</p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    if (driveId) carregarPasta(driveId, currentFolder.id);
                    else inicializarSharePoint();
                  }}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-rose-500/20 hover:bg-rose-500/30 text-rose-700 dark:text-rose-300 font-semibold cursor-pointer transition-colors"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Tentar novamente</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowDiagnostics(true)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-sky-500/15 hover:bg-sky-500/25 text-sky-600 dark:text-sky-400 font-semibold cursor-pointer transition-colors"
                >
                  <Terminal className="w-3 h-3" />
                  <span>Abrir Diagnóstico Graph</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Barra de Navegação: Breadcrumb e Botão Voltar */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-[var(--cor-borda)] bg-[var(--cor-card-fundo)]">
          <button
            type="button"
            onClick={handleVoltar}
            disabled={folderStack.length <= 1 || loading || importing}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-[var(--cor-borda)] bg-[var(--cor-superficie)] hover:bg-[var(--cor-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer flex-shrink-0"
            title={folderStack.length <= 1 ? "Você já está na raiz da biblioteca" : "Voltar uma pasta"}
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Voltar</span>
          </button>

          {/* Breadcrumb da biblioteca até a pasta atual */}
          <div className="flex-1 flex items-center gap-1 overflow-x-auto py-0.5 text-xs font-sans scrollbar-thin">
            {folderStack.map((crumb, idx) => {
              const isLast = idx === folderStack.length - 1;
              return (
                <React.Fragment key={`${crumb.id || "root"}_${idx}`}>
                  {idx > 0 && <ChevronRight className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />}
                  <button
                    type="button"
                    onClick={() => handleNavegarBreadcrumb(idx)}
                    disabled={isLast || loading || importing}
                    className={`px-2 py-1 rounded-md transition-colors truncate max-w-[200px] flex-shrink-0 ${
                      isLast
                        ? "font-semibold text-[var(--cor-texto)] bg-[var(--cor-superficie)] border border-[var(--cor-borda)]"
                        : "text-[var(--cor-primaria)] hover:text-[var(--cor-texto)] hover:bg-[var(--cor-hover)] cursor-pointer"
                    }`}
                    title={crumb.name}
                  >
                    {idx === 0 && <Folder className="w-3.5 h-3.5 inline mr-1 text-amber-500" />}
                    {crumb.name}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
        </div>

        {/* Tabela / Lista de Itens */}
        <div className="flex-1 overflow-y-auto min-h-[300px] max-h-[500px]">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-64 gap-3 text-[var(--cor-texto-secundario)]">
              <div className="w-8 h-8 border-2 border-[var(--cor-primaria)] border-t-transparent rounded-full animate-spin" />
              <p className="text-xs font-medium">Carregando conteúdo do SharePoint...</p>
            </div>
          ) : !hasGraphToken ? (
            <div className="flex flex-col items-center justify-center h-72 text-center p-6 space-y-4">
              <div className="w-16 h-16 rounded-2xl bg-sky-500/10 flex items-center justify-center text-[#00a4ef]">
                <Cloud className="w-8 h-8 stroke-[1.5]" />
              </div>
              <div className="max-w-md">
                <h3 className="text-sm font-semibold text-[var(--cor-texto)]">Autenticação Microsoft necessária</h3>
                <p className="text-xs text-[var(--cor-texto-secundario)] mt-1.5 leading-relaxed">
                  Para navegar nas pastas dos projetos e importar documentos diretamente do SharePoint da BITI9, conecte sua conta Microsoft.
                </p>
                {error && (
                  <div className="mt-3 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-500 text-left space-y-1">
                    <div className="font-semibold flex items-center gap-1.5">
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      <span>Aviso de Conexão</span>
                    </div>
                    <p className="leading-relaxed">{error}</p>
                    {error.includes("não está autorizado") && (
                      <p className="text-[11px] text-[var(--cor-texto-secundario)] pt-1 border-t border-rose-500/20">
                        Dica: Acesse <strong>Firebase Console &gt; Authentication &gt; Settings &gt; Authorized domains</strong> e adicione o domínio ou IP exibido acima.
                      </p>
                    )}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={handleReautenticarMicrosoft}
                disabled={reauthenticating}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#00a4ef] hover:bg-[#0092d6] text-white text-xs font-semibold cursor-pointer transition-all shadow-sm hover:shadow"
              >
                {reauthenticating ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Conectando à Microsoft...</span>
                  </>
                ) : (
                  <>
                    <Cloud className="w-4 h-4" />
                    <span>Reautenticar com Microsoft</span>
                  </>
                )}
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-center p-6 text-[var(--cor-texto-secundario)]">
              <Folder className="w-12 h-12 stroke-[1.2] text-slate-300 dark:text-slate-600 mb-2" />
              <p className="text-sm font-medium text-[var(--cor-texto)]">Esta pasta está vazia</p>
              <p className="text-xs text-[var(--cor-texto-secundario)] mt-1">
                Nenhum documento ou subpasta foi encontrado nesta localização.
              </p>
            </div>
          ) : (
            <table className="w-full text-left text-xs border-collapse">
              <thead className="sticky top-0 bg-[var(--cor-superficie)] border-b border-[var(--cor-borda)] text-[var(--cor-texto-secundario)] font-semibold select-none z-10">
                <tr>
                  <th className="py-2.5 px-4 w-10 text-center"></th>
                  <th className="py-2.5 px-3">Nome</th>
                  <th className="py-2.5 px-4 w-40 hidden sm:table-cell">Modificado em</th>
                  <th className="py-2.5 px-4 w-24 text-right">Tamanho</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--cor-borda)]">
                {items.map((item) => {
                  const isFolder = !!item.folder;
                  const isSelected = selectedItem?.id === item.id;

                  return (
                    <tr
                      key={item.id}
                      onClick={() => {
                        if (isFolder) {
                          handleAbrirPasta(item);
                        } else {
                          setSelectedItem(isSelected ? null : item);
                        }
                      }}
                      className={`transition-colors cursor-pointer select-none group ${
                        isSelected
                          ? "bg-[var(--cor-primaria-clara)] text-[var(--cor-texto)]"
                          : "hover:bg-[var(--cor-hover)]"
                      }`}
                    >
                      {/* Ícone ou Seleção */}
                      <td className="py-3 px-4 text-center">
                        {isFolder ? (
                          getFileIcon(item)
                        ) : (
                          <div className="flex items-center justify-center">
                            <input
                              type="radio"
                              name="selected_sharepoint_file"
                              checked={isSelected}
                              onChange={() => setSelectedItem(item)}
                              onClick={(e) => e.stopPropagation()}
                              className="w-4 h-4 text-[var(--cor-primaria)] cursor-pointer"
                            />
                          </div>
                        )}
                      </td>

                      {/* Nome do Item */}
                      <td className="py-3 px-3">
                        <div className="flex items-center gap-2">
                          {!isFolder && getFileIcon(item)}
                          <span
                            className={`font-medium truncate max-w-[260px] sm:max-w-md ${
                              isFolder
                                ? "text-[var(--cor-texto)] group-hover:text-[var(--cor-primaria)] font-semibold"
                                : ""
                            }`}
                            title={item.name}
                          >
                            {item.name}
                          </span>
                          {isFolder && (
                            <span className="text-[10px] text-[var(--cor-texto-secundario)] bg-[var(--cor-superficie)] px-1.5 py-0.5 rounded border border-[var(--cor-borda)]">
                              {item.folder?.childCount ?? 0} {item.folder?.childCount === 1 ? "item" : "itens"}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Data de Modificação */}
                      <td className="py-3 px-4 text-[var(--cor-texto-secundario)] hidden sm:table-cell">
                        {formatDate(item.lastModifiedDateTime)}
                      </td>

                      {/* Tamanho */}
                      <td className="py-3 px-4 text-right text-[var(--cor-texto-secundario)] font-mono">
                        {isFolder ? "--" : formatSize(item.size)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Botão de Paginação se houver @odata.nextLink */}
          {nextLink && (
            <div className="p-3 text-center border-t border-[var(--cor-borda)] bg-[var(--cor-superficie)]">
              <button
                type="button"
                onClick={handleCarregarMais}
                disabled={loadingMore}
                className="px-4 py-1.5 text-xs font-medium rounded-lg border border-[var(--cor-borda)] bg-[var(--cor-card-fundo)] hover:bg-[var(--cor-hover)] text-[var(--cor-texto)] transition-all cursor-pointer inline-flex items-center gap-2"
              >
                {loadingMore ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-[var(--cor-primaria)]" />
                    <span>Carregando mais itens...</span>
                  </>
                ) : (
                  <span>Carregar mais itens</span>
                )}
              </button>
            </div>
          )}
        </div>

        {/* Rodapé: Ações e Botão de Importação */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-5 py-3.5 border-t border-[var(--cor-borda)] bg-[var(--cor-superficie)]">
          <div className="text-xs text-[var(--cor-texto-secundario)] truncate max-w-full">
            {selectedItem ? (
              <span className="flex items-center gap-1.5 text-[var(--cor-texto)] font-medium">
                <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                <span className="truncate">Selecionado: <strong>{selectedItem.name}</strong> ({formatSize(selectedItem.size)})</span>
              </span>
            ) : (
              <span>
                {loadingTypes
                  ? "Carregando tipos permitidos..."
                  : `Selecione um documento de um dos tipos permitidos: ${activeSiglas.join(", ")}`}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2.5 w-full sm:w-auto">
            <button
              type="button"
              onClick={onClose}
              disabled={importing}
              className="flex-1 sm:flex-initial px-4 py-2 text-xs font-semibold rounded-xl border border-[var(--cor-borda)] hover:bg-[var(--cor-hover)] text-[var(--cor-texto)] transition-all cursor-pointer disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleImportarArquivo}
              disabled={!selectedItem || !!selectedItem.folder || importing}
              className="flex-1 sm:flex-initial flex items-center justify-center gap-2 px-5 py-2 bg-[var(--cor-balaousuario-fundo)] hover:opacity-90 text-white text-xs font-semibold rounded-xl shadow-xs transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {importing ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Importando para a memória...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Importar arquivo</span>
                </>
              )}
            </button>
          </div>
        </div>

      </div>
    </div>,
    document.body
  );
}
