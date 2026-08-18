import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export async function redirectSignedInToApp() {
  const projectId = process.env.APPWRITE_PROJECT_ID?.trim();
  if (!projectId || !/^[A-Za-z0-9._-]{1,64}$/.test(projectId)) return;
  const cookieStore = await cookies();
  if (cookieStore.get(`a_session_${projectId}`)?.value) {
    redirect("/app");
  }
}
