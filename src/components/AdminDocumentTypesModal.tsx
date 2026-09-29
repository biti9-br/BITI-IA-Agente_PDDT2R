import React, { useState, useEffect, useRef } from "react";
import {
  X,
  Plus,
  Check,
  AlertCircle,
  Shield,
  FileCheck2,
  Edit2,
  RefreshCw,
  Upload,
  FileText,
  CheckCircle2,
  XCircle,
  ToggleLeft,
  ToggleRight,
  HelpCircle,
  ArrowLeft,
  Database
} from "lucide-react";
import { DocumentTypeConfig } from "../types";
import { apiFetch } from "../services/api";

interface AdminDocumentTypesModalProps {
  isOpen: boolean;
  onClose: () => void;
  userEmail: string;
  onTypesUpdated?: () => void;
}

export default function AdminDocumentTypesModal({
  isOpen,
  onClose,
  userEmail,
  onTypesUpdated
}: AdminDocumentTypesModalProps) {
  const [types, setTypes] = useState<DocumentTypeConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Estados de Criação / Edição
  const [editingType, setEditingType] = useState<DocumentTypeConfig | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [formSigla, setFormSigla] = useState("");
  const [formNome, setFormNome] = useState("");
  const [formDescricao, setFormDescricao] = useState("");
  const [formPrompt, setFormPrompt] = useState("");
  const [formSecoes, setFormSecoes] = useState<string[]>([]);
  const [newSecaoInput, setNewSecaoInput] = useState("");
  const [formAtivo, setFormAtivo] = useState(true);
  const [saving, setSaving] = useState(false);

  // Estados de Teste de Validação
  const [testingModalOpen, setTestingModalOpen] = useState(false);
  const [testFile, setTestFile] = useState<File | null>(null);
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<any | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Estados de Migração de Dados Locais para o Firestore
  const [migrationModalOpen, setMigrationModalOpen] = useState(false);
  const [migrationStatus, setMigrationStatus] = useState<any[]>([]);
  const [migrationLoading, setMigrationLoading] = useState(false);
  const [migrationRunning, setMigrationRunning] = useState(false);
  const [migrationReport, setMigrationReport] = useState<any | null>(null);
  const [migrationError, setMigrationError] = useState<string | null>(null);

  // Estados de Recalcular Embeddings (Vector Search Nativo)
  const [recalcModalOpen, setRecalcModalOpen] = useState(false);
  const [recalcStatus, setRecalcStatus] = useState<{
    totalChunks: number;
    needsRecalculation: number;
    alreadyNative: number;
    embeddingModelo: string;
    embeddingDim: number;
  } | null>(null);
  const [recalcLoading, setRecalcLoading] = useState(false);
  const [recalcRunning, setRecalcRunning] = useState(false);
  const [recalcProgress, setRecalcProgress] = useState<{
    processed: number;
    total: number;
    percentage: number;
    message: string;
  } | null>(null);
  const [recalcLogs, setRecalcLogs] = useState<string[]>([]);
  const [recalcError, setRecalcError] = useState<string | null>(null);
  const [recalcDone, setRecalcDone] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadTypes();
    }
  }, [isOpen]);

  const loadTypes = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/settings/document-types");
      if (!res.ok) {
        throw new Error("Falha ao carregar tipos de documentos.");
      }
      const data = await res.json();
      setTypes(data.types || []);
    } catch (err: any) {
      setError(err.message || "Erro de conexão ao buscar tipos.");
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = async (typeItem: DocumentTypeConfig) => {
    try {
      const res = await apiFetch(`/api/settings/document-types/${typeItem.id}/toggle`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        }
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Falha ao alterar status.");
      }
      const data = await res.json();
      setTypes(prev => prev.map(t => (t.id === typeItem.id ? data.type : t)));
      setSuccessMsg(`Status do tipo "${typeItem.sigla}" alterado para ${data.type.ativo ? "Ativo" : "Inativo"}.`);
      setTimeout(() => setSuccessMsg(null), 3000);
      if (onTypesUpdated) onTypesUpdated();
    } catch (err: any) {
      setError(err.message || "Erro ao alternar status.");
      setTimeout(() => setError(null), 4000);
    }
  };

  const handleStartCreate = () => {
    setEditingType(null);
    setIsCreatingNew(true);
    setFormSigla("");
    setFormNome("");
    setFormDescricao("");
    setFormPrompt("Aja como especialista técnico e corporativo. Analise a estrutura do documento e valide se atende rigorosamente a este formato.");
    setFormSecoes([]);
    setNewSecaoInput("");
    setFormAtivo(true);
    setError(null);
  };

  const handleStartEdit = (typeItem: DocumentTypeConfig) => {
    setIsCreatingNew(false);
    setEditingType(typeItem);
    setFormSigla(typeItem.sigla);
    setFormNome(typeItem.nome);
    setFormDescricao(typeItem.descricao || "");
    setFormPrompt(typeItem.promptValidacao || "");
    setFormSecoes([...typeItem.secoesObrigatorias]);
    setNewSecaoInput("");
    setFormAtivo(typeItem.ativo);
    setError(null);
  };

  const handleCancelForm = () => {
    setEditingType(null);
    setIsCreatingNew(false);
    setError(null);
  };

  const handleAddSecao = () => {
    const trimmed = newSecaoInput.trim();
    if (!trimmed) return;
    if (!formSecoes.includes(trimmed)) {
      setFormSecoes(prev => [...prev, trimmed]);
    }
    setNewSecaoInput("");
  };

  const handleRemoveSecao = (index: number) => {
    setFormSecoes(prev => prev.filter((_, idx) => idx !== index));
  };

  const handleSaveForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formSigla.trim() || !formNome.trim() || !formPrompt.trim()) {
      setError("Os campos Sigla, Nome e Prompt de Validação são obrigatórios.");
      return;
    }

    setSaving(true);
    setError(null);

    const payload = {
      sigla: formSigla.trim().toUpperCase(),
      nome: formNome.trim(),
      descricao: formDescricao.trim(),
      promptValidacao: formPrompt.trim(),
      secoesObrigatorias: formSecoes,
      ativo: formAtivo,
      userEmail
    };

    try {
      const url = isCreatingNew
        ? "/api/settings/document-types"
        : `/api/settings/document-types/${editingType?.id}`;
      const method = isCreatingNew ? "POST" : "PUT";

      const res = await apiFetch(url, {
        method,
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Falha ao salvar tipo de documento.");
      }

      await loadTypes();
      setIsCreatingNew(false);
      setEditingType(null);
      setSuccessMsg(`Tipo de documento "${payload.sigla}" salvo com sucesso!`);
      setTimeout(() => setSuccessMsg(null), 3000);
      if (onTypesUpdated) onTypesUpdated();
    } catch (err: any) {
      setError(err.message || "Erro ao salvar.");
    } finally {
      setSaving(false);
    }
  };

  // Testar Validação com Arquivo
  const handleOpenTestModal = () => {
    setTestingModalOpen(true);
    setTestFile(null);
    setTestResult(null);
    setTestError(null);
  };

  const handleTestFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setTestFile(e.target.files[0]);
      setTestResult(null);
      setTestError(null);
    }
  };

  const handleExecuteValidationTest = async () => {
    if (!testFile) return;

    setTestLoading(true);
    setTestError(null);
    setTestResult(null);

    try {
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const resStr = reader.result as string;
          const base64Data = resStr.split(",")[1] || resStr;
          resolve(base64Data);
        };
        reader.onerror = reject;
      });
      reader.readAsDataURL(testFile);
      const base64 = await base64Promise;

      const res = await apiFetch("/api/settings/test-validation", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: testFile.name,
          type: testFile.type,
          base64
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Falha no teste de validação.");
      }
      setTestResult(data);
    } catch (err: any) {
      setTestError(err.message || "Erro ao executar validação de teste.");
    } finally {
      setTestLoading(false);
    }
  };

  const handleOpenMigrationModal = async () => {
    setMigrationModalOpen(true);
    setMigrationLoading(true);
    setMigrationError(null);
    setMigrationReport(null);
    try {
      const res = await apiFetch("/api/admin/migration-status");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao verificar arquivos locais.");
      setMigrationStatus(data.files || []);
    } catch (err: any) {
      setMigrationError(err.message || "Erro ao consultar status de migração.");
    } finally {
      setMigrationLoading(false);
    }
  };

  const handleRunMigration = async () => {
    setMigrationRunning(true);
    setMigrationError(null);
    try {
      const res = await apiFetch("/api/admin/migrate-local-to-firestore", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao executar migração.");
      setMigrationReport(data);
      if (onTypesUpdated) onTypesUpdated();
    } catch (err: any) {
      setMigrationError(err.message || "Erro na migração.");
    } finally {
      setMigrationRunning(false);
    }
  };

  const handleOpenRecalcModal = async () => {
    setRecalcModalOpen(true);
    setRecalcLoading(true);
    setRecalcError(null);
    setRecalcDone(false);
    setRecalcProgress(null);
    setRecalcLogs([]);
    try {
      const res = await apiFetch("/api/admin/recalcular-embeddings/status");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao verificar status dos embeddings.");
      setRecalcStatus(data);
    } catch (err: any) {
      setRecalcError(err.message || "Erro ao consultar status dos embeddings.");
    } finally {
      setRecalcLoading(false);
    }
  };

  const handleRunRecalculate = async () => {
    setRecalcRunning(true);
    setRecalcError(null);
    setRecalcDone(false);
    setRecalcLogs(["[Início] Conectando ao servidor para recálculo vetorial..."]);

    try {
      const res = await apiFetch("/api/admin/recalcular-embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        }
      });

      if (!res.ok) {
        let msg = "Falha ao iniciar recálculo.";
        try {
          const d = await res.json();
          msg = d.error || msg;
        } catch {}
        throw new Error(msg);
      }

      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.type === "log" && msg.message) {
                setRecalcLogs(prev => [...prev.slice(-50), msg.message]);
              } else if (msg.type === "init") {
                setRecalcProgress({
                  processed: 0,
                  total: msg.total,
                  percentage: 0,
                  message: msg.message
                });
                setRecalcLogs(prev => [...prev.slice(-50), msg.message]);
              } else if (msg.type === "progress") {
                setRecalcProgress({
                  processed: msg.processed,
                  total: msg.total,
                  percentage: msg.percentage,
                  message: msg.message
                });
                setRecalcLogs(prev => [...prev.slice(-50), msg.message]);
              } else if (msg.type === "done") {
                setRecalcProgress({
                  processed: msg.processed,
                  total: msg.total,
                  percentage: 100,
                  message: msg.message
                });
                setRecalcLogs(prev => [...prev.slice(-50), `[Concluído] ${msg.message}`]);
                setRecalcDone(true);
              } else if (msg.type === "error") {
                throw new Error(msg.error || "Erro no recálculo.");
              }
            } catch (pErr: any) {
              console.warn("Erro ao decodificar progresso:", pErr);
            }
          }
        }
      }

      // Atualiza status final
      try {
        const statRes = await apiFetch("/api/admin/recalcular-embeddings/status");
        if (statRes.ok) {
          const statData = await statRes.json();
          setRecalcStatus(statData);
        }
      } catch {}

      if (onTypesUpdated) onTypesUpdated();
    } catch (err: any) {
      setRecalcError(err.message || "Erro no recálculo de embeddings.");
      setRecalcLogs(prev => [...prev, `[ERRO] ${err.message || err}`]);
    } finally {
      setRecalcRunning(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 z-50 animate-fade-in text-[var(--cor-texto)]">
      <div className="bg-[var(--cor-superficie)] border border-[var(--cor-borda)] rounded-2xl w-full max-w-4xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
        
        {/* Header do Modal */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--cor-borda)] bg-[var(--cor-card-fundo)]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-500 flex-shrink-0">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-bold text-[var(--cor-texto)] flex items-center gap-2">
                <span>Administração</span>
                <span className="text-slate-400 font-normal">→</span>
                <span>Tipos de documento</span>
              </h2>
              <p className="text-xs text-[var(--cor-texto-secundario)]">
                Gerenciamento global de tipos aceitos e regras estruturais de validação
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--cor-texto-secundario)] hover:text-[var(--cor-texto)] hover:bg-[var(--cor-hover)] transition-colors cursor-pointer"
            title="Fechar janela"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mensagens de Sucesso ou Erro Globais */}
        {successMsg && (
          <div className="mx-6 mt-4 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-xs flex items-center gap-2 animate-fade-in">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            <span>{successMsg}</span>
          </div>
        )}
        {error && (
          <div className="mx-6 mt-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-600 dark:text-rose-400 text-xs flex items-center gap-2 animate-fade-in">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Conteúdo Principal */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Se estiver no modo de formulário (criar ou editar) */}
          {isCreatingNew || editingType ? (
            <form onSubmit={handleSaveForm} className="space-y-5 animate-fade-in">
              <div className="flex items-center justify-between border-b border-[var(--cor-borda)] pb-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleCancelForm}
                    className="p-1 rounded-md text-[var(--cor-texto-secundario)] hover:text-[var(--cor-texto)] hover:bg-[var(--cor-hover)] transition-colors cursor-pointer"
                    title="Voltar para a lista"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                  <h3 className="text-sm font-semibold text-[var(--cor-texto)]">
                    {isCreatingNew ? "Criar novo tipo de documento" : `Editar tipo: ${editingType?.sigla}`}
                  </h3>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleCancelForm}
                    className="px-3 py-1.5 text-xs rounded-lg border border-[var(--cor-borda)] hover:bg-[var(--cor-hover)] text-[var(--cor-texto)] transition-colors cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-lg bg-[var(--cor-balaousuario-fundo)] text-white hover:opacity-90 transition-all cursor-pointer shadow-xs disabled:opacity-50"
                  >
                    {saving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                    <span>Salvar alterações</span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Sigla */}
                <div>
                  <label className="block text-xs font-semibold text-[var(--cor-texto)] mb-1">
                    Sigla <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={formSigla}
                    onChange={e => setFormSigla(e.target.value.toUpperCase())}
                    placeholder="Ex: PDD, ATA, REQ, PROJETO"
                    maxLength={15}
                    className="w-full text-xs px-3 py-2 rounded-xl bg-[var(--cor-fundo)] border border-[var(--cor-borda)] text-[var(--cor-texto)] focus:outline-hidden focus:border-[var(--cor-primaria)] uppercase font-mono"
                    required
                  />
                  <p className="text-[10px] text-[var(--cor-texto-secundario)] mt-1">
                    Identificador curto exibido nas etiquetas dos documentos.
                  </p>
                </div>

                {/* Nome Completo */}
                <div>
                  <label className="block text-xs font-semibold text-[var(--cor-texto)] mb-1">
                    Nome Completo <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={formNome}
                    onChange={e => setFormNome(e.target.value)}
                    placeholder="Ex: Process Design Document"
                    className="w-full text-xs px-3 py-2 rounded-xl bg-[var(--cor-fundo)] border border-[var(--cor-borda)] text-[var(--cor-texto)] focus:outline-hidden focus:border-[var(--cor-primaria)]"
                    required
                  />
                  <p className="text-[10px] text-[var(--cor-texto-secundario)] mt-1">
                    Nome formal do tipo de documento.
                  </p>
                </div>
              </div>

              {/* Descrição */}
              <div>
                <label className="block text-xs font-semibold text-[var(--cor-texto)] mb-1">
                  Descrição do Documento
                </label>
                <input
                  type="text"
                  value={formDescricao}
                  onChange={e => setFormDescricao(e.target.value)}
                  placeholder="Ex: Documento de especificação de processos para automação RPA..."
                  className="w-full text-xs px-3 py-2 rounded-xl bg-[var(--cor-fundo)] border border-[var(--cor-borda)] text-[var(--cor-texto)] focus:outline-hidden focus:border-[var(--cor-primaria)]"
                />
                <p className="text-[10px] text-[var(--cor-texto-secundario)] mt-1">
                  Explicativo do que este tipo de documento representa no negócio.
                </p>
              </div>

              {/* Prompt de Validação */}
              <div>
                <label className="block text-xs font-semibold text-[var(--cor-texto)] mb-1">
                  Prompt de Validação (Instrução ao Gemini) <span className="text-rose-500">*</span>
                </label>
                <textarea
                  rows={5}
                  value={formPrompt}
                  onChange={e => setFormPrompt(e.target.value)}
                  placeholder="Ex: Aja como especialista em RPA do Centro de Excelência que valida documentações de processos corporativos. Analise a estrutura do documento e valide se corresponde a um PDD..."
                  className="w-full text-xs p-3 rounded-xl bg-[var(--cor-fundo)] border border-[var(--cor-borda)] text-[var(--cor-texto)] focus:outline-hidden focus:border-[var(--cor-primaria)] leading-relaxed resize-y font-mono"
                  required
                />
                <p className="text-[10px] text-[var(--cor-texto-secundario)] mt-1">
                  Instrução enviada ao validador de IA com as diretrizes específicas deste tipo documental.
                </p>
              </div>

              {/* Seções Obrigatórias */}
              <div>
                <label className="block text-xs font-semibold text-[var(--cor-texto)] mb-1">
                  Seções Obrigatórias
                </label>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={newSecaoInput}
                    onChange={e => setNewSecaoInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddSecao();
                      }
                    }}
                    placeholder="Adicionar seção obrigatória (ex: Matriz RACI, Exceções)..."
                    className="flex-1 text-xs px-3 py-2 rounded-xl bg-[var(--cor-fundo)] border border-[var(--cor-borda)] text-[var(--cor-texto)] focus:outline-hidden focus:border-[var(--cor-primaria)]"
                  />
                  <button
                    type="button"
                    onClick={handleAddSecao}
                    className="px-3 py-2 text-xs font-medium rounded-xl border border-[var(--cor-borda)] hover:bg-[var(--cor-hover)] text-[var(--cor-texto)] cursor-pointer"
                  >
                    Adicionar
                  </button>
                </div>

                {formSecoes.length === 0 ? (
                  <p className="text-[11px] text-[var(--cor-texto-secundario)] italic">
                    Nenhuma seção obrigatória configurada (validação avaliará apenas o prompt).
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5 p-3 rounded-xl bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)]">
                    {formSecoes.map((secao, idx) => (
                      <span
                        key={idx}
                        className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-lg bg-[var(--cor-superficie)] border border-[var(--cor-borda)] text-[var(--cor-texto)]"
                      >
                        <span>{secao}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveSecao(idx)}
                          className="text-slate-400 hover:text-rose-500 cursor-pointer ml-1"
                          title="Remover seção"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Status Ativo Toggle */}
              <div className="flex items-center justify-between p-3.5 rounded-xl bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)]">
                <div>
                  <div className="text-xs font-semibold text-[var(--cor-texto)]">
                    Tipo de Documento Ativo
                  </div>
                  <div className="text-[11px] text-[var(--cor-texto-secundario)]">
                    Quando desativado, o sistema não aceitará nem validará arquivos deste formato.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setFormAtivo(!formAtivo)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold cursor-pointer transition-colors ${
                    formAtivo
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30"
                      : "bg-slate-500/15 text-slate-500 border border-slate-500/30"
                  }`}
                >
                  {formAtivo ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                  <span>{formAtivo ? "Ativo" : "Inativo"}</span>
                </button>
              </div>
            </form>
          ) : (
            /* Modo Lista de Tipos */
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-3 border-b border-[var(--cor-borda)]">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--cor-texto)]">
                    Tipos de Documentos Configurados
                  </h3>
                  <p className="text-xs text-[var(--cor-texto-secundario)]">
                    Total: {types.length} tipo(s) • {types.filter(t => t.ativo).length} ativo(s)
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleOpenRecalcModal}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-xl border border-sky-500/30 hover:bg-sky-500/10 text-sky-600 dark:text-sky-400 transition-colors cursor-pointer"
                    title="Recalcular embeddings para o tipo vetor nativo do Firestore (FieldValue.vector)"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Recalcular embeddings</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleOpenMigrationModal}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-xl border border-amber-500/30 hover:bg-amber-500/10 text-amber-600 dark:text-amber-400 transition-colors cursor-pointer"
                    title="Migrar dados locais legados (vector_db_*.json) para o Cloud Firestore"
                  >
                    <Database className="w-3.5 h-3.5" />
                    <span>Migrar dados locais</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleOpenTestModal}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-xl border border-[var(--cor-borda)] hover:bg-[var(--cor-hover)] text-[var(--cor-texto)] transition-colors cursor-pointer"
                  >
                    <FileCheck2 className="w-3.5 h-3.5 text-indigo-500" />
                    <span>Testar validação</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleStartCreate}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-xl bg-[var(--cor-balaousuario-fundo)] text-white hover:opacity-90 transition-all cursor-pointer shadow-xs"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Novo tipo</span>
                  </button>
                </div>
              </div>

              {loading ? (
                <div className="flex items-center justify-center py-12 text-xs text-[var(--cor-texto-secundario)]">
                  <RefreshCw className="w-4 h-4 animate-spin mr-2" />
                  <span>Carregando tipos configurados...</span>
                </div>
              ) : types.length === 0 ? (
                <div className="text-center py-12 text-xs text-[var(--cor-texto-secundario)] space-y-2">
                  <HelpCircle className="w-8 h-8 text-slate-400 mx-auto opacity-50" />
                  <p className="font-semibold text-[var(--cor-texto)]">Nenhum tipo de documento configurado.</p>
                  <p>Clique em "Novo tipo" para cadastrar um tipo aceito.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {types.map(t => {
                    const dataAtualizada = t.atualizadoEm
                      ? new Date(t.atualizadoEm).toLocaleString("pt-BR", {
                          day: "2-digit",
                          month: "2-digit",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit"
                        })
                      : "Inicial";

                    return (
                      <div
                        key={t.id}
                        className={`p-4 rounded-xl border transition-all ${
                          t.ativo
                            ? "bg-[var(--cor-card-fundo)] border-[var(--cor-borda)]"
                            : "bg-[var(--cor-fundo)]/50 border-[var(--cor-borda)] opacity-70"
                        }`}
                      >
                        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                          <div className="flex items-start gap-3 flex-1 min-w-0">
                            <span className="text-xs font-mono font-bold px-2 py-1 rounded-lg bg-[var(--cor-superficie)] border border-[var(--cor-borda)] text-[var(--cor-primaria)]">
                              {t.sigla}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <h4 className="text-xs font-bold text-[var(--cor-texto)] truncate">
                                  {t.nome}
                                </h4>
                                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                                  t.ativo
                                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                                    : "bg-slate-500/15 text-slate-500"
                                }`}>
                                  {t.ativo ? "Ativo" : "Inativo"}
                                </span>
                              </div>
                              <p className="text-[11px] text-[var(--cor-texto-secundario)] line-clamp-1 mt-0.5">
                                {t.descricao || "Sem descrição informada."}
                              </p>
                              <div className="flex flex-wrap items-center gap-3 text-[10px] text-[var(--cor-texto-secundario)] mt-1.5">
                                <span>{t.secoesObrigatorias.length} seção(ões) obrigatória(s)</span>
                                <span>•</span>
                                <span>Atualizado em: {dataAtualizada}</span>
                                {t.atualizadoPor && (
                                  <>
                                    <span>•</span>
                                    <span>Por: {t.atualizadoPor}</span>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Controles de Ação */}
                          <div className="flex items-center gap-2 self-end sm:self-center">
                            {/* Toggle Ativo / Inativo */}
                            <button
                              type="button"
                              onClick={() => handleToggle(t)}
                              className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
                                t.ativo
                                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20"
                                  : "bg-slate-500/10 border-slate-500/30 text-slate-500 hover:bg-slate-500/20"
                              }`}
                              title={t.ativo ? "Clique para desativar este tipo" : "Clique para ativar este tipo"}
                            >
                              {t.ativo ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                              <span>{t.ativo ? "Desativar" : "Ativar"}</span>
                            </button>

                            {/* Botão Editar */}
                            <button
                              type="button"
                              onClick={() => handleStartEdit(t)}
                              className="flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-lg border border-[var(--cor-borda)] hover:bg-[var(--cor-hover)] text-[var(--cor-texto)] transition-colors cursor-pointer"
                              title="Editar regras deste tipo"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                              <span>Editar</span>
                            </button>
                          </div>
                        </div>

                        {/* Seções em Badges */}
                        {t.secoesObrigatorias.length > 0 && (
                          <div className="mt-3 pt-2.5 border-t border-[var(--cor-borda)]/60 flex flex-wrap gap-1">
                            {t.secoesObrigatorias.map((s, idx) => (
                              <span
                                key={idx}
                                className="text-[10px] font-sans px-2 py-0.5 rounded bg-[var(--cor-superficie)] text-[var(--cor-texto-secundario)] border border-[var(--cor-borda)]"
                              >
                                {s}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Rodapé do Modal */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-[var(--cor-borda)] bg-[var(--cor-card-fundo)] text-xs text-[var(--cor-texto-secundario)]">
          <div className="flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5 text-indigo-500" />
            <span>Configuração global persistida no Firestore</span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg border border-[var(--cor-borda)] hover:bg-[var(--cor-hover)] text-[var(--cor-texto)] cursor-pointer text-xs font-medium"
          >
            Fechar
          </button>
        </div>

      </div>

      {/* Modal / Painel de Teste de Validação (sem salvar nada) */}
      {testingModalOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 z-60 animate-fade-in">
          <div className="bg-[var(--cor-superficie)] border border-[var(--cor-borda)] rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-scale-up">
            
            {/* Header Teste */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--cor-borda)] bg-[var(--cor-card-fundo)]">
              <div className="flex items-center gap-2.5">
                <FileCheck2 className="w-5 h-5 text-indigo-500" />
                <div>
                  <h3 className="text-sm font-bold text-[var(--cor-texto)]">
                    Testar Validação de Documento
                  </h3>
                  <p className="text-[11px] text-[var(--cor-texto-secundario)]">
                    Selecione um arquivo para ver a classificação do Gemini e o JSON estruturado retornado (sem salvar).
                  </p>
                </div>
              </div>
              <button
                onClick={() => setTestingModalOpen(false)}
                className="p-1 rounded-lg text-[var(--cor-texto-secundario)] hover:text-[var(--cor-texto)] hover:bg-[var(--cor-hover)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Conteúdo Teste */}
            <div className="p-5 overflow-y-auto space-y-4 flex-1">
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleTestFileSelect}
                accept="application/pdf, .docx, .xlsx, .txt"
                className="hidden"
              />

              <div
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-[var(--cor-borda)] hover:border-indigo-500 rounded-xl p-6 text-center cursor-pointer transition-colors bg-[var(--cor-card-fundo)] space-y-2"
              >
                <Upload className="w-8 h-8 text-indigo-500 mx-auto opacity-80" />
                <div className="text-xs font-semibold text-[var(--cor-texto)]">
                  {testFile ? testFile.name : "Clique para selecionar um arquivo de teste"}
                </div>
                <p className="text-[10px] text-[var(--cor-texto-secundario)]">
                  Formatos suportados: PDF, DOCX, XLSX, TXT
                </p>
              </div>

              {testFile && (
                <div className="flex items-center justify-between p-3 rounded-xl bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)]">
                  <div className="flex items-center gap-2 text-xs truncate">
                    <FileText className="w-4 h-4 text-indigo-500 flex-shrink-0" />
                    <span className="font-medium text-[var(--cor-texto)] truncate">{testFile.name}</span>
                    <span className="text-[10px] text-[var(--cor-texto-secundario)]">
                      ({(testFile.size / 1024).toFixed(1)} KB)
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleExecuteValidationTest}
                    disabled={testLoading}
                    className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-lg bg-[var(--cor-balaousuario-fundo)] text-white hover:opacity-90 transition-all cursor-pointer shadow-xs disabled:opacity-50"
                  >
                    {testLoading ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Auditando com IA...</span>
                      </>
                    ) : (
                      <>
                        <FileCheck2 className="w-3.5 h-3.5" />
                        <span>Executar validação</span>
                      </>
                    )}
                  </button>
                </div>
              )}

              {testError && (
                <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-600 dark:text-rose-400 text-xs flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <div>
                    <strong className="block">Falha na validação:</strong>
                    <span>{testError}</span>
                  </div>
                </div>
              )}

              {testResult && (
                <div className="space-y-3 animate-fade-in">
                  {/* Cartão de Veredito */}
                  <div className={`p-4 rounded-xl border flex items-center justify-between gap-3 ${
                    testResult.valido
                      ? "bg-emerald-500/10 border-emerald-500/30"
                      : "bg-rose-500/10 border-rose-500/30"
                  }`}>
                    <div className="flex items-center gap-3">
                      {testResult.valido ? (
                        <CheckCircle2 className="w-6 h-6 text-emerald-500 flex-shrink-0" />
                      ) : (
                        <XCircle className="w-6 h-6 text-rose-500 flex-shrink-0" />
                      )}
                      <div>
                        <div className="text-xs font-bold text-[var(--cor-texto)]">
                          {testResult.valido
                            ? `DOCUMENTO ACEITO COMO ${testResult.tipo}`
                            : `DOCUMENTO REJEITADO (${testResult.tipo})`}
                        </div>
                        <p className="text-[11px] text-[var(--cor-texto-secundario)]">
                          {testResult.justificativa}
                        </p>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-base font-mono font-bold text-[var(--cor-texto)]">
                        {testResult.confianca}%
                      </div>
                      <div className="text-[9px] text-[var(--cor-texto-secundario)] uppercase font-semibold">
                        Confiança
                      </div>
                    </div>
                  </div>

                  {/* Detalhe de Seções */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div className="p-3 rounded-xl bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)]">
                      <div className="font-semibold text-emerald-500 mb-1 flex items-center gap-1.5">
                        <Check className="w-3.5 h-3.5" />
                        <span>Seções Encontradas ({testResult.secoesEncontradas?.length || 0})</span>
                      </div>
                      {testResult.secoesEncontradas?.length > 0 ? (
                        <ul className="text-[11px] space-y-0.5 text-[var(--cor-texto-secundario)] list-disc pl-4">
                          {testResult.secoesEncontradas.map((s: string, i: number) => (
                            <li key={i}>{s}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-[11px] text-[var(--cor-texto-secundario)] italic">Nenhuma</p>
                      )}
                    </div>

                    <div className="p-3 rounded-xl bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)]">
                      <div className="font-semibold text-rose-500 mb-1 flex items-center gap-1.5">
                        <X className="w-3.5 h-3.5" />
                        <span>Seções Faltantes ({testResult.secoesFaltantes?.length || 0})</span>
                      </div>
                      {testResult.secoesFaltantes?.length > 0 ? (
                        <ul className="text-[11px] space-y-0.5 text-[var(--cor-texto-secundario)] list-disc pl-4">
                          {testResult.secoesFaltantes.map((s: string, i: number) => (
                            <li key={i}>{s}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-[11px] text-[var(--cor-texto-secundario)] italic">Nenhuma</p>
                      )}
                    </div>
                  </div>

                  {/* Visualização de JSON puro retornado */}
                  <div>
                    <label className="block text-[11px] font-semibold text-[var(--cor-texto)] mb-1">
                      JSON Retornado pelo Validador (schema estruturado):
                    </label>
                    <pre className="p-3 rounded-xl bg-slate-950 text-emerald-400 font-mono text-[11px] overflow-x-auto border border-slate-800 leading-relaxed">
                      {JSON.stringify(testResult, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </div>

            {/* Rodapé Teste */}
            <div className="px-5 py-3 border-t border-[var(--cor-borda)] bg-[var(--cor-card-fundo)] flex items-center justify-between text-xs text-[var(--cor-texto-secundario)]">
              <span>* Teste em memória: não grava dados no Firestore nem cria vetores.</span>
              <button
                type="button"
                onClick={() => setTestingModalOpen(false)}
                className="px-4 py-1.5 rounded-lg border border-[var(--cor-borda)] hover:bg-[var(--cor-hover)] text-[var(--cor-texto)] cursor-pointer"
              >
                Fechar teste
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Submodal de Recalcular Embeddings para Vetor Nativo do Firestore */}
      {recalcModalOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 z-60 animate-fade-in text-[var(--cor-texto)]">
          <div className="bg-[var(--cor-superficie)] border border-[var(--cor-borda)] rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
            
            {/* Header Recalcular Embeddings */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--cor-borda)] bg-[var(--cor-card-fundo)]">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-sky-500/10 text-sky-500">
                  <RefreshCw className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-[var(--cor-texto)]">
                    Recalcular Embeddings (Vector Search Nativo)
                  </h3>
                  <p className="text-xs text-[var(--cor-texto-secundario)]">
                    Atualiza os embeddings de todos os chunks para o tipo nativo FieldValue.vector (768 dimensões)
                  </p>
                </div>
              </div>
              <button
                onClick={() => setRecalcModalOpen(false)}
                disabled={recalcRunning}
                className="p-1.5 rounded-lg text-[var(--cor-texto-secundario)] hover:text-[var(--cor-texto)] hover:bg-[var(--cor-hover)] transition-colors cursor-pointer disabled:opacity-50"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Conteúdo Recalcular */}
            <div className="p-6 overflow-y-auto space-y-5 text-xs">
              {recalcError && (
                <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-600 dark:text-rose-400 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{recalcError}</span>
                </div>
              )}

              {recalcLoading ? (
                <div className="flex items-center justify-center py-10 text-[var(--cor-texto-secundario)]">
                  <RefreshCw className="w-5 h-5 animate-spin mr-2 text-sky-500" />
                  <span>Verificando vetores dos chunks no Cloud Firestore...</span>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Cards de Status */}
                  <div className="grid grid-cols-3 gap-2.5 text-center">
                    <div className="p-3 rounded-xl bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)]">
                      <p className="text-xl font-bold text-[var(--cor-texto)]">{recalcStatus?.totalChunks ?? 0}</p>
                      <p className="text-[11px] text-[var(--cor-texto-secundario)] mt-0.5">Total de Chunks</p>
                    </div>
                    <div className="p-3 rounded-xl bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)]">
                      <p className="text-xl font-bold text-emerald-500">{recalcStatus?.alreadyNative ?? 0}</p>
                      <p className="text-[11px] text-[var(--cor-texto-secundario)] mt-0.5">Vetor Nativo (OK)</p>
                    </div>
                    <div className="p-3 rounded-xl bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)]">
                      <p className="text-xl font-bold text-amber-500">{recalcStatus?.needsRecalculation ?? 0}</p>
                      <p className="text-[11px] text-[var(--cor-texto-secundario)] mt-0.5">Pendentes de Recálculo</p>
                    </div>
                  </div>

                  <div className="p-3 rounded-xl bg-sky-500/5 border border-sky-500/20 text-[var(--cor-texto-secundario)] space-y-1">
                    <p className="font-semibold text-[var(--cor-texto)]">Especificação Técnica do Índice:</p>
                    <p>• Modelo: <span className="font-mono text-sky-500">{recalcStatus?.embeddingModelo || "gemini-embedding-2-preview"}</span> (768 dimensões)</p>
                    <p>• Tipo no Firestore: <span className="font-mono text-sky-500">FieldValue.vector</span> nativo</p>
                    <p>• Execução: em lotes incrementais com commit contínuo (totalmente retomável)</p>
                  </div>

                  {/* Barra de Progresso se houver */}
                  {recalcProgress && (
                    <div className="space-y-2 p-3.5 rounded-xl bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)] animate-fade-in">
                      <div className="flex items-center justify-between font-semibold">
                        <span className="text-[var(--cor-texto)]">{recalcProgress.message}</span>
                        <span className="text-sky-500 font-mono">{recalcProgress.percentage}%</span>
                      </div>
                      <div className="w-full bg-[var(--cor-fundo)] rounded-full h-2.5 overflow-hidden">
                        <div
                          className="bg-sky-500 h-2.5 rounded-full transition-all duration-300"
                          style={{ width: `${recalcProgress.percentage}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-[10px] text-[var(--cor-texto-secundario)]">
                        <span>Processados: {recalcProgress.processed} / {recalcProgress.total}</span>
                        <span>{recalcRunning ? "Gravando lotes no Firestore..." : "Concluído"}</span>
                      </div>
                    </div>
                  )}

                  {/* Log em tempo real */}
                  {recalcLogs.length > 0 && (
                    <div className="space-y-1.5">
                      <h4 className="font-semibold text-[var(--cor-texto)]">Log de Execução:</h4>
                      <div className="max-h-40 overflow-y-auto p-3 rounded-xl bg-slate-900 text-slate-200 font-mono text-[10px] space-y-1">
                        {recalcLogs.map((log, idx) => (
                          <div key={idx} className="leading-relaxed">{log}</div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Botão de Ação */}
                  <div className="pt-2">
                    {recalcStatus?.needsRecalculation === 0 && !recalcRunning && !recalcDone ? (
                      <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-center font-semibold flex items-center justify-center gap-2">
                        <CheckCircle2 className="w-4 h-4" />
                        <span>Todos os chunks já possuem embedding no tipo vetor nativo FieldValue.vector (768d)!</span>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={handleRunRecalculate}
                        disabled={recalcRunning}
                        className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-sky-500 hover:bg-sky-600 text-white font-semibold transition-all cursor-pointer shadow-sm disabled:opacity-50"
                      >
                        {recalcRunning ? (
                          <>
                            <RefreshCw className="w-4 h-4 animate-spin" />
                            <span>Recalculando embeddings em lotes (aguarde)...</span>
                          </>
                        ) : (
                          <>
                            <RefreshCw className="w-4 h-4" />
                            <span>
                              {recalcProgress && recalcProgress.processed > 0 && !recalcDone
                                ? "Retomar Recálculo de Embeddings"
                                : "Recalcular Embeddings Agora"}
                            </span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Rodapé Recálculo */}
            <div className="px-6 py-3 border-t border-[var(--cor-borda)] bg-[var(--cor-card-fundo)] flex items-center justify-between text-xs text-[var(--cor-texto-secundario)]">
              <span>* Operação administrativa segura e retomável.</span>
              <button
                type="button"
                onClick={() => setRecalcModalOpen(false)}
                disabled={recalcRunning}
                className="px-4 py-1.5 rounded-lg border border-[var(--cor-borda)] hover:bg-[var(--cor-hover)] text-[var(--cor-texto)] cursor-pointer disabled:opacity-50"
              >
                Fechar
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Submodal de Migração de Dados Locais para o Cloud Firestore */}
      {migrationModalOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 z-60 animate-fade-in text-[var(--cor-texto)]">
          <div className="bg-[var(--cor-superficie)] border border-[var(--cor-borda)] rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
            
            {/* Header Migração */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--cor-borda)] bg-[var(--cor-card-fundo)]">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-amber-500/10 text-amber-500">
                  <Database className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-[var(--cor-texto)]">
                    Migrar dados locais para o Firestore
                  </h3>
                  <p className="text-xs text-[var(--cor-texto-secundario)]">
                    Copia documentos, chunks, sessões e mensagens para o Cloud Firestore (sem apagar arquivos locais)
                  </p>
                </div>
              </div>
              <button
                onClick={() => setMigrationModalOpen(false)}
                disabled={migrationRunning}
                className="p-1.5 rounded-lg text-[var(--cor-texto-secundario)] hover:text-[var(--cor-texto)] hover:bg-[var(--cor-hover)] transition-colors cursor-pointer disabled:opacity-50"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Conteúdo Migração */}
            <div className="p-6 overflow-y-auto space-y-5 text-xs">
              {migrationError && (
                <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-600 dark:text-rose-400 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{migrationError}</span>
                </div>
              )}

              {migrationLoading ? (
                <div className="flex items-center justify-center py-10 text-[var(--cor-texto-secundario)]">
                  <RefreshCw className="w-5 h-5 animate-spin mr-2 text-amber-500" />
                  <span>Verificando arquivos locais vector_db no servidor...</span>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Arquivos locais encontrados */}
                  <div>
                    <h4 className="font-semibold text-[var(--cor-texto)] mb-2 flex items-center justify-between">
                      <span>Arquivos Locais Encontrados ({migrationStatus.length})</span>
                      <span className="text-[11px] font-normal text-[var(--cor-texto-secundario)]">
                        Localização: /data
                      </span>
                    </h4>

                    {migrationStatus.length === 0 ? (
                      <div className="p-4 rounded-xl bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)] text-center text-[var(--cor-texto-secundario)]">
                        Nenhum arquivo local vector_db_*.json encontrado para migração.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {migrationStatus.map((file, idx) => (
                          <div
                            key={idx}
                            className="p-3 rounded-xl bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)] flex items-center justify-between"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="font-mono text-xs font-semibold text-[var(--cor-texto)] truncate">
                                {file.filename}
                              </p>
                              <p className="text-[11px] text-[var(--cor-texto-secundario)]">
                                Usuário destino: <span className="font-semibold text-indigo-500">{file.inferredEmail}</span> • Tamanho: {file.sizeFormatted}
                              </p>
                            </div>
                            <span className="text-[11px] px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium">
                              Pendente
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Ação de Iniciar Migração */}
                  {migrationStatus.length > 0 && !migrationReport && (
                    <div className="pt-2">
                      <button
                        type="button"
                        onClick={handleRunMigration}
                        disabled={migrationRunning}
                        className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-semibold transition-all cursor-pointer shadow-sm disabled:opacity-50"
                      >
                        {migrationRunning ? (
                          <>
                            <RefreshCw className="w-4 h-4 animate-spin" />
                            <span>Migrando dados para o Firestore (aguarde)...</span>
                          </>
                        ) : (
                          <>
                            <Upload className="w-4 h-4" />
                            <span>Copiar dados locais para o Cloud Firestore agora</span>
                          </>
                        )}
                      </button>
                      <p className="text-[11px] text-center text-[var(--cor-texto-secundario)] mt-2">
                        * Apenas dados inexistentes no Firestore são adicionados. Nenhum arquivo no servidor será apagado.
                      </p>
                    </div>
                  )}

                  {/* Relatório de Migração Concluída */}
                  {migrationReport && (
                    <div className="space-y-4 pt-2 border-t border-[var(--cor-borda)] animate-fade-in">
                      <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                        <span className="font-semibold">{migrationReport.message}</span>
                      </div>

                      {/* Cards com Totais */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                        <div className="p-2.5 rounded-xl bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)]">
                          <p className="text-lg font-bold text-indigo-500">{migrationReport.totals?.filesMigrated || 0}</p>
                          <p className="text-[10px] text-[var(--cor-texto-secundario)]">Arquivos</p>
                        </div>
                        <div className="p-2.5 rounded-xl bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)]">
                          <p className="text-lg font-bold text-emerald-500">{migrationReport.totals?.chunksMigrated || 0}</p>
                          <p className="text-[10px] text-[var(--cor-texto-secundario)]">Chunks</p>
                        </div>
                        <div className="p-2.5 rounded-xl bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)]">
                          <p className="text-lg font-bold text-amber-500">{migrationReport.totals?.sessionsMigrated || 0}</p>
                          <p className="text-[10px] text-[var(--cor-texto-secundario)]">Sessões</p>
                        </div>
                        <div className="p-2.5 rounded-xl bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)]">
                          <p className="text-lg font-bold text-blue-500">{migrationReport.totals?.messagesMigrated || 0}</p>
                          <p className="text-[10px] text-[var(--cor-texto-secundario)]">Mensagens</p>
                        </div>
                      </div>

                      {/* Detalhamento por arquivo */}
                      <div className="space-y-2">
                        <h5 className="font-semibold text-[var(--cor-texto)]">Detalhamento por Arquivo:</h5>
                        {(migrationReport.report || []).map((rep: any, idx: number) => (
                          <div key={idx} className="p-3 rounded-xl bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)] space-y-1">
                            <div className="flex items-center justify-between">
                              <span className="font-mono font-semibold text-[var(--cor-texto)]">{rep.file}</span>
                              <span className="text-[11px] text-indigo-500">{rep.userEmail}</span>
                            </div>
                            <div className="flex flex-wrap gap-3 text-[11px] text-[var(--cor-texto-secundario)]">
                              <span>Arquivos: +{rep.filesMigrated} ({rep.filesSkipped} ignorados)</span>
                              <span>• Chunks: +{rep.chunksMigrated} ({rep.chunksSkipped} ignorados)</span>
                              <span>• Sessões: +{rep.sessionsMigrated}</span>
                              <span>• Mensagens: +{rep.messagesMigrated}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                </div>
              )}
            </div>

            {/* Rodapé Migração */}
            <div className="px-6 py-3 border-t border-[var(--cor-borda)] bg-[var(--cor-card-fundo)] flex items-center justify-between text-xs text-[var(--cor-texto-secundario)]">
              <span>* Cloud Firestore: banco único do robbi9.</span>
              <button
                type="button"
                onClick={() => setMigrationModalOpen(false)}
                disabled={migrationRunning}
                className="px-4 py-1.5 rounded-lg border border-[var(--cor-borda)] hover:bg-[var(--cor-hover)] text-[var(--cor-texto)] cursor-pointer disabled:opacity-50"
              >
                Fechar
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}
