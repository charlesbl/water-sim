# Étape 06 — Sol et végétation réactive

## But

Ajouter une couche écologique lente qui réagit au climat et à l'hydrologie,
mais ne modifie pas encore l'atmosphère. Elle doit faire émerger des berges
végétalisées, des zones stériles froides ou volcaniques, des sécheresses et une
recolonisation progressive.

## Dépendances

- Température, précipitations et eau de surface disponibles.
- Grille climatique stable.
- Ordonnanceur multi-cadence de l'étape 01.

## État écologique

Créer à la résolution écologique :

```wgsl
struct EcologyCell {
    soil_moisture: f32,
    biomass: f32,
    fertility: f32,
    litter: f32,
}
```

Utiliser deux buffers ping-pong. Les quatre composantes sont normalisées et
bornées, sauf si une unité physique plus précise est définie avant le code.

## Résumé du terrain vers l'écologie

Chaque cellule écologique rassemble son bloc fin :

- roche et sable moyens ;
- pente maximale ou moyenne ;
- eau liquide et eau solide ;
- durée ou fraction d'inondation ;
- température de surface ;
- présence de lave ;
- précipitation et climat interpolés.

Pour éviter un buffer supplémentaire, certaines valeurs peuvent être
recalculées dans le shader écologique si le profil GPU le permet. Favoriser la
lisibilité avant l'optimisation.

## Humidité du sol

Évolution :

- infiltration depuis pluie et eau de surface peu profonde ;
- drainage lent ;
- évaporation du sol selon température et déficit de saturation ;
- prélèvement par la végétation ;
- ruissellement si la capacité du sol est dépassée ;
- gel du sol représenté par une réduction d'infiltration, sans ajouter encore
  un réservoir de pergélisol.

Le type de substrat influence capacité et drainage :

- roche : faible capacité ;
- sable : infiltration rapide et rétention faible ;
- mélange ou sédiment : meilleure rétention.

Dans cette étape, l'eau infiltrée peut être soit :

1. calculée comme budget par la passe écologique et ajoutée à
   `soil_moisture` ;
2. retirée immédiatement de la grille fine par une passe d'échange qui répartit
   le budget selon les potentiels d'infiltration normalisés du bloc.

Tant que les deux côtés de cet échange ne sont pas implémentés, l'infiltration
reste désactivée. Ne jamais créer une humidité du sol gratuite, même derrière
un preset final.

## Croissance

Calculer des facteurs continus entre 0 et 1 :

- `temperatureSuitability`;
- `moistureSuitability`;
- `fertilitySuitability`;
- `floodSuitability`;
- `slopeSuitability`;
- `lightSuitability`.

Croissance indicative :

`growth = rate * biomass * (1 - biomass / capacity) * product(suitabilities)`

Pour permettre la colonisation d'un sol vide :

- banque de graines implicite faible et seedée ;
- dispersion depuis les huit voisins ;
- aucune apparition sur lave active, eau profonde ou roche sans fertilité.

## Mortalité

Accumuler des taux séparés :

- sécheresse ;
- chaleur ;
- gel prolongé ;
- submersion ;
- lave ;
- érosion ou pente trop forte ;
- sénescence de fond.

Une part de la biomasse morte devient `litter`, puis fertilité. La lave remet
biomasse, litière et éventuellement fertilité à zéro selon son intensité.

## Échelles de temps

- La végétation ne doit pas évoluer au rythme visuel de l'eau.
- Tous les taux sont exprimés par seconde écologique.
- Un multiplicateur de temps écologique permet les démonstrations, mais ne
  change pas les équilibres.
- Les taux doivent rester stables si `ecologyDt` est divisé par deux.

## Rendu provisoire

- teinte verte continue selon la biomasse ;
- variation brun/ocre pour la litière et la sécheresse ;
- aucune géométrie d'arbre obligatoire ;
- vues de diagnostic pour humidité, fertilité, aptitude et mortalité dominante.

## Fichiers concernés

- nouveau `src/shaders/simEcology.wgsl`
- éventuel `summarizeEcologySurface.wgsl`
- ressources et bind groups écologiques
- `src/config.ts`
- `src/shaders/render.wgsl`
- ordonnanceur
- validateur écologique

## Checklist d'implémentation

- [ ] Créer grille, buffers, reset et cadence écologiques.
- [ ] Résumer eau, sol, pente, lave et climat vers chaque cellule écologique.
- [ ] Implémenter humidité, capacité, drainage et évaporation du sol.
- [ ] Implémenter et normaliser l'échange conservatif d'infiltration.
- [ ] Ajouter aptitude, croissance logistique et dispersion seedée.
- [ ] Ajouter mortalités séparées et diagnostic de cause dominante.
- [ ] Ajouter litière et évolution lente de fertilité.
- [ ] Ajouter rendu provisoire et vues écologiques.
- [ ] Valider équilibres, perturbations et indépendance au pas de temps.

## Scénarios de test

1. Bande humide sur terrain tempéré : croissance centrée sur la bande.
2. Gradient thermique : biomasse maximale dans une plage intermédiaire.
3. Sécheresse prolongée : décroissance puis mortalité.
4. Crue temporaire : survie courte, mortalité après submersion prolongée.
5. Coulée de lave : destruction locale puis recolonisation lente après
   refroidissement.
6. Sol nu fertile voisin d'une zone verte : front de colonisation.
7. Même scénario avec deux `ecologyDt` : résultats proches à temps égal.

## Critères d'acceptation

- La végétation réagit à l'eau, à la température, au sol et aux perturbations.
- La biomasse ne naît pas sur une cellule manifestement inhabitable.
- L'infiltration est incluse dans le bilan de masse hydrique.
- Le système possède au moins un équilibre stable autre que tout vert ou tout
  mort.
- L'évolution est déterministe et indépendante du framerate.
