import React, { useState, useEffect, useRef } from "react";
import { 
  FileText, 
  FileSpreadsheet, 
  File, 
  Plus, 
  Trash2, 
  CheckSquare, 
  Square, 
  RefreshCw, 
  HelpCircle,
  Sparkles,
  Layers,
  CheckCircle,
  XCircle,
  AlertCircle,
  AlertTriangle,
  Folder,
  Cloud,
  ChevronDown,
  X,
  Check,
  Building2,
  ExternalLink
} from "lucide-react";
import { ClientGroup, PDDDocument } from "../types";
import SharePointBrowserModal from "./SharePointBrowserModal";
import ExtractedContentModal from "./ExtractedContentModal";
import { apiFetch } from "../services/api";
import { auth } from "../firebase";

interface SourcesPanelProps {
  clientGroups: ClientGroup[];
  selectedFileIds: string[];
  onToggleFile: (fileId: string) => void;
  onToggleAll: (checked: boolean) => void;
  onRefresh: () => void;
  userEmail: string;
  activeSessionId?: string;
  loading?: boolean;
}

export default function SourcesPanel({
  clientGroups,
  selectedFileIds,
  onToggleFile,
  onToggleAll,
  onRefresh,
  userEmail,
  activeSessionId = "default_session",
  loading = false
}: SourcesPanelProps) {
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{ message: string; type: "success" | "error" | "warning" | null }>({
    message: "",
    type: null
  });
  const [uploadProgress, setUploadProgress] = useState<{
    percent: number;
    statusText: string;
    files: { [fileName: string]: { progress: number; status: "pending" | "uploading" | "success" | "error" | "warning"; attempt?: number; error?: string } };
  }>({
    percent: 0,
    statusText: "",
    files: {}
  });
  const [versionConflict, setVersionConflict] = useState<{
    file: File;
    metadata?: { origin?: string; folderPath?: string; action?: "replace" | "keep_both" };
    existingFileName: string;
    message?: string;
  } | null>(null);
  const [localDeletedFileIds, setLocalDeletedFileIds] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [visibleLimit, setVisibleLimit] = useState(50);
  const [failedFiles, setFailedFiles] = useState<File[]>([]);

  // Estados para Menu de Origem e Modal SharePoint
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [showSharePointBrowser, setShowSharePointBrowser] = useState(false);
  const [activeSiglas, setActiveSiglas] = useState<string[]>([]);
  const [loadingTypes, setLoadingTypes] = useState(true);
  const [previewFile, setPreviewFile] = useState<PDDDocument | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoadingTypes(true);
    apiFetch("/api/settings/document-types/active")
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data.siglas) && data.siglas.length > 0) {
          setActiveSiglas(data.siglas);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingTypes(false));
  }, []);

  // Fechar menu de adicionar ao clicar fora
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(event.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Sync / reset temporary local deletions when new database client groups load
  useEffect(() => {
    setLocalDeletedFileIds([]);
  }, [clientGroups]);

  // Reset the visible limit whenever the search query changes
  useEffect(() => {
    setVisibleLimit(50);
  }, [searchQuery]);

  // Flat list of files from client groups
  const files: PDDDocument[] = [];
  clientGroups.forEach(client => {
    client.robots.forEach(robot => {
      robot.documents.forEach(doc => {
        if (!localDeletedFileIds.includes(doc.id)) {
          files.push(doc);
        }
      });
    });
  });

  const filteredFiles = files.filter(f => {
    const query = searchQuery.toLowerCase();
    return (
      f.name.toLowerCase().includes(query) ||
      f.clientName.toLowerCase().includes(query) ||
      f.robotName.toLowerCase().includes(query)
    );
  });

  const allSelected = filteredFiles.length > 0 && filteredFiles.every(f => selectedFileIds.includes(f.id));
  const someSelected = filteredFiles.length > 0 && filteredFiles.some(f => selectedFileIds.includes(f.id)) && !allSelected;

  const getFileIcon = (fileName: string, origin?: string) => {
    if (origin === "SharePoint" || fileName.includes("[SharePoint]")) {
      return <Cloud className="w-4 h-4 text-sky-500 flex-shrink-0" />;
    }
    const ext = fileName.split(".").pop()?.toLowerCase() || "";
    if (["xlsx", "xls", "csv"].includes(ext)) {
      return <FileSpreadsheet className="w-4 h-4 text-emerald-400 flex-shrink-0" />;
    }
    if (["pdf", "docx", "doc"].includes(ext)) {
      return <FileText className="w-4 h-4 text-blue-400 flex-shrink-0" />;
    }
    return <File className="w-4 h-4 text-slate-400 flex-shrink-0" />;
  };

  const handleImportSharePointFile = async (file: File, folderPath: string) => {
    // Entrega o arquivo em memória direto ao mesmo fluxo de processamento usado pelo upload local:
    await handleUploadFiles([file], { origin: "SharePoint", folderPath });
  };

  const readFileAsBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      if (!file || !(file instanceof Blob) || file.size === 0) {
        return reject(new Error("Selecione o arquivo novamente."));
      }
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        if (!result) {
          return reject(new Error("Selecione o arquivo novamente."));
        }
        const base64 = result.split(',')[1];
        if (!base64) {
          return reject(new Error("Selecione o arquivo novamente."));
        }
        resolve(base64);
      };
      reader.onerror = () => reject(new Error("Selecione o arquivo novamente."));
      try {
        reader.readAsDataURL(file);
      } catch {
        reject(new Error("Selecione o arquivo novamente."));
      }
    });
  };

  const handleResolveVersionConflict = async (action: "replace" | "keep_both") => {
    if (!versionConflict) return;
    const target = { ...versionConflict };
    setVersionConflict(null);
    await handleUploadFiles([target.file], {
      ...target.metadata,
      action
    });
  };

  const handleUploadFiles = async (
    fileList: FileList | File[],
    metadata?: { origin?: string; folderPath?: string; action?: "replace" | "keep_both" }
  ) => {
    const filesArray = Array.from(fileList);
    if (filesArray.length === 0) return;

    setUploading(true);
    setUploadStatus({ message: "", type: null });

    const initialFilesState: { [fileName: string]: { progress: number; status: "pending" | "uploading" | "success" | "error" | "warning"; attempt?: number; error?: string } } = {};
    filesArray.forEach(file => {
      initialFilesState[file.name] = { progress: 0, status: "pending", attempt: 1 };
    });

    const isSharePoint = metadata?.origin === "SharePoint";

    setUploadProgress({
      percent: 0,
      statusText: isSharePoint
        ? `Indexando "${filesArray[0]?.name}" do SharePoint (${metadata?.folderPath || "Projetos"})...`
        : `Preparando ${filesArray.length} arquivo(s) para indexação...`,
      files: initialFilesState
    });

    const updateFileProgress = (
      fileName: string,
      progress: number,
      status: "pending" | "uploading" | "success" | "error" | "warning",
      attempt: number = 1,
      errorMsg?: string
    ) => {
      setUploadProgress(prev => {
        const nextFiles = {
          ...prev.files,
          [fileName]: { progress, status, attempt, error: errorMsg }
        };
        const keys = Object.keys(nextFiles);
        const sum = keys.reduce((acc, name) => acc + (nextFiles[name]?.progress || 0), 0);
        const avgPercent = Math.round(sum / keys.length);

        const completed = keys.filter(name => nextFiles[name]?.status === "success" || nextFiles[name]?.status === "error" || nextFiles[name]?.status === "warning").length;
        const statusText = completed === keys.length 
          ? "Indexação de lote finalizada" 
          : `Indexando arquivo ${completed + 1} de ${keys.length}...`;

        return {
          percent: avgPercent,
          statusText,
          files: nextFiles
        };
      });
    };

    const uploadSingleFileWithRetry = async (file: File) => {
      if (!file || !(file instanceof Blob) || file.size === 0) {
        updateFileProgress(file?.name || "Arquivo", 100, "error", 1, "Selecione o arquivo novamente.");
        const missingErr = new Error("Selecione o arquivo novamente.");
        (missingErr as any).isMissingContent = true;
        throw missingErr;
      }

      const ext = '.' + file.name.split('.').pop()?.toLowerCase();
      const validExtensions = ['.png', '.jpg', '.jpeg', '.pdf', '.xlsx', '.xls', '.docx', '.doc', '.csv', '.txt'];

      if (!validExtensions.includes(ext) && !file.type.startsWith("image/")) {
        updateFileProgress(file.name, 100, "error", 1, `Formato "${ext}" não suportado.`);
        throw new Error(`Formato de arquivo "${ext}" não suportado.`);
      }

      const MAX_RETRIES = 3;
      let lastError: any = null;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        updateFileProgress(file.name, 5, "uploading", attempt);

        // Progress animation simulation for ultra-responsive interface
        let currentProgress = 5;
        const interval = setInterval(() => {
          if (currentProgress < 85) {
            currentProgress += Math.floor(Math.random() * 10) + 5;
          } else if (currentProgress < 95) {
            currentProgress += 1;
          }
          updateFileProgress(file.name, Math.min(currentProgress, 95), "uploading", attempt);
        }, 350);

        try {
          const base64 = await readFileAsBase64(file);
          
          const res = await apiFetch("/api/db/add-source", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: file.name,
              type: file.type || 'application/octet-stream',
              base64,
              conversationId: activeSessionId,
              origin: metadata?.origin || "Upload Direto",
              folderPath: metadata?.folderPath || "",
              originalName: file.name,
              action: metadata?.action
            })
          });

          clearInterval(interval);

          const data = await res.json().catch(() => ({}));

          if (res.status === 409) {
            if (data.code === "NEW_VERSION") {
              setVersionConflict({
                file,
                metadata,
                existingFileName: data.existingFileName || file.name,
                message: data.message
              });
              updateFileProgress(file.name, 100, "warning", attempt, "Nova versão detectada. Aguardando decisão.");
              return { type: "new_version", name: file.name };
            }

            // Regra a: duplicidade na mesma conversa
            const warnMsg = data.message || `Este documento já foi importado nesta conversa.`;
            updateFileProgress(file.name, 100, "warning", attempt, warnMsg);
            const warnObj = new Error(warnMsg);
            (warnObj as any).isWarning = true;
            (warnObj as any).code = data.code || "ALREADY_EXISTS_SAME_CONVERSATION";
            throw warnObj;
          }

          if (!res.ok) {
            let msg = data.erro || data.error || "Erro ao processar o arquivo.";
            if (data.justificativa) {
              msg = `${msg} ${data.justificativa}`;
            }
            const errObj = new Error(msg);
            if (res.status === 422) {
              (errObj as any).isValidationError = true;
            }
            throw errObj;
          }

          if (data.reused) {
            updateFileProgress(file.name, 100, "success", attempt, data.message);
            return { type: "reused", name: file.name, message: data.message };
          }

          updateFileProgress(file.name, 100, "success", attempt);
          return { type: "success", name: file.name };
        } catch (err: any) {
          clearInterval(interval);
          const errorMsg = err.message || "Falha na indexação.";
          lastError = err;
          
          if (err.isWarning || err.isValidationError || err.isMissingContent || err.message === "Selecione o arquivo novamente." || attempt >= MAX_RETRIES) {
            if (err.isWarning) {
              updateFileProgress(file.name, 100, "warning", attempt, errorMsg);
            } else {
              updateFileProgress(file.name, 100, "error", attempt, errorMsg);
            }
            break;
          } else {
            const delay = attempt * 1200; // exponential/progressive backoff
            updateFileProgress(
              file.name, 
              currentProgress, 
              "uploading", 
              attempt, 
              `Falhou (Tentativa ${attempt}/${MAX_RETRIES}). Re-tentando em ${(delay / 1000).toFixed(1)}s...`
            );
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }

      throw lastError;
    };

    // CONTROLE DE CONCORRÊNCIA: Fila de processamento concorrente limitado a no máximo 3 uploads paralelos
    const CONCURRENCY = 3;
    const results: { status: "fulfilled" | "rejected"; value?: any; reason?: any }[] = Array(filesArray.length);
    let nextIndex = 0;

    const runWorker = async () => {
      while (nextIndex < filesArray.length) {
        const currentIndex = nextIndex++;
        const file = filesArray[currentIndex];
        try {
          const resVal = await uploadSingleFileWithRetry(file);
          results[currentIndex] = { status: "fulfilled", value: resVal };
        } catch (err) {
          results[currentIndex] = { status: "rejected", reason: err };
        }
      }
    };

    const activeWorkers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(CONCURRENCY, filesArray.length); i++) {
      activeWorkers.push(runWorker());
    }

    await Promise.all(activeWorkers);

    const succeeded = results.filter(r => r.status === "fulfilled" && (r.value as any)?.type === "success").length;
    const reusedItems = results.filter(r => r.status === "fulfilled" && (r.value as any)?.type === "reused");
    const newVersions = results.filter(r => r.status === "fulfilled" && (r.value as any)?.type === "new_version");
    const warnings = results.filter(r => r.status === "rejected" && r.reason?.isWarning);
    const hardFails = results.filter(r => r.status === "rejected" && !r.reason?.isWarning);
    const errors = results
      .filter(r => r.status === "rejected" && !r.reason?.isWarning)
      .map(r => r.reason?.message || "Erro desconhecido");
    const lastErrorMessage = errors[errors.length - 1] || "";

    const failedFileList: File[] = [];
    results.forEach((r, idx) => {
      if (r.status === "rejected" && !r.reason?.isWarning) {
        failedFileList.push(filesArray[idx]);
      }
    });
    setFailedFiles(failedFileList);

    let returnResult = { success: true, warning: undefined as string | undefined, error: undefined as string | undefined };

    if (newVersions.length > 0) {
      returnResult = { success: true, warning: undefined, error: undefined };
    } else if (reusedItems.length > 0 && hardFails.length === 0 && warnings.length === 0) {
      const msg = (reusedItems[0].value as any)?.message || "Documento já processado anteriormente. Reaproveitado sem novo processamento.";
      setUploadStatus({
        message: msg,
        type: "warning"
      });
      returnResult = { success: true, warning: msg, error: undefined };
    } else if (warnings.length > 0 && hardFails.length === 0) {
      const warnMsg = warnings[0].reason?.message || "Documento já importado nesta conversa.";
      setUploadStatus({
        message: warnMsg,
        type: "warning"
      });
      returnResult = { success: false, warning: warnMsg, error: undefined };
    } else if (succeeded > 0 && hardFails.length === 0) {
      setUploadStatus({
        message: metadata?.origin === "SharePoint"
          ? `Documento "${filesArray[0].name}" importado do SharePoint e carregado com sucesso!`
          : succeeded === 1 
          ? `"${filesArray[0].name}" indexado com sucesso!` 
          : `${succeeded} fontes de consulta indexadas com sucesso!`,
        type: "success"
      });
      returnResult = { success: true, warning: undefined, error: undefined };
    } else if (succeeded > 0 && hardFails.length > 0) {
      setUploadStatus({
        message: `${succeeded} indexados com sucesso, ${hardFails.length} falharam.`,
        type: "warning"
      });
      returnResult = { success: true, warning: `${succeeded} indexados com sucesso, ${hardFails.length} falharam.`, error: undefined };
    } else if (hardFails.length > 0) {
      const errorMsg = `Falha ao indexar arquivos. Erro: ${lastErrorMessage || "Formatos de arquivos não suportados"}`;
      setUploadStatus({
        message: errorMsg,
        type: "error"
      });
      returnResult = { success: false, warning: undefined, error: errorMsg };
    }

    setUploading(false);
    onRefresh();
    return returnResult;
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files;
    if (selectedFiles && selectedFiles.length > 0) {
      handleUploadFiles(selectedFiles);
    }
    e.target.value = "";
  };

  const handleDelete = async (e: React.MouseEvent, fileId: string) => {
    e.stopPropagation(); // Impede que o clique selecione/desselecione o card

    // Localiza o nome do documento antes de deletar
    const doc = files.find(f => f.id === fileId);
    const fileName = doc ? doc.name : "Documento";

    // Remove instantaneamente do estado local para latência zero
    setLocalDeletedFileIds(prev => [...prev, fileId]);

    try {
      const res = await apiFetch("/api/db/delete-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId, conversationId: activeSessionId })
      });

      if (res.ok) {
        setUploadStatus({ message: `Fonte "${fileName}" excluída com sucesso.`, type: "success" });
        onRefresh();
      } else {
        const data = await res.json().catch(() => ({}));
        // Reverte deleção instantânea caso falhe
        setLocalDeletedFileIds(prev => prev.filter(id => id !== fileId));
        throw new Error(data.error || "Falha ao excluir.");
      }
    } catch (err: any) {
      setLocalDeletedFileIds(prev => prev.filter(id => id !== fileId));
      setUploadStatus({ message: err.message || "Erro ao remover.", type: "error" });
    }
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleUploadFiles(e.dataTransfer.files);
    }
  };

  return (
    <div className="w-80 bg-[var(--cor-superficie)] border-r border-[var(--cor-borda)] flex flex-col h-full text-[var(--cor-texto)] z-10">
      
      {/* Header do Painel */}
      <div className="p-4 border-b border-[var(--cor-borda)] bg-[var(--cor-card-fundo)] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-[var(--cor-primaria)]" />
          <span className="text-sm font-semibold text-[var(--cor-texto)]">
            Fontes de consulta
          </span>
          <span className="text-xs text-[var(--cor-texto-secundario)] font-normal ml-0.5" title="Capacidade expandida para até 500 fontes simultâneas">
            ({files.filter(f => selectedFileIds.includes(f.id)).length}/500 arquivos)
          </span>
        </div>
      </div>

      {/* Botão Adicionar Fontes com Seletor de Arquivos e SharePoint */}
      <div className="p-4 border-b border-[var(--cor-borda)] bg-[var(--cor-superficie)] space-y-2.5 relative">
        <input 
          type="file" 
          ref={fileInputRef}
          onChange={handleFileChange}
          multiple
          accept=".pdf,.docx,.doc,.xlsx,.xls,.csv,.txt,image/*"
          className="hidden" 
        />
        
        {/* Menu Principal de Adicionar */}
        <div className="relative" ref={addMenuRef}>
          <button
            type="button"
            onClick={() => setAddMenuOpen(prev => !prev)}
            disabled={uploading}
            className="w-full flex items-center justify-between gap-2 bg-[var(--cor-balaousuario-fundo)] hover:opacity-95 disabled:opacity-50 text-white text-xs font-semibold py-2.5 px-3 rounded-lg transition-all shadow-xs cursor-pointer"
          >
            <div className="flex items-center gap-2">
              {uploading ? (
                <RefreshCw className="w-4 h-4 animate-spin text-white" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              <span>{uploading ? `Indexando: ${uploadProgress.percent}%` : "Adicionar fontes"}</span>
            </div>
            <ChevronDown className={`w-3.5 h-3.5 text-white transition-transform ${addMenuOpen ? "rotate-180" : ""}`} />
          </button>

          {/* Menu Suspenso de Opções */}
          {addMenuOpen && (
            <div className="absolute top-full left-0 right-0 mt-1.5 bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)] rounded-xl shadow-xl p-1.5 z-40 animate-fade-in">
              {/* Opção 1: Arquivo local */}
              <button
                type="button"
                onClick={() => {
                  setAddMenuOpen(false);
                  fileInputRef.current?.click();
                }}
                className="w-full flex items-start gap-2.5 p-2 rounded-lg hover:bg-[var(--cor-hover)] text-left transition-colors cursor-pointer group"
              >
                <div className="p-1.5 rounded-md bg-[var(--cor-primaria-clara)] text-[var(--cor-primaria)] mt-0.5">
                  <Folder className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-xs font-semibold text-[var(--cor-texto)] flex items-center gap-1.5">
                    <span>Arquivo local</span>
                  </div>
                  <div className="text-[10px] text-[var(--cor-texto-secundario)]">
                    Upload de arquivos do seu computador
                  </div>
                </div>
              </button>

              <div className="my-1 border-t border-[var(--cor-borda)]" />

              {/* Opção 2: SharePoint */}
              <button
                type="button"
                onClick={() => {
                  setAddMenuOpen(false);
                  setShowSharePointBrowser(true);
                }}
                className="w-full flex items-start gap-2.5 p-2 rounded-lg hover:bg-[var(--cor-hover)] text-left transition-colors cursor-pointer group"
              >
                <div className="p-1.5 rounded-md bg-sky-500/10 text-sky-500 mt-0.5">
                  <Cloud className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-xs font-semibold text-[var(--cor-texto)] flex items-center gap-1.5">
                    <span>SharePoint</span>
                    <span className="text-[9px] bg-sky-500/15 text-sky-600 dark:text-sky-400 px-1 rounded border border-sky-500/20 font-medium">
                      Microsoft Graph
                    </span>
                  </div>
                  <div className="text-[10px] text-[var(--cor-texto-secundario)]">
                    Navegador de pastas do site corporativo
                  </div>
                </div>
              </button>
            </div>
          )}
        </div>

        {/* Drag and drop target área minimalista */}
        <div
          onDragEnter={handleDrag}
          onDragOver={handleDrag}
          onDragLeave={handleDrag}
          onDrop={handleDrop}
          className={`border border-dashed rounded-lg p-2.5 text-center transition-colors cursor-pointer ${
            dragActive 
              ? "border-[var(--cor-primaria)] bg-[var(--cor-primaria-clara)] text-[var(--cor-primaria)]" 
              : "border-[var(--cor-borda)] hover:border-[var(--cor-borda-primaria)] bg-[var(--cor-card-fundo)] text-[var(--cor-texto-secundario)]"
          }`}
          onClick={() => fileInputRef.current?.click()}
        >
          <span className="text-[10px] font-sans block leading-relaxed">
            {loadingTypes
              ? "Carregando tipos permitidos..."
              : `Arraste arquivos dos tipos permitidos (${activeSiglas.join(", ")}) aqui`}
          </span>
        </div>

        {/* Indicador de progresso geral do lote */}
        {uploading && (
          <div className="p-2.5 rounded-lg border border-[var(--cor-borda-primaria)] bg-[var(--cor-primaria-clara)] space-y-2">
            <div className="flex items-center justify-between text-xs font-medium text-[var(--cor-texto)]">
              <span className="truncate pr-1 text-[var(--cor-texto-secundario)]">
                {uploadProgress.statusText}
              </span>
              <span className="text-[var(--cor-primaria)] font-semibold">{uploadProgress.percent}%</span>
            </div>
            <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
              <div 
                className="bg-[#0F2942] h-full rounded-full transition-all duration-300 ease-out"
                style={{ width: `${uploadProgress.percent}%` }}
              />
            </div>
          </div>
        )}

        {/* Notificação sutil de status de upload */}
        {uploadStatus.type && (
          <div className={`p-2 rounded text-[10px] flex items-start gap-1.5 leading-snug border ${
            uploadStatus.type === "success" 
              ? "bg-emerald-950/20 border-emerald-500/20 text-emerald-400" 
              : uploadStatus.type === "warning"
              ? "bg-amber-500/10 border-amber-500/25 text-amber-500 dark:text-amber-400"
              : "bg-rose-950/20 border-rose-500/20 text-rose-400"
          }`}>
            {uploadStatus.type === "success" ? (
              <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-emerald-400 animate-bounce" />
            ) : uploadStatus.type === "warning" ? (
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-amber-500" />
            ) : (
              <XCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            )}
            <div className="flex-1 min-w-0">
              <span className="block whitespace-normal break-words font-medium">{uploadStatus.message}</span>
            </div>
            <button 
              onClick={() => setUploadStatus({ message: "", type: null })}
              className="text-slate-500 hover:text-slate-300 ml-1 font-mono text-[9px] cursor-pointer"
            >
              ✕
            </button>
          </div>
        )}

        {/* Alerta de arquivos que falharam e botão para tentar reindexar */}
        {failedFiles.length > 0 && !uploading && (
          <div className="p-2.5 rounded-lg border border-rose-500/20 bg-rose-500/5 space-y-2 flex flex-col">
            <div className="flex items-start gap-2 text-[10px] text-rose-400">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 text-rose-400 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-rose-400">{failedFiles.length} arquivo(s) falharam na indexação.</p>
                <p className="text-[9px] text-slate-400 leading-normal">Ocorreu um erro no processamento. Clique abaixo para reindexá-los.</p>
              </div>
            </div>
            <button
              onClick={async () => {
                const arquivosComConteudo = failedFiles.filter(f => f && f instanceof Blob && f.size > 0);
                if (arquivosComConteudo.length === 0) {
                  setUploadStatus({
                    message: "Selecione o arquivo novamente.",
                    type: "error"
                  });
                  setFailedFiles([]);
                  return;
                }
                // 2. "Tentar reindexar falhos" deve passar por apiFetch no momento do clique, sem reutilizar token antigo
                if (auth.currentUser) {
                  try {
                    await auth.currentUser.getIdToken(true);
                  } catch (e) {
                    console.warn("[reindex] Falha ao renovar token no clique:", e);
                  }
                }
                handleUploadFiles(arquivosComConteudo);
              }}
              className="w-full flex items-center justify-center gap-1.5 bg-rose-600 hover:bg-rose-500 text-white text-[10px] font-semibold py-1.5 px-3 rounded-md transition-all self-end cursor-pointer font-sans"
            >
              <RefreshCw className="w-3 h-3 animate-pulse" />
              <span>Tentar reindexar falhos ({failedFiles.length})</span>
            </button>
          </div>
        )}
      </div>

      {/* Campo de Busca Rápida / Filtro */}
      <div className="px-4 py-2 border-b border-[var(--cor-borda)] bg-[var(--cor-card-fundo)]">
        <div className="relative">
          <input
            type="text"
            placeholder="Buscar fontes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-[var(--cor-superficie)] border border-[var(--cor-borda)] rounded-lg px-3 py-1.5 pl-8 text-xs text-[var(--cor-texto)] placeholder-[var(--cor-texto-secundario)] focus:outline-none focus:border-[var(--cor-primaria)] focus:bg-[var(--cor-card-fundo)] transition-colors"
          />
          <span className="absolute left-2.5 top-2.5 text-[var(--cor-texto-secundario)]">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </span>
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2.5 top-2.5 text-[var(--cor-texto-secundario)] hover:text-[var(--cor-texto)] text-[10px]"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Opção Global: Selecionar Tudo */}
      {filteredFiles.length > 0 && (
        <div className="p-3 bg-[var(--cor-card-fundo)] border-b border-[var(--cor-borda)] flex items-center justify-between text-xs font-medium text-[var(--cor-texto)]">
          <button 
            onClick={() => onToggleAll(!allSelected)}
            className="flex items-center gap-2 hover:text-[var(--cor-primaria)] transition-colors cursor-pointer select-none"
          >
            {allSelected ? (
              <CheckSquare className="w-4 h-4 text-[var(--cor-primaria)]" />
            ) : someSelected ? (
              <CheckSquare className="w-4 h-4 text-[var(--cor-primaria)] opacity-60" />
            ) : (
              <Square className="w-4 h-4 text-[var(--cor-texto-secundario)] hover:text-[var(--cor-primaria)]" />
            )}
            <span>Selecionar tudo</span>
          </button>
          <span className="text-xs text-[var(--cor-texto-secundario)] font-normal">
            {filteredFiles.length} de {files.length} arquivos
          </span>
        </div>
      )}

      {/* Lista de Documentos */}
      <div 
        className="flex-1 overflow-y-auto p-2 space-y-1.5 custom-scrollbar"
        onScroll={(e) => {
          const target = e.currentTarget;
          if (target.scrollHeight - target.scrollTop <= target.clientHeight + 80) {
            setVisibleLimit(prev => Math.min(prev + 50, filteredFiles.length));
          }
        }}
      >
        {/* Skeleton Loader Sutil durante o carregamento das fontes da conversa */}
        {loading ? (
          <div className="p-1 space-y-2">
            {[1, 2, 3, 4].map((idx) => (
              <div 
                key={idx}
                className="flex items-center justify-between p-2.5 rounded-lg bg-white/[0.02] border border-white/5 animate-pulse"
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <div className="w-4 h-4 rounded bg-slate-800/80 flex-shrink-0" />
                  <div className="w-4 h-4 rounded bg-blue-500/20 flex-shrink-0" />
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="h-3 bg-slate-800/90 rounded w-3/4" />
                    <div className="h-2 bg-slate-800/50 rounded w-1/2" />
                  </div>
                </div>
                <div className="w-8 h-3 bg-slate-800/60 rounded flex-shrink-0" />
              </div>
            ))}
            <div className="text-center py-3 text-[10px] text-blue-400 font-mono flex items-center justify-center gap-2 bg-blue-500/5 border border-blue-500/10 rounded-lg animate-pulse mt-2">
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-400" />
              <span>Carregando fontes da conversa...</span>
            </div>
          </div>
        ) : (
          <>
            {/* Cards Temporários de Indexação Paralela Ativa */}
            {uploading && Object.entries(uploadProgress.files).map(([name, val]) => {
              const info = val as { progress: number; status: "pending" | "uploading" | "success" | "error" | "warning"; attempt?: number; error?: string };
              if (info.status === "success") return null;
              const isError = info.status === "error";
              const isWarning = info.status === "warning";
              
              return (
                <div 
                  key={name}
                  className={`p-2.5 rounded-lg border relative overflow-hidden flex flex-col gap-1.5 transition-all ${
                    isError 
                      ? "border-rose-500/30 bg-rose-500/5 text-rose-300" 
                      : isWarning
                      ? "border-amber-500/30 bg-amber-500/5 text-amber-500 dark:text-amber-400"
                      : "border-blue-500/20 bg-blue-500/5 text-slate-300 animate-pulse"
                  }`}
                >
                  <div className="flex items-center justify-between text-xs font-medium">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      {isError ? (
                        <XCircle className="w-3.5 h-3.5 text-rose-500 flex-shrink-0" />
                      ) : isWarning ? (
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                      ) : (
                        <RefreshCw className="w-3.5 h-3.5 text-blue-400 animate-spin flex-shrink-0" />
                      )}
                      <span className={`truncate pr-1 block font-sans font-medium ${isError ? "text-rose-700 dark:text-rose-400" : isWarning ? "text-amber-600 dark:text-amber-400" : "text-[var(--cor-texto)]"}`}>
                        {name}
                      </span>
                    </div>
                    {!isError && !isWarning && (
                      <span className="text-[10px] font-mono text-blue-400 font-semibold flex-shrink-0">
                        {info.progress}%
                      </span>
                    )}
                  </div>
                  
                  <div className="text-[9px] font-mono flex items-start justify-between gap-2">
                    <span className={isError ? "text-rose-400 font-medium whitespace-normal break-words leading-relaxed" : isWarning ? "text-amber-600 dark:text-amber-400 font-medium whitespace-normal break-words leading-relaxed" : "text-slate-500"}>
                      {isError 
                        ? (info.error || "Falha na indexação.") 
                        : isWarning
                        ? (info.error || "Aviso no processamento.")
                        : info.status === "uploading" 
                          ? (info.error || "Processando e indexando...")
                          : "Na fila..."}
                    </span>
                    {info.attempt && info.attempt > 1 && !isError && !isWarning && (
                      <span className="text-amber-500 font-semibold bg-amber-500/10 px-1 rounded flex-shrink-0 text-[8px]">
                        Tenta {info.attempt}/3
                      </span>
                    )}
                  </div>

                  {!isError && !isWarning && (
                    /* Mini barra de progresso azul dentro do card */
                    <div className="w-full bg-slate-900 h-1 rounded-full overflow-hidden mt-0.5">
                      <div 
                        className="bg-blue-500 h-full rounded-full transition-all duration-300 ease-out"
                        style={{ width: `${info.progress}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })}

            {files.length === 0 && !uploading ? (
              <div className="text-center py-12 px-4 text-xs text-[var(--cor-texto-secundario)] space-y-2">
                <HelpCircle className="w-8 h-8 text-slate-400 mx-auto opacity-40" />
                <p className="font-medium text-[var(--cor-texto)]">Nenhuma fonte disponível.</p>
                <p className="text-[11px] text-[var(--cor-texto-secundario)] leading-relaxed">
                  Adicione arquivos locais ou realize a sincronização para carregar as fontes do seu robô.
                </p>
              </div>
            ) : filteredFiles.length === 0 && files.length > 0 ? (
              <div className="text-center py-12 px-4 text-xs text-[var(--cor-texto-secundario)] space-y-2">
                <HelpCircle className="w-8 h-8 text-slate-400 mx-auto opacity-40" />
                <p className="font-medium text-[var(--cor-texto)]">Nenhum resultado encontrado.</p>
                <p className="text-[11px] text-[var(--cor-texto-secundario)] leading-relaxed">
                  Tente buscar com termos diferentes.
                </p>
              </div>
            ) : (
              filteredFiles.slice(0, visibleLimit).map(file => {
                const isSelected = selectedFileIds.includes(file.id);
                const isUploaded = file.clientId === "uploaded"; // Marcador para arquivos carregados manualmente

                return (
                  <div 
                    key={file.id}
                    onClick={() => onToggleFile(file.id)}
                    className={`flex items-center justify-between gap-2.5 p-2.5 rounded-xl cursor-pointer border transition-all text-xs group ${
                      isSelected 
                        ? "bg-[var(--cor-primaria-clara)] border-[var(--cor-borda-primaria)] text-[var(--cor-texto)] shadow-2xs" 
                        : "bg-[var(--cor-card-fundo)] border-[var(--cor-borda)] text-[var(--cor-texto)] hover:bg-[var(--cor-hover)] hover:border-[var(--cor-borda-primaria)]"
                    }`}
                    title={`${file.name} (${file.clientName} | ${file.robotName})`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      {/* Checkbox */}
                      <div className="flex-shrink-0 text-[var(--cor-texto-secundario)] group-hover:text-[var(--cor-primaria)] transition-colors">
                        {isSelected ? (
                          <CheckSquare className="w-4 h-4 text-[var(--cor-primaria)]" />
                        ) : (
                          <Square className="w-4 h-4" />
                        )}
                      </div>

                      {/* Ícone do Formato */}
                      <div className="flex-shrink-0">
                        {getFileIcon(file.name, file.origin)}
                      </div>

                      {/* Nome do Arquivo e Metadados */}
                      <div className="flex flex-col min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="truncate font-medium text-xs text-[var(--cor-texto)]" title={file.name}>
                            {file.name}
                          </span>
                          {file.tipoDocumento && (
                            <span 
                              className="text-[9px] font-semibold px-1.5 py-0.5 rounded-md bg-[var(--cor-superficie)] text-[var(--cor-primaria)] border border-[var(--cor-borda)] flex-shrink-0"
                              title={`Tipo: ${file.tipoDocumento}`}
                            >
                              {file.tipoDocumento}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1 text-[11px] text-[var(--cor-texto-secundario)] truncate mt-0.5">
                          <span className="truncate">
                            {file.origin === "SharePoint" || file.clientId === "sharepoint"
                              ? `SharePoint • ${file.folderPath || file.robotName}`
                              : isUploaded
                              ? "Arquivo local"
                              : `${file.clientName.split(" (")[0]}`}
                          </span>
                          {file.size && (
                            <>
                              <span className="opacity-40">•</span>
                              <span className="flex-shrink-0 text-[10px]">{file.size}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Ação Rápida (Excluir) */}
                    <div className="flex items-center gap-1 flex-shrink-0 opacity-80 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={(e) => handleDelete(e, file.id)}
                        className="p-1.5 text-[var(--cor-texto-secundario)] hover:text-rose-500 hover:bg-rose-500/10 rounded-lg transition-colors cursor-pointer"
                        title="Excluir fonte permanentemente"
                        aria-label="Excluir fonte"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </>
        )}
      </div>

      {/* Rodapé descritivo sutil */}
      <div className="p-3 bg-[var(--cor-card-fundo)] border-t border-[var(--cor-borda)] text-xs text-[var(--cor-texto-secundario)] flex items-center justify-center gap-1.5">
        <Sparkles className="w-3 h-3 text-[var(--cor-primaria)]" />
        <span>Contexto dinâmico ativo</span>
      </div>

      {/* Navegador de Pastas do SharePoint via Microsoft Graph com Sites.Selected */}
      <SharePointBrowserModal
        isOpen={showSharePointBrowser}
        onClose={() => setShowSharePointBrowser(false)}
        onImport={handleImportSharePointFile}
      />

      {/* Modal de Confirmação de Nova Versão (Mesmo Nome, Checksum Diferente) */}
      {versionConflict && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in">
          <div className="bg-[var(--cor-superficie)] border border-[var(--cor-borda)] rounded-2xl max-w-sm w-full p-5 shadow-2xl space-y-4 animate-scale-up">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-xl bg-amber-500/10 text-amber-500 flex-shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-[var(--cor-texto)]">
                  Nova versão detectada
                </h3>
                <p className="text-xs text-[var(--cor-texto-secundario)] leading-relaxed">
                  Já existe um arquivo com o nome <strong>"{versionConflict.existingFileName}"</strong> nesta conversa com conteúdo diferente.
                </p>
                <p className="text-xs text-[var(--cor-texto-secundario)]">
                  Escolha como deseja prosseguir com a importação:
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-2 pt-2">
              <button
                type="button"
                onClick={() => handleResolveVersionConflict("replace")}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-xl bg-[var(--cor-balaousuario-fundo)] text-white hover:opacity-90 transition-all cursor-pointer shadow-xs"
              >
                <span>Substituir versão anterior</span>
              </button>

              <button
                type="button"
                onClick={() => handleResolveVersionConflict("keep_both")}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-xl border border-[var(--cor-borda)] text-[var(--cor-texto)] hover:bg-[var(--cor-hover)] transition-all cursor-pointer"
              >
                <span>Manter ambos</span>
              </button>

              <button
                type="button"
                onClick={() => setVersionConflict(null)}
                className="w-full py-2 text-xs font-medium text-[var(--cor-texto-secundario)] hover:text-[var(--cor-texto)] transition-colors cursor-pointer text-center"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Conteúdo Extraído (Markdown) */}
      <ExtractedContentModal
        isOpen={Boolean(previewFile)}
        onClose={() => setPreviewFile(null)}
        file={previewFile}
        userEmail={userEmail}
      />
    </div>
  );
}
