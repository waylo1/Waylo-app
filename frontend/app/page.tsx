import { redirect } from "next/navigation";

// Accueil V1 : tout passe par le suivi des missions.
export default function Home() {
  redirect("/missions");
}
