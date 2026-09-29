import { apiFetch } from "./api";
import { jsPDF } from "jspdf";

export interface ConsultaDoc {
  id?: string;
  titulo: string;
  tipo: "PDD" | "T2R" | string;
  pdfUrl: string;
  criadoEm?: any;
}

export async function salvarConsultaPDF(
  uid: string,
  pdfBlob: Blob,
  titulo: string,
  tipo: string
): Promise<string> {
  const localUrl = URL.createObjectURL(pdfBlob);
  try {
    await apiFetch("/api/consultas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        titulo,
        tipo,
        pdfUrl: localUrl
      })
    });
  } catch (err) {
    console.warn("Aviso ao salvar consulta via API:", err);
  }
  return localUrl;
}

export async function carregarConsultas(uid: string): Promise<ConsultaDoc[]> {
  try {
    const res = await apiFetch("/api/consultas");
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.consultas) ? data.consultas : [];
  } catch (err) {
    console.warn("Aviso ao carregar consultas via API:", err);
    return [];
  }
}

/**
 * Utilitário para gerar um PDF estilizado com os dados da consulta do robô/processo
 */
export function gerarBlobPDF(titulo: string, tipo: string, texto: string): Blob {
  const doc = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
  });

  // Cabeçalho corporativo
  doc.setFillColor(5, 7, 10);
  doc.rect(0, 0, 210, 30, "F");

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("biti9 | Relatório Executivo de Automação", 15, 15);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(150, 180, 220);
  doc.text(`Documento: ${tipo} • Data: ${new Date().toLocaleDateString("pt-BR")}`, 15, 23);

  // Título do Processo
  doc.setTextColor(20, 20, 30);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text(titulo, 15, 42);

  // Linha separadora
  doc.setDrawColor(220, 225, 230);
  doc.setLineWidth(0.5);
  doc.line(15, 46, 195, 46);

  // Conteúdo
  doc.setTextColor(60, 60, 70);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);

  // Quebra de texto automática
  const linhas = doc.splitTextToSize(texto, 180);
  doc.text(linhas, 15, 55);

  // Rodapé
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(9);
    doc.setTextColor(150, 150, 150);
    doc.text(
      `Página ${i} de ${pageCount} • Gerado via Central biti9 PDD & T2R`,
      15,
      288
    );
  }

  return doc.output("blob");
}

