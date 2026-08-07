# Étape 01 — Socle, horloge et contrats GPU

## But

Préparer l'architecture sans encore changer visiblement la physique. Cette
étape retire les constantes temporelles implicites, formalise les résolutions
et cadences, centralise les nouveaux contrats de données et installe les
mesures qui permettront de détecter immédiatement une régression.

## Dépendances

Aucune. Cette étape doit être fusionnable seule et conserver le comportement
actuel bit à bit lorsque le mode environnemental est désactivé.

## Décisions à figer

- Un tick hydraulique utilise un `physicsDt` fixe, initialement `0.016`.
- Le temps simulé n'est plus dérivé de `performance.now()`.
- L'atmosphère utilise par défaut `ceil(gridSize / 8)`.
- L'écologie utilise par défaut `ceil(gridSize / 4)`.
- Pause suspend toutes les horloges. Une édition au pinceau en pause ne fait
  avancer aucun système.
- Reset avec le même seed restaure exactement le même environnement.
- Les valeurs thermiques sont exprimées en degrés Celsius.
- Les quantités d'eau utilisent une hauteur équivalente par unité d'aire.

## Changements d'architecture

### Horloge

Créer un petit ordonnanceur, par exemple `src/simulationClock.ts`, possédant :

- `simulationTime`;
- `physicsAccumulator`;
- `climateAccumulator`;
- `ecologyAccumulator`;
- `physicsDt`, `climateDt`, `ecologyDt`;
- un nombre maximal de sous-étapes par image pour éviter la spirale de retard ;
- une méthode de reset déterministe.

Le rendu peut rester variable, mais les shaders ne doivent jamais utiliser
l'heure murale pour une règle physique. Le temps mural reste autorisé pour les
animations purement visuelles.

### Paramètres

Étendre `Config` avec des groupes nommés conceptuellement :

- `environmentEnabled`;
- `physicsDt`;
- `climateResolutionDivisor`;
- `ecologyResolutionDivisor`;
- `climateStepInterval`;
- `ecologyStepInterval`;
- `environmentSeed`;
- `legacyRainEnabled`.

Ne pas exposer tous ces paramètres dans le HUD : les diviseurs et pas de temps
sont d'abord des options de développement.

### Uniformes

Le tableau de 36 flottants actuel est fragile. Introduire des interfaces
TypeScript qui décrivent les offsets et des fonctions dédiées d'encodage :

- `writePhysicsUniforms`;
- `writeClimateUniforms`;
- `writeEcologyUniforms`;
- `writeRenderUniforms`.

Respecter les règles d'alignement WGSL sur 16 octets et ajouter des assertions
sur la taille des buffers. Éviter un seul bloc uniforme géant partagé par tous
les pipelines.

### Ressources GPU

Ajouter un registre de ressources internes dans `webgpuRenderer.ts` ou extraire
la création vers `src/gpu/environmentResources.ts`. Il doit :

- calculer les dimensions de chaque grille ;
- vérifier `maxStorageBufferBindingSize` et `maxBufferSize` ;
- créer/détruire proprement les ressources lors d'un changement de taille ;
- attribuer un `label` WebGPU à chaque buffer, pipeline et bind group ;
- publier un calcul de mémoire estimée dans les diagnostics.

Aucun buffer climatique permanent n'est requis dans cette étape, mais leurs
descripteurs et fonctions de calcul de taille doivent être testables.

## Instrumentation de référence

Enregistrer pour les grilles 64, 256 et la configuration de production :

- temps médian et p95 de la simulation GPU ;
- temps médian et p95 du rendu ;
- FPS uniquement comme information secondaire ;
- mémoire GPU estimée par type de ressource ;
- nombre de dispatches par image et par seconde simulée.

Étendre le résultat de validation avec :

- seed ;
- dimensions ;
- pas de temps ;
- nombre de ticks ;
- côté ping-pong final.

## Fichiers concernés

- `src/main.ts`
- `src/config.ts`
- `src/webgpuRenderer.ts`
- `src/physicsValidation.ts`
- `src/shaders/simFlux.wgsl`
- nouveaux fichiers d'horloge et, si utile, de description des ressources

## Checklist d'implémentation

- [ ] Capturer les résultats bit à bit et timings de référence.
- [ ] Introduire `SimulationClock` sans changer la cadence effective.
- [ ] Remplacer les `dt` WGSL codés en dur par un uniforme.
- [ ] Séparer temps simulé et temps d'animation visuelle.
- [ ] Ajouter les paramètres de résolution et de cadence avec valeurs legacy.
- [ ] Centraliser l'encodage et les tailles des uniformes.
- [ ] Ajouter labels, contrôles de limites et estimation mémoire GPU.
- [ ] Rendre reset, pause et ping-pong explicitement déterministes.
- [ ] Étendre le validateur puis confirmer l'identité du mode legacy.

## Tests

1. Le validateur physique existant reste bit à bit identique en mode legacy.
2. Deux resets avec le même seed donnent les mêmes buffers après 100 ticks.
3. Le résultat après 100 ticks ne dépend pas du framerate de rendu simulé.
4. Pause pendant plusieurs secondes puis reprise ne produit aucun rattrapage.
5. Une grille non divisible par 8 calcule des dimensions climatiques valides.
6. Une limite GPU insuffisante provoque un message explicite, pas une perte du
   device.

## Critères d'acceptation

- Plus aucun `0.016` influençant la physique n'est codé directement en WGSL.
- `performance.now()` ne pilote aucune règle de simulation.
- Le mode environnemental désactivé conserve le résultat de référence.
- Les timings et la mémoire estimée sont consultables en développement.
- Les conventions d'unités et de reset sont documentées dans le code.

## Hors périmètre

- Aucun calcul thermique.
- Aucun changement de rendu visible.
- Aucun nouveau curseur destiné au joueur.
