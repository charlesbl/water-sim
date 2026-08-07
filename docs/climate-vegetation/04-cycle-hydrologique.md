# Étape 04 — Cycle hydrologique atmosphérique

## But

Remplacer le couple « pluie aléatoire + évaporation destructive » par un cycle
fermé : évaporation, vapeur, condensation, nuages, précipitation, infiltration
future et retour à l'eau liquide ou solide.

Cette étape utilise une atmosphère sans vent dynamique. La diffusion et le
relief suffisent pour valider les échanges de masse avant d'ajouter le
transport complexe.

## Dépendances

- Étapes 01 à 03.
- Température en degrés Celsius.
- Eau solide fonctionnelle.

## Ressources GPU

Créer à la résolution climatique :

```wgsl
struct AtmosphereThermoCell {
    air_temperature: f32,
    vapor: f32,
    cloud_water: f32,
    precipitation_rate: f32,
}
```

Deux buffers ping-pong sont nécessaires. Ajouter un buffer non ping-pong de
résumé de surface, avec au minimum :

- hauteur moyenne et maximale ;
- température moyenne ;
- eau liquide disponible ;
- eau solide ;
- couverture de lave ;
- biomasse et humidité du sol réservées à zéro jusqu'à l'étape 06.
- somme des potentiels locaux d'évaporation ;
- somme des poids de distribution des précipitations.

Le résumé est produit par rassemblement : une invocation climatique parcourt
son bloc de cellules fines. Ne pas utiliser d'atomiques flottantes.

## Initialisation de l'atmosphère

- température issue du niveau de référence et du relief agrégé ;
- humidité relative initiale configurable mais homogène ;
- quantité totale d'eau atmosphérique connue ;
- petite perturbation déterministe optionnelle ;
- nuages et précipitations initialement nuls.

Le reset doit pouvoir choisir entre :

- atmosphère sèche ;
- humidité équilibrée ;
- état de test fourni par le validateur.

## Évaporation

Le taux local dépend de :

- température de surface ;
- quantité d'eau liquide disponible ;
- déficit de saturation de l'air ;
- coefficient d'échange ;
- vent fixé à une valeur minimale dans cette étape ;
- future évapotranspiration, encore nulle.

Le résumé calcule, pour chaque bloc climatique, la somme des potentiels locaux.
La passe atmosphérique transforme cette somme en un budget d'évaporation borné
par l'eau disponible et par `climateDt`. Elle ajoute ce budget à `vapor`.

Immédiatement après, `applyAtmosphereSurfaceExchange.wgsl` parcourt la grille
fine et retire à chaque cellule sa part :

`cellBudget = coarseBudget * localPotential / coarsePotentialSum`

La somme retirée correspond ainsi au budget ajouté à l'atmosphère, aux erreurs
d'arrondi près. Le snapshot de surface ne change pas entre résumé et
application. La passe d'application lit le côté fluide courant, écrit l'autre
côté et devient l'unique bascule ping-pong supplémentaire du tick climatique.

## Saturation et condensation

Utiliser une approximation monotone et documentée de l'humidité de saturation
en fonction de la température. Elle n'a pas besoin d'être météorologiquement
parfaite, mais doit respecter :

- air chaud capable de contenir davantage de vapeur ;
- condensation de l'excès uniquement ;
- transfert conservatif `vapor -> cloud_water` ;
- libération de chaleur latente bornée dans `air_temperature`.

Ajouter une faible diffusion de température, vapeur et nuage avec coefficients
séparés.

## Précipitations

- Déclencher un taux lorsque `cloud_water` dépasse un seuil doux.
- Retirer la même masse du nuage.
- Distribuer la précipitation sur les cellules fines correspondantes.
- Utiliser température de l'air et de surface pour choisir liquide ou solide.
- Ajouter un léger motif spatial seedé uniquement pour éviter un bord de bloc
  visible. Le résumé stocke la somme des poids du bloc et la passe fine divise
  par cette somme afin d'appliquer exactement le budget.
- Ne pas faire dépendre la pluie de `performance.now()`.

## Migration des contrôles existants

- `rainActive`, `rainQuantity`, `rainSize` deviennent un mode legacy ou un
  pinceau de test, pas la météo normale.
- `evaporation` fixe devient un coefficient physique d'échange ou est remplacé
  par `evaporationRate`.
- Le mode environnemental désactivé conserve le comportement existant.
- Le mode environnemental activé interdit l'utilisation simultanée de la pluie
  legacy dans les tests de conservation.

## Bilan hydrique

Créer une réduction GPU périodique donnant :

- eau liquide ;
- eau solide ;
- vapeur ;
- eau nuageuse ;
- précipitation en transit si elle est stockée ;
- entrées par frontière ;
- sorties par frontière ;
- erreur non expliquée.

Les readbacks sont asynchrones et espacés ; ils ne doivent pas bloquer chaque
image.

## Fichiers concernés

- nouveaux shaders `summarizeSurface.wgsl` et `simAtmosphereThermo.wgsl`
- `src/webgpuRenderer.ts` ou modules GPU extraits
- `src/config.ts`
- `src/main.ts`
- `src/shaders/simFluids.wgsl`
- `src/shaders/render.wgsl`
- nouveau validateur hydrologique

## Checklist d'implémentation

- [ ] Créer dimensions, buffers thermo et bind groups climatiques.
- [ ] Initialiser une atmosphère déterministe et mesurable.
- [ ] Implémenter le résumé de surface avec sommes de normalisation.
- [ ] Implémenter saturation, condensation et chaleur latente.
- [ ] Calculer budgets d'évaporation et de précipitation.
- [ ] Ajouter la passe fine conservant ces échanges et son ping-pong.
- [ ] Router pluie vers `water` et neige vers `solid_water`.
- [ ] Isoler les anciens contrôles pluie/évaporation en mode legacy.
- [ ] Ajouter réductions hydriques et scénarios de cycle fermé.

## Scénarios de test

1. Bassin fermé chaud sous atmosphère sèche : liquide diminue, vapeur augmente.
2. Atmosphère humide refroidie : vapeur diminue, nuage augmente.
3. Nuage au-dessus d'un bassin : le total nuage + précipitation + surface est
   conservé.
4. Colonne froide : la précipitation augmente `solid_water`.
5. Colonne chaude : elle augmente `water`.
6. Monde fermé long : dérive hydrique sous le seuil accepté.
7. Résolutions climatique 16² et 32² : absence de coutures entre blocs.

## Critères d'acceptation

- L'évaporation ne détruit plus d'eau en mode environnemental.
- Toute pluie provient d'un retrait mesurable de l'eau nuageuse.
- La pluie et la neige ne révèlent pas la grille climatique.
- Les cartes de vapeur, nuage et précipitation sont observables.
- Le cycle reste stable pendant le test long avant ajout du vent.
