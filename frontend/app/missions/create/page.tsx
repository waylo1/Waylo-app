import { RequireAuth } from "@/components/require-auth";
import { MissionForm } from "@/components/mission-form";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Page serveur : ne porte aucun état. Toute l'interactivité (validation,
// soumission API) vit dans <MissionForm /> (composant client réutilisable).
export default function CreateMissionPage() {
  return (
    <RequireAuth>
      <div className="mx-auto max-w-lg">
        <Card>
          <CardHeader>
            <CardTitle>Nouvelle mission</CardTitle>
          </CardHeader>
          <CardContent>
            <MissionForm />
          </CardContent>
        </Card>
      </div>
    </RequireAuth>
  );
}
