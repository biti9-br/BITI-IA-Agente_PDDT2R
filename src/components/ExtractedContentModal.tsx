import React, { useState, useEffect } from "react";
import { X, Copy, Check, FileText, Code2, Eye, RefreshCw, AlertCircle, Sparkles } from "lucide-react";
import { marked } from "marked";
import { PDDDocument } from "../types";
import { apiFetch } from "../services/api";

interface ExtractedContentModalProps {
  isOpen: boolean;
  onClose: () => void;
  file: PDDDocument | null;
  userEmail: string;
}

export default function ExtractedContentModal({
  isOpen,
  onClose,
  file,
  userEmail
}: ExtractedContentModalProps) {
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"rendered" | "raw">("rendered");
  const [copied, setCopied] = useState(false);
  const [metadata, setMetadata] = useState<{
    formatoConteudo?: string;
    versaoConversor?: number;
    tipoDocumento?: string;
  }>({});

  useEffect(() => {
    if (!isOpen || !file) {
      setContent("");
      setError(null);
      return;
    }

    let isMounted = true;
    const fetchContent = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(`/api/db/files/${file.id}/content`);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || "Não foi possível carregar o conteúdo do arquivo.");
        }
        const data = await res.json();
        if (isMounted) {
          setContent(data.content || "");
          setMetadata({
            formatoConteudo: data.formatoConteudo,
            versaoConversor: data.versaoConversor,
            tipoDocumento: data.tipoDocumento
          });
        }
      } catch (err: any) {
        if (isMounted) {
          setError(err.message || "Erro desconhecido ao buscar conteúdo.");
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    fetchContent();

    return () => {
      isMounted = false;
    };
  }, [isOpen, file, userEmail]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !file) return null;

  const handleCopy = async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Falha ao copiar:", err);
    }
  };

  const renderedHtml = content ? (marked.parse(content) as string) : "";

  const isMarkdownV2 = metadata.formatoConteudo === "markdown" || file.formatoConteudo === "markdown";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/60 backdrop-blur-xs animate-fade-in">
      <div 
        className="bg-[var(--cor-superficie)] border border-[var(--cor-borda)] rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-scale-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Cabeçalho */}
        <div className="p-4 border-b border-[var(--cor-borda)] flex items-center justify-between gap-3 bg-[var(--cor-card-fundo)]">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="p-2 rounded-lg bg-[var(--cor-primaria-clara)] text-[var(--cor-primaria)] flex-shrink-0">
              <FileText className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-semibold text-sm text-[var(--cor-texto)] truncate">
                  {file.name}
                </h3>
                {(metadata.tipoDocumento || file.tipoDocumento) && (
                  <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/20">
                    {metadata.tipoDocumento || file.tipoDocumento}
                  </span>
                )}
                {isMarkdownV2 ? (
                  <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                    <Sparkles className="w-3 h-3" />
                    Markdown Estruturado (v2)
                  </span>
                ) : (
                  <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30">
                    Formato antigo – reimporte para melhor qualidade
                  </span>
                )}
              </div>
              <p className="text-xs text-[var(--cor-texto-secundario)] truncate mt-0.5">
                {file.clientName} • {file.robotName} {file.size ? `(${file.size})` : ""}
              </p>
            </div>
          </div>

          {/* Ações da Barra Superior */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Seletor de Modo de Visualização */}
            <div className="flex items-center bg-[var(--cor-hover)] rounded-lg p-0.5 border border-[var(--cor-borda)] text-xs">
              <button
                type="button"
                onClick={() => setViewMode("rendered")}
                className={`px-2.5 py-1 rounded-md transition-colors flex items-center gap-1.5 cursor-pointer font-medium ${
                  viewMode === "rendered"
                    ? "bg-[var(--cor-superficie)] text-[var(--cor-texto)] shadow-xs"
                    : "text-[var(--cor-texto-secundario)] hover:text-[var(--cor-texto)]"
                }`}
                title="Visualizar documento renderizado (com títulos, listas, tabelas e imagens)"
              >
                <Eye className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Renderizado</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("raw")}
                className={`px-2.5 py-1 rounded-md transition-colors flex items-center gap-1.5 cursor-pointer font-medium ${
                  viewMode === "raw"
                    ? "bg-[var(--cor-superficie)] text-[var(--cor-texto)] shadow-xs"
                    : "text-[var(--cor-texto-secundario)] hover:text-[var(--cor-texto)]"
                }`}
                title="Visualizar código Markdown original"
              >
                <Code2 className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Markdown Bruto</span>
              </button>
            </div>

            {/* Botão Copiar */}
            <button
              type="button"
              onClick={handleCopy}
              disabled={!content || loading}
              className="p-1.5 text-[var(--cor-texto-secundario)] hover:text-[var(--cor-texto)] hover:bg-[var(--cor-hover)] rounded-lg border border-[var(--cor-borda)] transition-colors cursor-pointer disabled:opacity-50"
              title="Copiar Markdown para a área de transferência"
            >
              {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
            </button>

            {/* Fechar */}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-[var(--cor-texto-secundario)] hover:text-[var(--cor-texto)] hover:bg-[var(--cor-hover)] rounded-lg transition-colors cursor-pointer"
              title="Fechar (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Corpo do Conteúdo */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 bg-[var(--cor-superficie)]">
          {loading ? (
            <div className="py-20 flex flex-col items-center justify-center gap-3 text-[var(--cor-texto-secundario)]">
              <RefreshCw className="w-6 h-6 animate-spin text-[var(--cor-primaria)]" />
              <p className="text-xs font-medium">Carregando conteúdo extraído...</p>
            </div>
          ) : error ? (
            <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 flex items-start gap-3 my-4">
              <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-semibold">Erro ao carregar conteúdo</h4>
                <p className="text-xs mt-1 leading-relaxed">{error}</p>
              </div>
            </div>
          ) : !content ? (
            <div className="py-16 text-center text-xs text-[var(--cor-texto-secundario)]">
              Nenhum conteúdo disponível para este arquivo.
            </div>
          ) : viewMode === "rendered" ? (
            <div 
              className="markdown-extracted-view text-[var(--cor-texto)] leading-relaxed text-sm"
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
          ) : (
            <pre className="font-mono text-xs whitespace-pre-wrap p-4 bg-gray-950 text-gray-100 rounded-xl border border-gray-800 overflow-x-auto leading-relaxed">
              {content}
            </pre>
          )}
        </div>

        {/* Rodapé Informativo */}
        <div className="px-4 py-2.5 bg-[var(--cor-card-fundo)] border-t border-[var(--cor-borda)] text-xs text-[var(--cor-texto-secundario)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span>
              {content ? `${content.length.toLocaleString()} caracteres` : "0 caracteres"}
            </span>
            {file.chunkCount && (
              <>
                <span>•</span>
                <span>{file.chunkCount} fragmentos (chunks) estruturados</span>
              </>
            )}
          </div>
          <span className="text-[11px]">
            Conforme padrão de Markdown estruturado
          </span>
        </div>
      </div>
    </div>
  );
}
