// Page légale publique (pas de RequireAuth) : Conditions Générales d'Utilisation.
export default function CguPage() {
  return (
    <article className="mx-auto max-w-2xl space-y-6 py-4 text-sm leading-relaxed">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">
          Conditions Générales d&apos;Utilisation
        </h1>
        <p className="text-muted-foreground">Dernière mise à jour : 14 juin 2026</p>
      </header>

      <section className="space-y-2">
        <h2 className="font-medium">1. Objet</h2>
        <p className="text-muted-foreground">
          Waylo est une plateforme de mise en relation entre un{" "}
          <strong>Acheteur</strong> souhaitant acquérir un produit à
          l&apos;étranger et un <strong>Voyageur</strong> assurant son achat puis
          son acheminement. Waylo agit exclusivement comme{" "}
          <strong>tiers de confiance</strong> et opère un{" "}
          <strong>séquestre de fonds (escrow)</strong>.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">2. Rôle de Waylo</h2>
        <p className="text-muted-foreground">
          Waylo fournit un service technique de mise en relation et de
          séquestre : les fonds de l&apos;Acheteur sont bloqués à la commande
          (autorisation à capture différée) et libérés au Voyageur après
          confirmation de la bonne réception. Waylo n&apos;est{" "}
          <strong>ni vendeur, ni acheteur, ni transporteur</strong> et n&apos;est
          pas partie au contrat de vente conclu entre les utilisateurs.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">3. Responsabilité des utilisateurs</h2>
        <p className="text-muted-foreground">
          La responsabilité de l&apos;<strong>achat/vente</strong>, du{" "}
          <strong>transport</strong> et de l&apos;
          <strong>importation</strong> (y compris douanes, taxes et conformité du
          produit) incombe <strong>exclusivement aux utilisateurs</strong>,
          l&apos;Acheteur et le Voyageur, qui contractent de pair à pair. Chaque
          partie déclare agir en conformité avec les lois applicables.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">4. Séquestre et libération des fonds</h2>
        <p className="text-muted-foreground">
          Le montant séquestré (prix du produit et Marge Voyageur) n&apos;est
          capturé qu&apos;à la validation de la mission. La libération au Voyageur
          intervient après confirmation de réception par l&apos;Acheteur. Aucun
          frais caché n&apos;est appliqué ; le prix de revente final est validé
          dans l&apos;application.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">5. Limitation de responsabilité</h2>
        <p className="text-muted-foreground">
          Waylo ne saurait être tenu responsable des litiges relatifs au produit,
          des retards, des aléas de transport ou des obligations douanières, qui
          relèvent des seuls utilisateurs. La responsabilité de Waylo se limite au
          bon fonctionnement du service de séquestre.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">6. Acceptation</h2>
        <p className="text-muted-foreground">
          L&apos;utilisation du service et le financement d&apos;une mission
          valent acceptation pleine et entière des présentes conditions.
        </p>
      </section>
    </article>
  );
}
