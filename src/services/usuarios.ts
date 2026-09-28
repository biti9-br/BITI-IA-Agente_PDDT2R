import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db, auth } from "../firebase";
import type { User as FirebaseUser } from "firebase/auth";
import type { CorporateUser } from "../auth";

export type UserLike = FirebaseUser | CorporateUser;

export async function garantirUsuario(user: UserLike) {
  if (!user || !user.uid) return;

  // Se o usuário não estiver autenticado no Firebase Auth (ex: login corporativo por email local),
  // as regras de segurança do Firestore rejeitam chamadas diretas com "Missing or insufficient permissions".
  if (!auth.currentUser || auth.currentUser.uid !== user.uid) {
    return;
  }

  try {
    const ref = doc(db, "users", user.uid);
    const snap = await getDoc(ref);

    const providerId =
      "providerData" in user && Array.isArray(user.providerData) && user.providerData[0]?.providerId
        ? user.providerData[0].providerId
        : "password";

    if (!snap.exists()) {
      // Primeiro login desse usuário: cria o documento único
      await setDoc(ref, {
        email: user.email,
        nome: user.displayName || user.email?.split("@")[0] || "",
        provider: providerId,
        criadoEm: serverTimestamp(),
        ultimoLogin: serverTimestamp(),
      });
    } else {
      // Já existe: só atualiza o último login, sem recriar nada
      await setDoc(
        ref,
        {
          ultimoLogin: serverTimestamp(),
          email: user.email,
          ...(user.displayName ? { nome: user.displayName } : {}),
        },
        { merge: true }
      );
    }
  } catch (err) {
    console.warn("Aviso ao sincronizar usuário no Firestore:", err);
  }
}
