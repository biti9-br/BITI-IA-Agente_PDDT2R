import { apiFetch } from "./api";
import type { User as FirebaseUser } from "firebase/auth";

export type UserLike = FirebaseUser;

export async function garantirUsuario(user: UserLike, resolvedEmail?: string) {
  if (!user || !user.uid) return;
  const emailFinal = (resolvedEmail || user.email || "").trim().toLowerCase();
  if (!emailFinal) return;

  const providerId =
    "providerData" in user && Array.isArray(user.providerData) && user.providerData[0]?.providerId
      ? user.providerData[0].providerId
      : "microsoft.com";

  try {
    await apiFetch("/api/users/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: emailFinal,
        nome: user.displayName || emailFinal.split("@")[0] || "",
        provider: providerId
      })
    });
  } catch (err) {
    console.warn("Aviso ao sincronizar usuário via API:", err);
  }
}

